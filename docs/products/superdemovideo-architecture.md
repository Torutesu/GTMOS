# Superdemovideo — 技術設計 & 原価シミュレーション v1.0

> [`superdemovideo-requirements.md`](./superdemovideo-requirements.md)(何を作るか)の下位文書。
> **本書は「どう作るか」と「1 Run いくらかかるか」。** 価格・プラン設計はスコープ外(後回し決定済み)。

---

## 1. システム構成(全体)

```
                    ┌────────────────────────────────────────────┐
                    │  Control Plane                             │
  GitHub App ──────▶│  API (Next.js/Node) + Postgres             │◀── Web UI
  webhooks          │  ・Run 状態機械  ・課金計測  ・公開ポインタ    │
                    └───────────────┬────────────────────────────┘
                                    │ ジョブ投入(ステージ単位)
                    ┌───────────────▼────────────────────────────┐
                    │  Queue(Postgres SKIP LOCKED → 必要時 SQS)  │
                    └───┬─────────────┬─────────────┬────────────┘
                        ▼             ▼             ▼
                 Build/Seed      Capture         Compose/Emit
                 Worker Pool     Worker Pool     Worker Pool
                 (sandbox)       (Playwright)    (Remotion/ffmpeg)
                        │             │             │
                        └─────────────┴─────────────┘
                                      ▼
                    ┌────────────────────────────────────────────┐
                    │  Object Storage (S3) + CDN                  │
                    │  capture bundle / video / demo player       │
                    └────────────────────────────────────────────┘
```

**設計原則**

- **ステージ = ジョブ = 再実行単位。** 各ステージは冪等(idempotency key = `run_id:stage`)。PL-1〜4 を満たす。
- キューは最初 Postgres(`FOR UPDATE SKIP LOCKED`)。分離が必要になったら SQS へ。最初から分散システムを作らない。
- ワーカーは全てステートレス。状態は Postgres、成果物は S3 のみ。

---

## 2. パイプライン詳細設計

### ① Ingest

| 項目 | 設計 |
| --- | --- |
| 取得 | GitHub App トークンで tarball API(clone より速く、git 履歴不要のケースが大半)。Before/After 用に対象 ref のみ追加取得 |
| 制限 | 展開後 2GB 上限。超過は即エラー(SDV-E001) |
| 保持 | S3 に暗号化保存(ビルドキャッシュ用)。SEC-1 の「保持しない」設定時は Run 終了で削除 |

### ② Detect

**決定的検出を先に、LLM は最後の手段。**

```
1. 決定的:lockfile / framework ファイルのパターンマッチ
   next.config.* → Next.js、vite.config.* → Vite、astro.config.* → Astro …
   packageManager フィールド / lockfile 種別 → pnpm/yarn/npm、engines → Node ver
2. スクリプト推定:package.json の build / start / dev を候補化
3. LLM フォールバック(判定不能時のみ):リポジトリの構成ファイル群 → RepoProfile を構造化出力
```

出力 **`RepoProfile`**(JSON、ユーザー確認画面 F2-4 の実体):

```jsonc
{
  "framework": "nextjs", "packageManager": "pnpm", "nodeVersion": "22",
  "appRoot": "apps/web",                       // monorepo 対応 (F1-6)
  "build": {"install": "pnpm i --frozen-lockfile", "build": "pnpm build", "start": "pnpm start", "port": 3000},
  "e2e": {"kind": "playwright", "configPath": "playwright.config.ts", "testCount": 24},
  "env": [{"key": "DATABASE_URL", "source": ".env.example", "strategy": "sqlite-shim"}],
  "confidence": 0.92
}
```

### ③ Build(sandbox)

| 項目 | 設計 |
| --- | --- |
| 隔離 | gVisor(runsc)コンテナ。v1 は ECS/Fargate + 制限プロファイルでも可、専用ホスト移行時に gVisor |
| ネットワーク | **egress は forward proxy 経由の許可リスト方式**(npm/pnpm/yarn registry、GitHub、必要 CDN のみ)。それ以外は遮断(F3-1) |
| キャッシュ | 依存キャッシュを lockfile ハッシュでキー付けし S3 に保存 → 再生成ビルドを大幅短縮(F3-2) |
| 資源 | 4 vCPU / 8GB / 20GB disk / タイムアウト 15 分(F3-4) |
| 失敗時 | 生ログ全文 S3 + **エラー分類器**(下記 §7)でユーザー向け要約を生成 |

### ④ Seed(状態注入)

