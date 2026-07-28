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

### `--build`(実際に起動するか)

検出が全部正しくなった状態で 2 本を起動まで通したところ、**2 本とも install で死んだ。**
つまり実在リポジトリが最初に死ぬのは detect ではなく **install** で、
しかも今回の 2 件はどちらも「本当は失敗ではない」死に方だった。

| repo | 症状 | 判定 |
| --- | --- | --- |
| reveal.js | `npm ci` が `package.json` と lockfile の不一致で拒否 | **回復可能。** 誰も install していないリポジトリでは日常的な状態 |
| next-template | install が 10 分でタイムアウト | 遅いだけの可能性。**10 分間まったく無出力**だったので、ハングと区別がつかなかった |

対応:

- **strict → permissive のフォールバック。** `npm ci` → `npm install`、
  `pnpm --frozen-lockfile` → `--no-frozen-lockfile`、`yarn --frozen-lockfile` → `yarn install`。
  再現性のある木のほうが望ましいので strict を先に試すが、
  **lockfile が古いという理由でデモを作らないのは誰の得にもならない。**
  すでに permissive なコマンドには null を返す(同じコマンドを 2 回走らせて
  「再試行した」ことにしないため)。
- install の出力を `ctx.progress` に流す。**10 分の沈黙はハングと見分けがつかない。**
- install のタイムアウトを 15 分へ。

### 計測そのものが汚染されていた(重要)

install フォールバックを入れて reveal.js を再試験したところ、
**492 秒かけて npm 内部エラー(`Exit handler never called!`)** で落ちた。
ところが同じ `npm install` をサンドボックス経由で単独実行すると **4.9 秒で成功**する。

`ps` を見たら答えがあった。**05:48 に開始した `npm install` が 32 分間生き残っていた。**
それは私が 05:54 に kill した field-test の子プロセスで、
共有 npm キャッシュ(`/root/.npm`)を掴んだまま動き続けていた。

つまり:

1. **我々のバグ:** `exec` が `detached` なしで spawn していたため、
   親を kill しても子(とその孫)が残る。`start` は process group を扱っていたが `exec` は扱っていなかった。
2. **その孤児が後続の計測を全部汚染していた。** しかも症状は
   「テスト対象リポジトリの install が壊れている」ように見える ── **一番誤解を招く場所に出る。**

修正:

- `exec` も `detached: true` + process group 単位で kill。
- **このプロセスが起動した子を全部追跡**し、`exit` / `SIGINT` / `SIGTERM` で
  まとめて始末する。リポジトリのコマンドを走らせっぱなしにする権利は我々に無い。
- `packages/pipeline/test/sandbox-lifetime.test.ts` が
  「タイムアウト時に孫プロセスまで死ぬ」ことを実際のプロセスで検証する。

孤児を殺して再計測: **492 秒 → 16.1 秒。** install も通過した。

### dev サーバーなら production build は要らない

16.1 秒の実行で今度は `SDV-E021` になった。reveal.js の build は
`tsc && vite build && vite build -c ... `(config 7 本)で、これが落ちる。

しかし reveal.js の `start` は `vite` ── **オンデマンドでコンパイルする dev サーバー**で、
build 成果物を必要としない。**要らないビルドを走らせて、その失敗でデモを作らないのは筋が悪い。**

- `vite preview` / `next start` / `serve` → 成果物を配るので **build 必須**
- `vite` / `next dev` / `astro dev` / `ng serve` → **build 不要**(`build.build = null` にする)

成果物版が欲しい場合はプロファイル上書きで戻せる。

### reveal.js を起動させるまでに出た残り 3 件

ポート・build スキップを直した後も、落ちる場所が毎回前に進んだ。

| # | 症状 | 根本原因 | 判定 |
| --- | --- | --- | --- |
| 8 | dev サーバーが `vite.config.ts` から `./build/dts-paths.ts` を解決できず起動失敗 | **ingest が `build/` という名前のディレクトリを無条件削除していた。** reveal.js はそのファイルをバージョン管理に入れ、config から import している | **ソースを消していた。**`.gitignore` も `build/` を無視していない。名前だけで生成物と決めつけたのが誤り |
| 9 | ポートがまた違う(3 つ目の理由) | `server: { port: Number(process.env.npm_config_port \|\| 8000) }` ── **リテラル代入しか読めない正規表現**では見つからない | 走るコマンドに対応するブロック(`server` / `preview`)を括弧走査し、`port:` の後の最初の数値を取る。reveal.js = 8000、**excalidraw = 3000**(前回の 5173 も誤りだった) |
| 10 | `fetchRemote` が呼ばれていない | git clone 優先の ingest を書いたが**呼び出し側を差し替え忘れた** | 「直した」と報告したものが動いていなかった |
| 11 | 起動したのに `SDV-E040`(最初の画面が 0.5%) | reveal.js の `/` は黒背景に「Slide 1」の 2 語。**空白判定がインク量しか見ていない** | 誤検知。「描画に失敗した」と「意図的に余白が多い」が区別できていなかった |

#8 の修正方針:

- `node_modules` と `.git` **以外**は、リポジトリ自身の `.gitignore` が
  生成物だと言っている場合にのみ削除する。
- `dist/reveal.es5.js` のような「中のファイル」を指す規則では、
  **ディレクトリ自体は追跡対象のまま** ── この区別を落としていた。
- `.gitignore` が無ければ従来の名前リストに落ちる。
  それは推測だが、**リポジトリのルートに答えが置いてあるのに推測を優先する**のとは違う。

#11 の修正方針:

インク量に加えて**構造**にも投票させる。描画できているアプリは
「一定サイズでレイアウトされた要素」と「その中のテキスト」を持ち、
失敗したアプリは背景色に関係なくどちらも持たない。
**両方が空のときだけ**拒否する。

`--keep`(`var/field` を再利用)を足した。依存キャッシュとビルドログが残る。
実在リポジトリの install には数分かかり、毎回それを払うのが
「このループを回す気にならない」理由だった。**#8 を見つけられたのは、
このログが残ったからである。**

### reveal.js の結論:**通さない**のが正解

構造チェックを入れた後の診断はこうなった:

```
app up      http://127.0.0.1:8000
SDV-E040 — the first screen is 0.5% content with 8 laid-out elements
           and 7 characters of text
```

reveal.js の `index.html` の中身は:

```html
<div class="reveal"><div class="slides">
  <section>Slide 1</section>
  <section>Slide 2</section>
</div></div>
```

見えているのは「Slide 1」の **7 文字だけ**。
これはフレームワークの最小サンプルであって、アプリではない。

**ここで閾値を下げれば reveal.js は通る。下げない。**
それは「悪いテストケースを通すためにプロダクトを弱める」ことであり、
このフィールドテストが存在する理由と正反対になる。
E040 は正しい判定で、正しい対応は
**デモ対象として筋の良いリポジトリを選ぶこと**である。

reveal.js から得たものは十分に大きい(不具合 8 件)が、
**プレゼンライブラリはデモ動画の題材ではない。**
第 2 回は Playwright spec を持つ普通の Web アプリを選ぶ。

依存キャッシュの効果も確認できた:**534 秒 → 108.9 秒**。

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
