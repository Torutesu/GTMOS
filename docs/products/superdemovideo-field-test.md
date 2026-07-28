# Superdemovideo — フィールドテスト(自分で書いていないリポジトリ)

`pnpm tsx scripts/field-test.ts [--build] <path|url>...`

## なぜこれが要るか

M1 の受け入れは `fixtures/demo-app`(Taskloop)に対してのみ緑だった。
Taskloop は**こちらが「検出できるように」作った最良ケース**である ──
ルートが綺麗、認証状態がコミット済み、Playwright spec が role セレクタを使う。

「リポジトリを指すだけ」というのがこのプロダクトの唯一の主張なので、
**それを他人のコードで確かめていない状態は、主張していないのと同じ**。
このスクリプトはそのギャップを埋めるためだけに存在する。

## 第 1 回(2026-07-28)

対象 5 本。いずれも実在の OSS で、こちらは 1 行も書いていない。

| repo | 形 | 選んだ理由 |
| --- | --- | --- |
| `shadcn-ui/next-template` | Next.js App Router、単一パッケージ | 最も素直なケース |
| `hakimel/reveal.js` | Vite、ただしライブラリ寄り | フレームワーク判定の境界 |
| `excalidraw/excalidraw` | yarn workspaces モノレポ | 実在の大規模アプリ |
| `withastro/astro-docs` | Astro、pnpm workspace | 別フレームワーク |
| `tastejs/todomvc` | 静的、ビルド無し | ビルドが無いケース |

### 起きたこと

**まず私のスクリプト自身が嘘をついた。** 初版の合格条件が `useCases > 0` で、
「5 of 5 が撮影まで到達」と表示した。実際には**5 本中 0 本**がまともな結果を出していない。
このスクリプトが存在する理由そのものの失敗を、このスクリプトがやった。
合格条件を「候補 2 件以上 **かつ** E2E 信号あり **かつ** confidence ≥ 0.5」に修正した。

**本体の不具合は 4 件。**

| # | 症状 | 根本原因 | 影響 |
| --- | --- | --- | --- |
| 1 | reveal.js / excalidraw のポートが 4173(実際は 5173) | ポートを**フレームワーク既定表**から引いていた。`vite`(dev = 5173)と `vite preview`(= 4173)はフレームワークが同じで別物 | **確実に E022 で死ぬ。** 他が全部正しくても起動しない |
| 2 | excalidraw の appRoot が `""`(実際は `excalidraw-app`) | モノレポ探索が `apps/` `packages/` `sites/` の 3 つを決め打ちしていた。excalidraw のアプリはトップレベルの `excalidraw-app/` | モノレポの解析対象が丸ごと間違う。実在リポジトリの多くはモノレポ |
| 3 | excalidraw の framework が `static`(実際は `vite`) | ①アプリ package.json の依存だけを見ていたが、**workspace ではビルドツールがルートに hoist される**ので `excalidraw-app` の依存は react のみ ②config ファイル判定が `.ts`/`.js` のみで `vite.config.mts` を見落とす | ビルド・起動コマンドが全部間違う |
| 4 | confidence が全リポジトリで 0.95 | 「package.json に build と start があるか」を数えていただけ。**ポートを推測したかどうかが入っていない** | **一番悪い。** 起動不能なプロファイルを 0.95 と申告する = 誰も確認しない |

### 直した内容

- **ポートは「実際に走るコマンド」から決める。** `npm run x` の連鎖を解決したうえで、
  `vite preview`→4173 / `vite`→5173 / `next`→3000 / `astro`→4321 … と**コマンド単位**で引く。
  `--port` フラグも**起動に使われるスクリプトの中だけ**を見る
  (excalidraw には走らない `serve: http-server -p 5001` があり、初版はそれを拾っていた)。
- **appRoot は宣言された workspace から読む。** `package.json` の `workspaces` と
  `pnpm-workspace.yaml` を展開し、候補を「**その start スクリプトが何を起動するか**」で採点する。
  依存で判定しない ── hoist されるので。`examples/` `docs/` はマイナス。
- **framework 判定に workspace ルートの依存を合流**させ、config 拡張子に `.mts`/`.cts`/`.mjs` を追加。
- **confidence にポートの出所を反映。** リポジトリから読めた +0.2、コマンドから推定 +0.15、
  既定表に落ちた **−0.15**。todomvc は 0.95 → **0.50** になった(正しい)。

修正後:

| repo | framework | appRoot | port | conf |
| --- | --- | --- | --- | --- |
| next-template | nextjs | — | 3000 ✓ | 0.90 |
| reveal.js | vite | — | 5173 ✓ | 0.90 |
| excalidraw | vite ✓ | `excalidraw-app` ✓ | 5173 ✓ | 0.90 |
| astro-docs | astro | — | 4321 ✓ | 0.90 |
| todomvc | static | — | 8080 ✓ | 0.50 |

学びは**リポジトリではなく「形」として** `packages/pipeline/test/detect-shapes.test.ts` に固定した。
実リポジトリを clone するテストは、相手が変わった瞬間に嘘になるので採らない。

### まだ埋まっていない穴

- **候補の質が mock では測れない。** 全リポジトリで「1 候補・spec 由来 0 件」だが、
  これは mock LLM の出力であって、決定的信号(spec / route)が薄いことの反映にすぎない。
  `ANTHROPIC_API_KEY` を入れて live で回すまで、understand の実力は不明。
- **E2E spec がある実リポジトリをまだ 1 本も通していない。** 5 本とも Playwright spec 無し。
  最強の信号が一度も使われていないので、次はそこを選ぶ。
- **`--build` の通過率が未測定。** 上表はすべて解析のみ。
- **Astro のルート抽出が無い。** `extractRoutes` は Next.js と React Router のみ。
- **codeload タルボールが 403。** `ingest` を `git clone --depth 1` 優先に変更した
  (タルボールはフォールバック)。git 設定を経由するので認証・プロキシ・self-hosted も通る。

### 次の回で足すべきリポジトリ

Playwright spec を持つ実在アプリ。最強の信号が使われる経路を通すため。