ストラテジ解決の優先順(F4):

```
1. e2e-fixtures   Playwright/Cypress の globalSetup・fixtures・seed script を検出して実行
2. seed-script    package.json に db:seed / seed 系スクリプトがあれば実行
3. ai-seed        Prisma/Drizzle/SQL スキーマ → LLM がプロダクト文脈のシードデータ生成(構造化出力)
4. har-mock       記録済み HAR をプロキシで差し込み [S]
5. manual         ユーザー指定の値で上書き [S]
```

- 認証:E2E の storageState / auth setup を再利用 → 無ければ cookie/localStorage 注入テンプレ(F4-2)
- 出力:「この状態で撮ります」プレビュー用に全ルートのスクリーンショット 1 巡(F4-6)。これは ⑤⑥ の入力にもなる

### ⑤ Understand(ユースケース抽出)— **③ と並列実行**

ソースだけで動く(ビルド不要)ため、**Build と同時に走らせて TTFD を短縮する**。

```
静的解析(決定的):
  ルート抽出   Next.js: app/pages ディレクトリ / React Router: createBrowserRouter / …
  E2E パース   テスト名・ステップ・セレクタを AST で抽出(@playwright/test の parser)
  信号収集     analytics イベント定義、README、CHANGELOG、feature flags
        ↓ まとめて「リポジトリダイジェスト」を構成(→ §5 プロンプトキャッシュの単位)
LLM(1 コール):
  入力: ダイジェスト + 抽出プロンプト(テンプレ repo 管理)
  出力: UseCase[](構造化出力。title / value_hypothesis / steps / signal_sources / entry_route)
```

### ⑥ Drive & Capture(二重キャプチャ)— 製品の核

**フロー表現:** 生成される Playwright スクリプトは**制約付き DSL を埋め込んだ TS**(任意コードではなくステップ配列 → 実行器が解釈)。人が読める・差分が取れる・**任意コード実行を防げる**の 3 点を両立する。

```ts
// flow.sdv.ts — 生成物の形
export default defineFlow({
  useCase: "invite-team-member",
  steps: [
    { do: "goto", url: "/settings/team" },
    { do: "click", target: { role: "button", name: "Invite" }, caption: { en: "...", ja: "..." } },
    { do: "fill", target: { label: "Email" }, value: "{{seed.invitee_email}}" },
    { do: "expect", target: { text: "Invitation sent" } },
  ],
});
```

- セレクタは **role/label/text 優先**(Testing Library 流)。CSS セレクタは最終手段 → UI 変更耐性 = 再生成成功率に直結
- 各ステップで `waitForLoadState('networkidle')` + アニメーション完了待ち(F6-5)

**キャプチャ内容(SDV Capture Bundle):**

```
bundle/
  manifest.json        schema_version, run, repo ref, fidelity(L2等), viewport[], template ver
  steps/000..N/
    dom.json           サニタイズ済み DOM スナップショット(rrweb-snapshot 形式)
    box.json           対象要素の bounding box、スクロール位置
    events.json        カーソル軌跡の元データ(click 座標, input, timing)
    before.png after.png
  video/
    desktop.webm       CDP screencast 由来のフレーム列(1440×900 @2x)
    mobile.webm        390×844
  assets/              DOM が参照する画像/フォント/CSS のローカルコピー(URL 書換済み)
```

- **ピクセル**は CDP screencast(可変 fps、後段で 24fps に正規化)。**構造**は rrweb-snapshot + アセット取り込みで自己完結化 — Storylane/Navattic と同方式だが、人ではなく実行器が取る
- **サニタイズは capture 時に実施**:`data-sdv-mask` 指定要素 + 自動秘匿スキャン(§8)
- macOS(v1.5)では dom.json の代わりに **AXUIElement ツリー + 要素フレーム**。バンドル形式は同一 schema の別 kind

### ⑦ Compose(動画合成)

**Remotion を採用**(React ベースの動画レンダラ)。理由:

1. テンプレート = React コンポーネント = **テンプレ repo(T-1〜5)を通常のコードとして管理できる**
2. カーソルレイヤ・字幕・デバイスフレームを宣言的に合成できる
3. 尺 × アスペクトのマトリクス書き出しが props 差し替えで済む

```
入力: capture bundle + skeleton(launch.yml 等) + brand kit + 台本(LLM 生成、編集可)
処理: events.json → カーソル軌跡をイージング付きで再合成(生のマウス移動は使わない。F6-3)
      ステップ尺の自動配分(skeleton の尺予算に合わせ、待ち時間を圧縮)
出力: 3 尺 × 3 アスペクト × (H.264 + WebM) = 最大 18 ファイル + poster + srt
```

