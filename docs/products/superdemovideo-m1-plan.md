# Superdemovideo — M1 実装計画 v1.0(ゴールモード実行用)

> **この文書がゴールモードへの仕様書。** 上位文書:
> [要件定義](./superdemovideo-requirements.md) / [技術設計](./superdemovideo-architecture.md)。
> 矛盾があれば本書が優先(M1 スコープに合わせて意図的に絞ってある)。

## 0. ゴール(1 文)

> **`pnpm accept` が通ること。** すなわち:同梱フィクスチャアプリ(Next.js + Playwright テスト)に対して
> 「接続 → 解析 → 候補提示 → フロー生成 → キャプチャ → 動画(16:9 / 9:16)+ インタラクティブデモ生成 → 公開 → 再生成と差分検出」
> の全パイプラインが外部サービスなしで完走し、成果物が自動検証を通過すること。

---

## 1. 確定済みの前提(質問不要)

| 項目 | 決定 | 根拠 |
| --- | --- | --- |
| 置き場所 | **この repo の `product/superdemovideo/`**(自己完結 pnpm workspace) | ユーザー回答 |
| 範囲 | **M1 + 最小 Web UI** | ユーザー回答 |
| 合成エンジン | **ffmpeg(ffmpeg-static)+ sharp で自前合成**。Remotion 不使用 | ユーザー回答 |
| 実行環境 | **ローカル完結・外部サービスゼロ**。実測:Docker デーモン無し / Node 22 / pnpm 10 / Playwright Chromium あり(`/opt/pw-browsers`) | ユーザー回答 + 環境実測 |
| DB | **PGlite**(組み込み Postgres、`@electric-sql/pglite`)+ Drizzle ORM。スキーマは素の Postgres と互換に保つ(将来 `DATABASE_URL` 指定で実 PG に切替可能な Driver 構造) | Docker 無しで完走するため |
| ストレージ | **StorageDriver 抽象**:`fs`(既定、`var/storage/` 配下)/ `s3`(実装だけ用意、未検証で可) | 同上 |
| サンドボックス | **SandboxDriver 抽象**:`local`(既定、子プロセス + 一時ディレクトリ + env 最小化)/ `docker`(インターフェースのみ、M1 では未実装で可) | Docker 無し。隔離要件(SEC-1)は本番デプロイ時に docker/gVisor 実装で満たす。**M1 の local driver は信頼できるリポジトリ専用である旨を README に明記** |
| LLM | Anthropic SDK(`@anthropic-ai/sdk`)。**モデルは `claude-opus-5` 固定**(L2 候補抽出 / L4 フロー生成 / L5 台本とも)。構造化出力(zod + `zodOutputFormat` + `messages.parse`)。ダイジェストブロックに `cache_control: {type:"ephemeral", ttl:"1h"}` | 技術設計 §3(M1 は段別ティアリングせず Opus 一本。原価実測が目的なので単純化) |
| LLM モック | **`SDV_LLM_MODE=mock`** で LLM を決定的スタブに差し替え可能にする。mock は E2E テスト AST から候補・フローを機械生成する(LLM 不使用)。**accept は mock モードで走る**(API キー・コスト・非決定性なしで自己検証するため)。実キーがあれば `SDV_LLM_MODE=live` の手動確認も行う | ゴールモードの自己検証を決定的にする |
| 動画 | M1 は **launch テンプレート 1 種 / 尺は自動(≤60s)/ 16:9(1920×1080)と 9:16(1080×1920)の 2 本 / H.264 MP4**。WebM・15s/3min は out of scope(構造上追加できる形にはする) | 要件 F7 の M1 縮退 |
| Web UI | **Vite + React SPA**。API サーバーが `dist` を静的配信(単一オリジン、CORS 不要)。認証は単一トークン(`SDV_TOKEN` env、UI は localStorage に保持) | 最小構成 |
| GitHub 連携 | M1 は **public repo の tarball 取得(codeload)+ ローカルパス(`file:`)** のみ。GitHub App / webhook / Action は out of scope。再生成はローカルパスの変更 or 手動トリガで検証 | M1 縮退 |

### M1 で作らないもの(明示)

GitHub App・webhook・PR コメント / 課金 / ワークスペース・複数ユーザー / CI モード / macOS・モバイル / Before-After・feature テンプレ / 秘匿情報スキャン(§SEC の実装は E070 の**枠だけ**用意し常に pass)/ デモ編集オーバーレイ(スキーマだけ用意)/ WebM / i18n UI(成果物の字幕は EN/JA 両方出す)。

---

## 2. ディレクトリ構成(この通りに作る)

```
product/superdemovideo/
  package.json                 # private, pnpm workspace ルート
  pnpm-workspace.yaml          # packages/*, apps/*, fixtures/*
  tsconfig.base.json
  .env.example
  docker-compose.yml           # 人間の開発用(Postgres+MinIO)。accept では使わない
  var/                         # 実行時データ(gitignore): storage/, db/, work/
  packages/
    core/        # 型・zod スキーマ・エラーコード・ユーティリティ(依存最小)
    db/          # Drizzle スキーマ + PGlite/PG ドライバ + ジョブキュー
    llm/         # Anthropic クライアント + プロンプト + mock 実装
    pipeline/    # ステージ実装(ingest/detect/build/seed/understand/capture/compose/emit/publish)
    player/      # インタラクティブデモプレイヤー(独立ビルド、<50KB gzip 目標)
    api/         # Fastify サーバー + SSE + ワーカー起動
    cli/         # `sdv` コマンド
  apps/
    web/         # Vite + React SPA
  fixtures/
    demo-app/    # ゴールデンフィクスチャ(Next.js + Playwright)
  templates/
    launch/      # skeleton.json, theme.json, prompts/*.md
  scripts/
    accept.ts    # 受け入れスクリプト(§10)
    doctor.ts    # 環境チェック
```

リポジトリルートへの変更は **README.md への 1 行追記と `.gitignore` への `product/superdemovideo/var/` 等の追加のみ**。`docs/` `site/` `tools/` には触れない。

---

## 3. packages/core — スキーマが全ての契約

### 3.1 Flow DSL(zod で定義、これが唯一のフロー表現)

```ts
// 生成物は JSON(flow.json)。TS ラッパーは作らない(M1 簡略化)
type Target = {
  // 解決優先順。複数指定時は上から試す
  role?: { role: string; name: string };   // getByRole(role, {name})
  label?: string;                          // getByLabel
  text?: string;                           // getByText (exact:false)
  testId?: string;                         // getByTestId
  css?: string;                            // locator() — 最終手段
};
type Step =
  | { do: "goto"; path: string }                                  // BASE_URL 相対のみ許可
  | { do: "click"; target: Target; caption?: Caption }
  | { do: "fill"; target: Target; value: string; caption?: Caption }
  | { do: "select"; target: Target; value: string; caption?: Caption }
  | { do: "press"; key: string }
  | { do: "hover"; target: Target }
  | { do: "expect"; target: Target }                              // 表示確認(スクショ契機)
  | { do: "wait"; ms: number };                                   // 上限 5000、連続不可
type Flow = { schemaVersion: 1; useCaseId: string; title: LocalizedText; steps: Step[] }; // steps ≤ 30
type Caption = { en: string; ja: string };
```

- 実行器は **この JSON を解釈するだけ**。`eval` / 動的 import / 任意コード実行は絶対にしない
- バリデーション違反は SDV-E050 系で落とす(黙って無視しない)

### 3.2 Capture Bundle(manifest 抜粋)

```jsonc
// bundle/manifest.json
{
  "schemaVersion": 1,
  "runId": "...", "flowId": "...", "fidelity": "L2",
  "viewports": [{ "name": "desktop", "width": 1440, "height": 900, "dpr": 2 }],
  "steps": [{
    "index": 0, "do": "click", "captionEn": "...", "captionJa": "...",
    "beforePng": "steps/000/before.png", "afterPng": "steps/000/after.png",
    "domJson": "steps/000/dom.json",              // rrweb-snapshot 形式
    "targetBox": { "x": 812, "y": 340, "w": 96, "h": 36 },  // CSS px(dpr 適用前)
    "clickPoint": { "x": 860, "y": 358 },
    "durationMs": 1240
  }],
  "assets": "assets/manifest.json"                // originalUrl → ローカルパスのマップ
}
```

### 3.3 エラーコード

技術設計 §7 の `SDV-E001..E070` を enum + メッセージテンプレとして実装。全ステージの throw はこのコードに正規化してから DB に記録する。