レンダは CPU ワーカー(Remotion render → ffmpeg encode)。GPU 不要。

### ⑧ Emit(インタラクティブデモ)

- **プレイヤー**:自己完結の JS(目標 <50KB gzip、PERF-5)。dom.json を iframe 内に復元し、box.json からホットスポット、caption から吹き出しを描画
- 配信物:`player.js + demo.json(manifest) + steps/ + assets/` を CDN へ。iframe 埋め込みと script 埋め込みの両対応(F8-2)
- 編集(F8-3〜5)は demo.json のオーバーレイ(キャプチャは不変、編集は別レイヤ)→ テンプレ再生成しても編集が生きる

### ⑨ Publish(同一 URL 差し替え)

```
artifact(不変・バージョン付き)  s3://…/artifacts/{artifact_id}/
alias(可変ポインタ)            demo_url → artifact_id
```

- 公開 = alias の**アトミックなポインタ更新**(F9-4)。ロールバック = ポインタを戻す(F9-7)
- 鮮度バッジ(F9-5)= `GET /badge/{project}.svg`。alias の同期状態から SVG 生成、`Cache-Control: max-age=300`

### ⑩ Watch(再生成)

```
GitHub webhook (release published / push to default)
  → 再生成 Run 起票(保存済み flow を新ビルドで再実行)
  → セレクタ解決失敗ステップのみ LLM 修復(role/label 優先設計により多くは自然回復)
  → 差分レポート生成(pixelmatch でステップ毎スクショ比較 + 変更ステップ一覧)
  → 承認 UI へ(自動公開はオプトイン)
```

- **GitHub Action は薄いクライアント**(API を叩くだけ)。CI モード(SEC-3)実装時に Build〜Capture をランナー内実行へ拡張
- PR プレビュー(F9-6)は同経路の派生(公開はしない、PR コメントのみ)

---

## 3. LLM 設計(ステージ別)

方針:**品質が出力に直結する段は Opus、機械的な段は下位モデル。** 全て構造化出力(`output_config.format`)で受ける。

| # | ステージ | モデル | 入力(目安) | 出力(目安) | 備考 |
| --- | --- | --- | --- | --- | --- |
| L1 | Detect フォールバック | Haiku 4.5 | 20k | 1k | 発生率 ~20% 想定(大半は決定的検出で済む) |
| L2 | **Understand(候補抽出)** | **Opus 5** | 120k | 4k | リポジトリダイジェスト。品質の本丸 |
| L3 | AI シード生成 | Sonnet 5 | 20k | 3k | スキーマ → データ。E2E fixtures がある場合は不要 |
| L4 | **フロー生成**(flow.sdv.ts) | **Opus 5** | 40k | 3k | ダイジェスト(キャッシュ済)+ 選択ユースケース |
| L5 | 台本・字幕(EN/JA) | Sonnet 5 | 15k | 3k | |
| L6 | セレクタ修復(再生成時のみ) | Sonnet 5 | 25k | 2k | 失敗ステップ周辺の DOM のみ渡す |
| L7 | ビルドエラー要約 | Haiku 4.5 | 30k | 1k | ログ→原因+修正候補(J3) |

**コスト最適化の仕掛け(実装要件)**

- **プロンプトキャッシュ**:リポジトリダイジェスト(~100k tokens)を `cache_control {ttl: "1h"}` で先頭ブロック化。L2 が書き、L4/L5 が読む(読み 0.1×)。**1 Run 内で同一ダイジェストを 3 回素で送らない**
- **Batch API**:再生成 Run は非対話なので **Batches(50% off)で流す**。初回 Run(ユーザーが待っている)のみ同期
- 台本・字幕・修復は将来 Batch へ寄せる余地あり

---

## 4. 原価シミュレーション(1 Run)

> **前提はすべて仮置き。** COST-1 の通り M1 で実測し、この表を実測値で置き換える。
> 単価:Opus 5 $5/$25、Sonnet 5 $3/$15、Haiku 4.5 $1/$5(per MTok)。キャッシュ読み 0.1×・書き 1.25×。Batch 50% off。
> コンピュート:Fargate 換算 vCPU $0.04048/h + GB $0.004445/h(4vCPU/8GB ≈ **$0.198/h**)。

### 4.1 リポジトリ規模の 3 シナリオ