---

## 4. packages/db

- Drizzle スキーマ(**Postgres dialect**)。接続は `DATABASE_URL` があれば `pg`、なければ PGlite(`var/db/`)。両対応の薄い factory を作る
- テーブル(技術設計 §5 の M1 縮退版):

```
projects      (id, name, source_kind{git|local}, source_url, app_root, repo_profile jsonb, created_at)
runs          (id, project_id, kind{initial|regen}, status{queued|running|awaiting_selection|succeeded|failed},
               git_sha, error_code, cost jsonb, created_at, started_at, finished_at)
run_stages    (id, run_id, stage, status, attempt, error_code, log_path, started_at, finished_at)
use_cases     (id, project_id, run_id, title jsonb, hypothesis jsonb, steps_outline jsonb,
               signals jsonb, status{candidate|selected})
flows         (id, use_case_id, version, flow_json jsonb, created_by_run)
captures      (id, run_id, flow_id, bundle_path, bytes, created_at)
artifacts     (id, capture_id, kind{video_169|video_916|demo}, template_version, files jsonb, script jsonb)
publications  (id, project_id, alias_slug unique, artifact_demo_id, artifact_video_ids jsonb,
               synced_sha, published_at)
jobs          (id, run_id, stage, payload jsonb, status, locked_at, attempts, run_after)
diffs         (id, run_id, base_run_id, report jsonb)       -- 再生成の差分レポート
```

- **キュー**:`jobs` を `FOR UPDATE SKIP LOCKED` でポーリング(1 秒間隔)。ワーカーは API プロセス内で起動(`sdv worker` でも単独起動可)。同時実行 = 2
- `runs.cost` へ **LLM usage(input/output/cache tokens・モデル別)と各ステージ所要秒**を必ず積算(原価実測が M1 の目的の一つ)

---

## 5. fixtures/demo-app — ゴールデンフィクスチャ

自己完結の小さな Next.js(App Router)アプリ **「Taskloop」(チームのタスク管理 SaaS 風)** を作る。パイプラインの被験体であり、accept の対象。

要件:

- ページ:`/login`(ダミー認証)、`/dashboard`(タスク一覧、統計カード)、`/tasks/new`、`/settings/team`(メンバー招待)
- データ:**ビルド時に JSON からロード**(DB 不要)。`data/seed.json` に現実的なタスク 12 件・メンバー 4 名(「Task 1」「test」的な名前は禁止 — F4-3 の思想)
- 認証:`e2e/auth.setup.ts` が storageState を作る Playwright 標準構成(= Seed ステージの検出対象)
- **Playwright テスト 3 本**(= Understand の最強信号):
  1. `invite-team-member.spec.ts` — 招待フロー(これが accept で選ばれる想定)
  2. `create-task.spec.ts`
  3. `filter-tasks.spec.ts`
- `package.json`:`build` / `start`(port 3100)/ `db:seed` は不要。lockfile は workspace のものを利用
- UI はそれなりに見た目を整える(スクショが動画になるため。Tailwind 可)

---

## 6. packages/pipeline — ステージ実装仕様

各ステージは `Stage<I, O>` インターフェース(`run(ctx, input): Promise<O>`、ctx にログ・storage・db)。**ステージ間の受け渡しは全て DB + storage 経由**(メモリ渡ししない — 再実行可能性 PL-1)。

### ingest
- `source_kind=local`:パスを `var/work/{run}/src` に **コピー**(元を汚さない)
- `source_kind=git`:`https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}` を取得・展開(2GB 上限 → E001)
- 出力:`src/` + `git_sha`(git なら ref の sha、local はコンテンツハッシュ)

### detect(決定的のみ。LLM フォールバックは**未実装で可** — E010 で手動設定へ)
- next.config.* / vite.config.* / astro.config.* / package.json を走査 → `RepoProfile`(技術設計 §2② の形)
- Playwright 検出:`playwright.config.*` + `testDir` の spec 数
- 確定できない項目は `null` にして UI の確認画面で上書き可能に