| | S(静的/小 SPA) | **M(典型:Next.js + Playwright)** | L(monorepo/重ビルド) |
| --- | --- | --- | --- |
| ビルド時間 | 2 分 | 6 分 | 15 分 |
| ダイジェスト | 40k tok | 120k tok | 250k tok |

### 4.2 初回 Run(接続 → 動画 + デモ 1 本)

**LLM(シナリオ M、キャッシュ込み)**

| コール | 計算 | 額 |
| --- | --- | --- |
| L2 Understand(Opus) | 120k×$5 + キャッシュ書き 120k×$1.25 + 4k×$25 | $0.85 |
| L4 フロー生成(Opus) | キャッシュ読み 120k×$0.5 + 差分 10k×$5 + 3k×$25 | $0.19 |
| L3 シード(Sonnet)※E2E 無し時のみ | 20k×$3 + 3k×$15 | $0.11 |
| L5 台本(Sonnet) | キャッシュ読み分 + 5k×$3 + 3k×$15 | $0.12 |
| L1/L7 (Haiku、期待値) | — | $0.02 |
| **LLM 小計** | | **≈ $1.3** |

**コンピュート(シナリオ M)**

| 工程 | 資源×時間 | 額 |
| --- | --- | --- |
| Build + Seed | 4vCPU/8GB × 8 分 | $0.026 |
| Capture(2 ビューポート) | 2vCPU/4GB × 5 分 | $0.008 |
| Compose/Emit(18 ファイル) | 4vCPU/8GB × 12 分 | $0.040 |
| ストレージ(bundle 0.5GB + 出力 0.3GB、月額) | S3 $0.023/GB | $0.02/月 |
| **コンピュート小計** | | **≈ $0.08** |

**初回 Run 合計(概算)**

| シナリオ | LLM | 計算資源 | **合計** |
| --- | --- | --- | --- |
| S | $0.5 | $0.04 | **≈ $0.6** |
| **M** | $1.3 | $0.08 | **≈ $1.4** |
| L | $2.6 | $0.20 | **≈ $2.8** |

### 4.3 再生成 Run(本命の経路)

Understand 不要・flow 再利用・ビルドキャッシュ有効・**Batch 50%**:

| 項目 | 額(M) |
| --- | --- |
| Build(キャッシュヒット、4 分)+ Capture + Compose | $0.06 |
| L6 修復(発生率 30% 想定、Batch) | $0.04 |
| 差分レポート(pixelmatch は CPU のみ) | $0.005 |
| **再生成 1 回** | **≈ $0.10–0.15** |

### 4.4 月次スケール試算

| 想定 | 計算 | 月額原価 |
| --- | --- | --- |
| Free ユーザー 1 人(public、月 3 Run) | 3 × $0.6(S 寄り) | ≈ $1.8 |
| Pro プロジェクト 1 つ(初回 1 + 再生成 8) | $1.4 + 8×$0.12 | ≈ $2.4 |
| **1,000 プロジェクト(Pro 相当)** | | **≈ $2,400 + 固定費** |
| 固定費(control plane + DB + CDN 最小構成) | | ≈ $300–800 |

**含意(価格設計は後回しだが、成立性の確認として)**:プロジェクト単価の原価が $2〜3/月なら、**二桁ドルの月額に対して原価率は 1 桁 %**。ユニットエコノミクスは余裕をもって成立する。リスクは L シナリオ偏重(重 monorepo ばかり来る)と、Free の乱用 — 後者は月 3 Run 上限(COST-2)で既に抑えてある。

### 4.5 レイテンシ予算(TTFD P50 15 分に対する内訳)

```
Ingest+Detect   1.0 分
Build+Seed      7.0 分 ┐ 並列
Understand      2.0 分 ┘ → クリティカルパスは Build 側
候補選択(人)   (ユーザー時間 — Build 中に選ばせる UI にする)
Capture         3.0 分
Compose(60s 16:9 + 9:16 を先行、残りはバックグラウンド)
                3.0 分
──────────────────────
P50 ≈ 14 分(M) ✅ / L は Build が 15 分なので P90 側(30 分以内)
```

**設計上の 2 つの稼ぎどころ**:①Understand を Build と並列化 ②候補選択をユーザーが待ち時間中に行う UI(J1 の③で仕込み済み)。全フォーマットの完成を待たず、**最初の 1 本(16:9 60s)ができた時点で「公開可能」にする**。

---

## 5. データモデル