### build + seed(SandboxDriver=local)
- `var/work/{run}/app` で `pnpm|npm|yarn install`(lockfile から判定)→ `build` → `start`
- **env 最小化**:`PATH,HOME,NODE_ENV=production,PORT` + `.env.example` のキーにダミー値(`SDV_DUMMY_...`)。ホストの env は渡さない(SEC-2)
- ポート:RepoProfile の port → 起動後 `GET /` を 200 まで最大 60s ポーリング(失敗 E022)
- seed:M1 は **e2e-fixtures 戦略のみ実装**(Playwright の globalSetup/auth.setup を検出して実行、storageState を capture に引き渡す)。ai-seed は未実装で可(フィクスチャは不要なため)。**空画面検出**(非白ピクセル比率 <2% → E040)は実装する
- タイムアウト:install+build 合計 15 分(E020/E021、ログ全文を `var/work/{run}/logs/` へ)

### understand
- **ダイジェスト構築(決定的)**:ルート一覧(App Router のディレクトリ走査)+ 各 Playwright spec の AST 抽出(`@babel/parser` で `test()` タイトルと `page.getBy*` / `click` / `fill` 呼び出し列)+ README 全文 + package.json
- **live**:ダイジェストを cache_control 付き先頭ブロックにして Opus 5 へ。出力 = `UseCase[]`(3〜7 件、zod 構造化出力)。プロンプトは `templates/launch/prompts/understand.md`
- **mock**:spec 1 本 → UseCase 1 件に機械変換(title=テスト名、steps_outline=抽出した操作列)。ルートのみのフォールバック候補も 1 件生成
- 出力を `use_cases` へ insert → run を `awaiting_selection` にして**一時停止**(UI/CLI が選択すると次のジョブが積まれる)

### flowgen(選択後)
- **live**:ダイジェスト(キャッシュ再利用)+ 選択 UseCase → `Flow` JSON を構造化出力で生成
- **mock**:spec の AST から Step 列へ機械変換(getByRole→role target 等、1:1 マップ)+ caption は `"{動詞} {対象}"` の EN/JA 定型文
- zod バリデーション → `flows` へ version=1 で保存

### capture
- Playwright(`/opt/pw-browsers` の chromium、`PLAYWRIGHT_BROWSERS_PATH` を尊重)で Flow を実行
- 各ステップ:действие前に `before.png`(fullPage=false, dpr=2)→ 実行 → `networkidle` + 250ms → `after.png` + rrweb-snapshot(`rrweb-snapshot` npm の `snapshot()`)+ targetBox/clickPoint 記録
- **アセット収集**:`page.on('response')` で image/font/css を `assets/` に保存し URL→パスのマップを書く(dom.json の書換はせずマップ方式。player 側で解決)
- viewport:desktop(1440×900)のみ **必須**。mobile(390×844)は同一フローの 2 周目として実装(失敗しても run は落とさない)
- セレクタ解決失敗:**リトライ 1 回 → E050**。どの step で何の Target が失敗したかを構造化して記録(regen の差分レポートで使う)
- 完了後 bundle を tar せず**ディレクトリのまま** storage へ(`captures.bundle_path`)

### compose(動画)— ffmpeg + sharp 自前合成
- タイムライン生成:step 列 → セグメント列
  `intro(タイトルカード…ではなく最初の画面 + タイトル字幕 1.5s ← 冒頭 3 秒ルール F7-3)→ 各 step [cursor-move 0.6s / click-ripple 0.3s / hold+caption 1.4s / crossfade 0.4s] → outro(CTA 字幕 2.0s)`
  合計が 60s を超える場合は hold を比例圧縮(下限 0.8s)、それでも超えたら step の均等間引きはせず**警告ログ + そのまま**(M1)
- フレーム生成(30fps):`sharp` で合成。レイヤ = 背景スクショ(16:9 はブラウザフレーム SVG に嵌め込み 1920×1080 / 9:16 は targetBox 中心にズームクロップ 1080×1920)+ カーソル SVG(位置は cubic ease-in-out 補間)+ クリック波紋(半径・透明度アニメ)+ 字幕バー(caption、`templates/launch/theme.json` の色・フォント)
- クロスフェードは前後フレームのアルファブレンドで自前生成(ffmpeg xfade に頼らない — 入力を 1 本の frame 列にするため)
- エンコード:`ffmpeg-static` で `-framerate 30 -i %06d.png -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart`
- 併せて `.srt`(EN/JA)と poster.png を出力
- **フレームは `var/work` に書き、エンコード後に削除**(60s×30fps×2 本 ≈ 3,600 枚のディスク管理)