```sql
workspaces      (id, name, plan, created_at)
users           (id, gh_user_id, email)  / memberships (workspace_id, user_id, role)
projects        (id, workspace_id, gh_repo, app_root, repo_profile jsonb,
                 brand_kit jsonb, settings jsonb)          -- settings: 保持ポリシー等
runs            (id, project_id, kind{initial|regen|preview}, trigger{manual|release|push|pr},
                 status, git_ref, git_sha, started_at, finished_at,
                 cost jsonb)                                -- {llm_usd, compute_sec, tokens{...}} ← COST-1
run_stages      (run_id, stage, status, attempt, log_url, error_code, started_at, finished_at)
use_cases       (id, project_id, title, hypothesis, steps jsonb, signals jsonb, status{candidate|selected|archived})
flows           (id, use_case_id, version, script_text, created_by_run)   -- flow.sdv.ts、バージョン付き
captures        (id, run_id, flow_id, bundle_url, fidelity, viewports jsonb, bytes)
artifacts       (id, capture_id, kind{video|demo}, template_ref, template_version,
                 files jsonb, script jsonb)                 -- script: 台本+字幕(編集可能の実体)
publications    (id, project_id, alias_slug, artifact_id, visibility, published_at,
                 synced_ref)                                -- 鮮度バッジの根拠
demo_edits      (publication_id, overlay jsonb)             -- 吹き出し編集・マスク(F8 のオーバーレイ)
events          (id, project_id, type, payload jsonb, created_at)  -- 監査 + 分析
```

要点:

- **capture と artifact を分離** — テンプレ変更時は capture 再利用で artifact だけ作り直す(PL-4/T-3)
- **publication = alias** — 同一 URL 差し替えとロールバックはこのテーブルのポインタ操作
- `runs.cost` に LLM 使用量(`usage` フィールドの積算)と sandbox 秒数を毎 Run 記録 → §4 の表を実測で更新する仕組みそのもの

---

## 6. 外部インターフェース

### REST(v1 最小)

```
POST   /v1/projects                     { repo, app_root? }         → 解析開始
GET    /v1/projects/:id                 RepoProfile + 状態
POST   /v1/projects/:id/runs            { use_case_id?, template?, kind }
GET    /v1/runs/:id                     状態 + ステージ進捗
GET    /v1/runs/:id/events              SSE(進捗ストリーム)
POST   /v1/runs/:id/stages/:stage/retry
GET    /v1/projects/:id/use-cases       候補一覧 / PATCH で編集
POST   /v1/publications                 { artifact_id, alias_slug }  → 公開(承認)
POST   /v1/publications/:id/rollback
GET    /badge/:alias.svg                鮮度バッジ(公開・無認証)
GET    /embed/:alias/player.js          埋め込みスクリプト
```

### GitHub Action(v1 = 薄いクライアント)

```yaml
- uses: superdemovideo/regenerate@v1
  with:
    project: prj_xxx
    api-token: ${{ secrets.SDV_TOKEN }}
    mode: cloud          # v1.5 で "ci"(SEC-3)を追加
    auto-publish: false
```

### Webhook(受信)

`release.published`(既定トリガ)/ `push`(main、オプトイン)/ `pull_request`(プレビュー、オプトイン)。
署名検証 + 冪等キー(delivery id)で二重起票防止。

---

## 7. 失敗分類(エラーコード体系)

失敗系は主要 UX(§J3)。**全ステージの失敗はこのコードに正規化**してから UI に出す。

| コード | 意味 | ユーザー向けアクション |
| --- | --- | --- |
| SDV-E001 | リポジトリ超過 / 取得不能 | app_root 指定 / 権限確認 |
| SDV-E010 | フレームワーク判定不能 | 手動設定フォームへ(F2-5) |
| SDV-E020 | 依存インストール失敗 | L7 要約(「pnpm 9 が必要」等)+ 生ログ |
| SDV-E021 | ビルド失敗 | 同上 |
| SDV-E022 | 起動失敗 / ポート検出不能 | start コマンド・port の上書き |
| SDV-E030 | env 不足 | 不足キー一覧 + ダミー値提案(SEC-2 の範囲で) |
| SDV-E040 | シード失敗 / 空画面検出 | シード戦略の選択肢提示(F4) |
| SDV-E050 | セレクタ解決失敗(capture) | 該当ステップの再記述 or 修復提案 |
| SDV-E051 | セレクタ解決失敗(regen) | 差分レビューに「要修復」として表示 |
| SDV-E060 | レンダ失敗 | 自動リトライ 1 回 → 運営アラート(ユーザー起因でない) |
| SDV-E070 | 秘匿情報検出(下記) | 公開ブロック + マスク提案 |