### emit(インタラクティブデモ)
- `packages/player`:依存ゼロ(rrweb-snapshot の rebuild のみ)の TS → 単一 IIFE にバンドル(esbuild)。**gzip 50KB 超で CI 失敗**
- 生成物:`demo/index.html`(スタンドアロン閲覧)+ `demo.json`(steps、caption、hotspot=targetBox)+ dom/assets への相対参照
- 動作:iframe 内に dom.json を rebuild → hotspot をオーバーレイ → クリックで次 step へ。キーボード(←→)対応。最終 step に CTA ボタン(URL は project 設定、既定は `#`)
- アセット解決:rebuild 後に `img[src]` / CSS url() をマップで書換

### publish
- `publications.alias_slug`(nanoid 8 桁)を発行し、storage 上の `published/{slug}/` へ artifact をコピー
- API がこのパスを静的配信:`GET /d/{slug}`(デモ)/ `GET /d/{slug}/video-169.mp4` 等
- **差し替え**:再 publish は同 slug のディレクトリをアトミックに入れ替え(tmp に書いて rename)
- バッジ:`GET /badge/{slug}.svg` — `publications.synced_sha == projects の最新 run の git_sha` なら緑「demo ● synced」、違えば黄「demo ● stale」

### regen(再生成)+ diff
- トリガ:CLI `sdv regen <project>` / API POST。ingest から再実行するが **understand/flowgen をスキップ**し保存済み flow を再利用
- セレクタ失敗 step があれば:live なら L6 相当の修復コール(失敗 step 周辺の dom.json 断片のみ渡す)、mock なら**失敗のまま記録**(修復はしない)
- diff レポート:step ごとに `pixelmatch` で before/after スクショ比較 → `{stepIndex, diffRatio, changed: ratio>0.02}` の配列 + 全体サマリを `diffs` へ。UI に一覧表示
- publish は**手動承認**(自動公開なし — F9-3)

---

## 7. packages/llm

- `LlmClient` インターフェース:`extractUseCases(digest)` / `generateFlow(digest, useCase)` / `writeScript(flow)`(台本 = caption 群の磨き込み。mock は flowgen の定型文をそのまま使う)
- live 実装:`@anthropic-ai/sdk`、`model: "claude-opus-5"`、`messages.parse` + `zodOutputFormat`。ダイジェストブロックに `cache_control: {type: "ephemeral", ttl: "1h"}`。usage を毎回 `runs.cost` に積算
- **リトライ**:SDK 既定(max_retries=2)+ zod 不一致時は 1 回だけ再要求(エラーメッセージを添えて)
- プロンプトは `templates/launch/prompts/*.md` から読む(ハードコードしない — テンプレ repo 思想 T-1 の M1 版)

---

## 8. packages/api + cli

### API(Fastify、port 3000)

```
POST /v1/projects              { name, source: {kind, url|path}, appRoot? }
GET  /v1/projects/:id          (repo_profile 含む) / PATCH(profile 上書き)
POST /v1/projects/:id/runs     { kind: "initial"|"regen" }
GET  /v1/runs/:id              状態 + stages + cost
GET  /v1/runs/:id/events       SSE: {stage, status, message, progress} を逐次
GET  /v1/runs/:id/use-cases    / POST /v1/use-cases/:id/select   → flowgen ジョブ投入
GET  /v1/artifacts/:id/files/* 成果物配信(プレビュー用)
POST /v1/publications          { runId } → {slug, urls}
GET  /d/:slug                  公開デモ(無認証) / GET /badge/:slug.svg(無認証)
```

- 認証:上記のうち `/d/` と `/badge/` 以外は `Authorization: Bearer ${SDV_TOKEN}`(env、未設定なら dev として認証スキップ)
- ワーカー:同プロセスで起動(`--no-worker` で分離可)

### CLI(`sdv`)

```
sdv doctor                         # node/pnpm/chromium/ffmpeg/PGlite 書込を検査
sdv init <path|url> [--name]       # project 作成 + initial run 投入
sdv status <run>                   # ステージ進捗(--follow で SSE 追随)
sdv select <run> <useCaseIndex>    # 候補選択
sdv regen <project>
sdv publish <run>
sdv open <slug>                    # 公開 URL 表示
```

---