**空画面検出(SDV-E040)**:capture 後に各ステップのスクショを軽量チェック(非白領域比率 + 「No data」「empty」テキスト検出)。空のままのデモを黙って出さない。

---

## 8. セキュリティ実装(要件 SEC の実体)

| 要件 | 実装 |
| --- | --- |
| SEC-1 サンドボックス | gVisor + egress 許可リストプロキシ。Run 終了で FS 破棄。クローン保持は S3 暗号化(SSE-KMS)+ 設定で無効化可 |
| SEC-2 シークレット非受領 | env はダミー値注入のみ。UI に secret 入力欄を**作らない**(フォームレベルで存在しない) |
| **公開前秘匿スキャン** | capture bundle に対して秘匿情報スキャン(API キー形式の regex、メール、JWT)→ 検出時 SDV-E070 で公開ブロック。**シードデータでも UI に実鍵が描画される事故は起きる**(.env 読み込み等)ので必須。要件へ追加提案 → 採用済みとして [M] 扱い |
| SEC-4 アクセス制御 | publication.visibility(public / unlisted / workspace)。unlisted は推測不能 slug |
| SEC-5 削除 | project 削除 → 30 日猶予付きで S3 プレフィックス削除ジョブ |
| Action トークン | プロジェクト単位のスコープ付きトークン(workspace 全権を CI に置かせない) |

---

## 9. テンプレ実行系(templates repo との接続)

```
templates repo(公開)
  skeletons/launch.yml      … ショット構成・尺予算・字幕スロット(宣言的)
  components/               … Remotion コンポーネント(フレーム・カーソル・字幕)
  prompts/*.md              … L2/L4/L5 のプロンプト本文
  formats/matrix.json       … 尺×アスペクトの書き出し定義
```

- パイプラインはテンプレを **git tag で pin** して実行(artifact に `template_version` 記録)
- テンプレ更新 → 影響プロジェクトに「新テンプレで再生成」を提案(capture 再利用なので原価は Compose 分のみ ≈ $0.04)
- **プロンプトもテンプレの一部**としてバージョン管理 → 候補品質の変化を版で追える(候補採用率 KPI と紐づく)

---

## 10. マイルストーンへの割付(M1〜M5 の技術内訳)

| M | 作るもの(本書の節) | 検証すること |
| --- | --- | --- |
| M1 | §2①〜⑦ の一本道(キュー簡易版、テンプレ 1 種、手動トリガ) | **原価実測 → §4 を実測値に置換**、ビルド成功率の初期値 |
| M2 | §2⑤ 完全版 + 候補 UI + RepoProfile 確認画面 + §7 エラー分類 | 候補採用率、TTFD P50 |
| M3 | §2⑧ プレイヤー + §5 publication/demo_edits + CDN | プレイヤー 50KB 以内、編集オーバーレイ |
| M4 | §2⑨⑩ + Action + 差分レビュー + バッジ | 再生成承認率、修復発生率(30% 仮定の検証) |
| M5 | 課金計測(runs.cost)+ Free 制限 + watermark | ユニットエコノミクス最終確認 |

---

## 11. 未決(技術)

| # | 論点 | 現時点の傾き | 決めるタイミング |
| --- | --- | --- | --- |
| 1 | DOM スナップショット形式(rrweb-snapshot vs 自前) | rrweb-snapshot(実績・アセット処理) | M1 |
| 2 | Remotion のライセンス(商用は有償) | 採用前提でコスト織込 or ffmpeg+SVG 自前合成 | M1 着手前 |
| 3 | sandbox 基盤(Fargate+gVisor vs Fly Machines vs 自前 Firecracker) | v1 は Fargate、原価が効いてきたら再評価 | M1 実測後 |
| 4 | フロー DSL の表現力上限(条件分岐・複数タブをいつ許すか) | v1 は直列のみ | M2 |
| 5 | L2 のダイジェスト構築(何を入れて 120k に収めるか)の選定ロジック | ルート+E2E+README 優先、本文コードは要約 | M1 で実験 |
| 6 | 修復発生率 30% 仮定の妥当性 | role/label セレクタでどこまで下がるか | M4 |

---

## 更新履歴

| 日付 | 版 | 変更 |
| --- | --- | --- |
| 2026-07-28 | v1.0 | 初版。**原価は全て試算値 — M1 で実測に置換すること** |