## 9. apps/web(最小 UI)

ページは 4 つ。デザインは素朴でよい(Tailwind、ダーク基調)。

1. **Projects** — 一覧 + 新規(URL/パス入力)。
2. **Project 詳細** — RepoProfile 表示・上書きフォーム(F2-4)/ Run 履歴 / 「Run」「Regen」ボタン / バッジ URL 表示
3. **Run 詳細** — ステージ進捗(SSE 購読、失敗時はエラーコード + 要約 + 生ログリンク)/ `awaiting_selection` 時は**候補カード(タイトル・仮説・ステップ概要)から選択**(J1 ④⑤)/ 完了後は動画プレビュー(`<video>`)+ デモ preview(iframe)+ Publish ボタン / regen 時は diff テーブル
4. **公開ページ**(`/d/:slug`、API 配信)— デモ + 動画 DL リンク + 「Made with Superdemovideo」フッター(GROW-1)

---

## 10. 受け入れ(`pnpm accept` = scripts/accept.ts)

**mock モード・外部ネットワーク不要・単一コマンド**で以下を順に実行し、全 assert が通れば exit 0:

```
 1. doctor が全項目 OK
 2. API 起動(テスト用 var ディレクトリ)
 3. project 作成(fixtures/demo-app を local source で)
 4. initial run → awaiting_selection まで到達(≤ 8 分)
 5. use_cases が 3 件以上、うち 1 件は invite-team-member 由来(E2E 信号 — 受入基準#2)
 6. invite を select → run 完走(≤ 12 分)
 7. assert: video-169.mp4 と video-916.mp4 が存在
      ffprobe: h264 / 1920x1080 / 1080x1920 / duration 15〜70s / 30fps
 8. assert: demo/index.html + demo.json が存在、steps 数 == flow steps 数
      player.js の gzip サイズ < 50KB
      (headless chromium で demo を開き、最終 step まで click 遷移できる)
 9. assert: srt(en/ja)と poster.png が存在
10. publish → GET /d/{slug} が 200、badge.svg が「synced」
11. fixtures のボタン文言を 1 箇所変更(fs 書換)→ regen 実行
      → diff レポートに changed step が 1 件以上 / flow 再利用(flows が増えていない)
      → badge が「stale」→ 再 publish で「synced」
12. runs.cost に stage 所要秒が全ステージ分入っている(mock なので LLM 費用は 0 でよい)
13. 後片付け(プロセス停止、テスト var 削除)
```

加えて **unit テスト(vitest)**:core スキーマ / detect / digest 構築 / mock 変換 / タイムライン生成 / キュー(SKIP LOCKED の並行取得)。`pnpm test` で全通過。

---

## 11. 実装順序(ゴールモード内の作業計画)

依存順。**各フェーズ完了時にそのフェーズのテストを通してから次へ**(最後にまとめてデバッグしない)。

```
P0 scaffold + doctor + CI 用スクリプト整備(pnpm -r build が通る空パッケージ群)
P1 core(スキーマ + エラーコード)               → unit
P2 db(スキーマ + PGlite/PG factory + キュー)    → unit(キュー並行テスト含む)
P3 fixtures/demo-app                              → fixture 単体で build/start/Playwright テストが通る
P4 ingest + detect                                → fixture に対し RepoProfile が正しい
P5 build + seed(sandbox local driver)            → fixture が起動し 200、storageState 取得
P6 understand(digest + mock)+ llm パッケージ骨格 → mock で候補 3 件
P7 flowgen(mock)+ capture                       → bundle が manifest 通りに出る
P8 compose + emit video                           → mp4 2 本、ffprobe 検証
P9 player + emit demo                             → headless で E2E 遷移
P10 publish + badge + regen + diff
P11 api + cli(ここまでの機能を配線)
P12 web UI
P13 accept.ts 完成 → 全体通し → 落ちた箇所を修正
P14 live LLM 実装(プロンプト 3 本を書き、ANTHROPIC_API_KEY があれば手動 1 回実行して
    cost 記録を確認。キーが無ければ実装 + unit(モック応答の parse)まで)
P15 README(セットアップ・コマンド・既知の制約)+ .env.example + 本計画書との差分を末尾に記録
```

## 12. ゴールモードへの制約・注意

- **依存追加は自由**(pnpm)。ただしネイティブビルドが要るもの(canvas 等)は避け、sharp / esbuild / ffmpeg-static / pglite / playwright-core など prebuilt 提供のものを使う
- Playwright は **新規ダウンロードしない**(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`、`playwright-core` + `executablePath` fallback)
- 長い処理(install/build/エンコード)は**タイムアウトとログを必ず付ける**。無限待ちを作らない
- `var/` 配下以外に実行時ファイルを書かない。repo ルートの `docs/ site/ tools/` に触れない
- コミットは意味単位(フェーズごとに 1〜2 個)。ブランチは現行の作業ブランチのまま
- 詰まったら:仕様の矛盾は本書 §1 の優先順で自己解決してよい。**解決した仮定は P15 の「差分記録」に必ず残す**
- 完了条件は §0。`pnpm accept` のログを最終報告に含めること

---

## 13. ゴールモード起動用プロンプト(コピペ用)

```
/goal docs/products/superdemovideo-m1-plan.md の実装計画を完遂する。
作業場所は product/superdemovideo/(新規作成)。
完了条件は同計画 §0:`pnpm accept` が mock モードで全項目通過すること。
実装順序は §11、制約は §12 に従う。ANTHROPIC_API_KEY が env に無ければ
P14 は実装+unit テストまでで良い。最終報告に accept の実行ログを含めること。
```

---

## 14. 差分記録(実装で計画から外れたところ)

計画は地図であって領土ではない。実装中に**本書と違う判断をした箇所**を、
理由つきで全部ここに残す。次にこの計画を書く人が同じ穴を踏まないためのもの。

### 構成・依存

| 本書の記述 | 実際 | 理由 |
| --- | --- | --- |
| `fixtures/demo-app` は Next.js | **Vite + React** | Next.js は native SWC のダウンロードと数分のビルドを毎回要求する。フィクスチャの目的は「実在するアプリ」であって「特定フレームワーク」ではないので、起動が速いほうを採った。detect の Next.js 経路は本物の Next.js リポジトリで別途検証が要る(未消化の負債)。 |
| `packages/db` は Drizzle | **生 SQL + 薄い `Db` インターフェース** | 二ドライバ(PGlite / pg)を同じ SQL で喋らせるのが目的で、そこに ORM を挟むと「どちらの方言か」を ORM が決めてしまう。マイグレーションも 1 ファイルで足りる規模だった。 |
| `fixtures/*` を pnpm workspace に含める | **workspace から除外** | workspace に入れると依存が hoist され、ingest→install の経路が「実際の顧客リポジトリ」と違う挙動になる。フィクスチャは外部リポジトリとして扱うほうが検証として正しい。 |
| `docker-compose.yml` を置く | **置いていない** | この環境に Docker デーモンが無く、動かせないものを置くと「あるのに使えない」状態になる。PGlite + fs storage で完結している。 |

### パイプライン

| 本書の記述 | 実際 | 理由 |
| --- | --- | --- |
| run は build と understand を並行 | **analyse(ingest/detect/understand)と produce に 2 分割** | 候補選択という**人間の待ち**を挟むため。プレビューサーバを人間の返事を待つ間ずっと生かしておくと、返事が来なかった分だけプロセスが漏れる。 |
| ─ | **`retargetSession()` を追加** | 録画済み `storageState` はポート 3100 前提で保存されるが、実行時のポートは毎回違う。そのままだとアプリが /login に飛ばして全キャプチャが空になる。origin と cookie domain を実行時 URL に貼り替える。 |
| ─ | **install だけ `NODE_ENV=development`** | サンドボックスの既定 `NODE_ENV=production` が devDependencies を落とし、ビルドツール本体(vite 等)が入らない。build と start は production のまま。 |
| ─ | **依存キャッシュキーに世代プレフィクス `v2-`** | 上の修正の前に作られた不完全な node_modules が、修正後も復元されてしまうため。 |
| E051 の修復(repair)| **live のみ。mock は壊れたまま記録** | 本書 §6 の通り。mock で「直った」ことにすると diff が嘘になる。 |

### 動画テンプレート(外部リサーチ反映)

`docs/products/superdemovideo-video-craft.md` に全量。要点だけ:

| 本書の記述 | 実際 | 理由 |
| --- | --- | --- |
| formats は 16:9 と 9:16 の 2 本 | **1:1(1080×1080)を追加して 3 本** | モバイルタイムラインで正方形が強いという実測報告。要件定義 F7-2 は元々 3 アスペクトを求めており、これはスコープ拡大ではなく**要件への接近**。1 キャプチャからの追加コストはレンダリング時間だけ。 |
| 字幕位置はテーマ共通 | **フォーマットごとの `safeBottomRatio`** | 縦動画は下端をプラットフォーム UI が覆う。共通値だと 9:16 で字幕が隠れる。 |
| 尺は「target 60s / max 70s」だけ | **`minDurationMs: 22000` と `maxHoldMs` を追加** | 5 ステップのフローが 14.9 秒になり、字幕 1 枚あたり 1.4 秒。無音動画で字幕が唯一のナレーションである以上、読み切れない尺は成立しない。hold を伸ばして下限に合わせる。 |
| ─ | **`hookMs: 1700` を明示** | intro 1.6 秒という値に根拠がなかった。視聴継続の判断が約 1.7 秒で下りるという報告に合わせ、intro はその内側で終わる、と数値で書いた。 |

### API / CLI / UI

| 本書の記述 | 実際 | 理由 |
| --- | --- | --- |
| apps/web は Tailwind | **素の CSS 1 枚** | ページ 4 枚に対してビルド設定を 1 段増やす価値がなかった。見た目の要求は「素朴でよい」。 |
| 認証は Bearer のみ | **`/events` と `/v1/artifacts/` の GET に限りクエリ `?token=` も許可** | EventSource / `<video src>` / `<iframe>` はヘッダを付けられない。状態を変えるルートでは受け付けない(URL のトークンは履歴とログに残るため)。 |
| ジョブは一律 3 回リトライ | **`isRetryable(code)` で決定的な失敗は即 dead** | ビルドが構文エラーで落ちたものは 3 回やっても同じで、待たせるだけ。E001/E022/E060/E900 のみ再試行。 |

### 受け入れ

| 本書の記述 | 実際 | 理由 |
| --- | --- | --- |
| ffprobe で検証 | **`ffprobe-static` を追加**(`ffmpeg-static` は ffmpeg しか同梱しない) | |
| デモを headless で開く | **`file://` ではなく API 経由の HTTP で開く** | プレイヤーは `demo.json` を fetch する。`file://` にはオリジンが無く fetch が落ちる。実際に訪問者が見る経路で検査するほうが正しくもある。 |
| 動画は 2 本を検査 | **3 本(16:9 / 9:16 / 1:1)を検査** | フォーマット追加に合わせた。 |
| フィクスチャは「ボタン文言」を変更 | **セレクタ対象でない可視コピーを変更** | ボタン名を変えるとその step が壊れ、`pixelDiff` が一度も走らないまま「changed ≧ 1」が通ってしまう。壊れる経路の検証は別テストの仕事。 |
| diff 閾値 `ratio > 0.02` / 比較解像度 480×300 | **`> 0.0005` / 960×600** | 実測:1 行のコピー書き換えは 960×600 で約 0.2%、480×300 では検出不能。0.02 では「コピーが変わったのに changed 0 件」になる ─ **デモが古い文言を主張し続けるのを見逃す**という、このプロダクトが存在する理由そのものの失敗。決定的シードなので同一描画は実測 0%、閾値は「小さい変化を無視する」ためではなく「キャレット等の偶発差分を無視する」ためだけに存在する。`packages/pipeline/test/diff.test.ts` が実画像でこの根拠を固定している。 |

### まだ返していない負債

- detect の Next.js 経路が実リポジトリで未検証(上記フィクスチャ変更の裏返し)
- 15 秒 / 6 秒の短尺カットは未生成(craft ドキュメント §2)
- `hookMs` 時点フレームの非背景率チェックが未実装(H に昇格させたい検査)
- S3 storage ドライバと docker sandbox ドライバは throw する未実装のまま(M1 の想定どおり)

---

## 更新履歴

| 日付 | 版 | 変更 |
| --- | --- | --- |
| 2026-07-28 | v1.0 | 初版。環境実測(Docker デーモン無し・Chromium あり・Node22/pnpm10)反映済み |
| 2026-07-28 | v1.1 | §14 差分記録を追加(実装完了時点)。外部リサーチのテンプレート反映を含む |
