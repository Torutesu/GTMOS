# GTMOS

**市場を獲るための、Go-To-Market OS。**

Select グループ全事業のフルスタック GTM(Go-To-Market)を横軸で担い、
その知見を国内外の顧客へ外販していく事業のリポジトリ。

---

## このリポジトリの中身

```
docs/
  business-plan.md   事業計画(なぜやるか / 事業モデル / サービス / 体制 / ロードマップ)
  positioning.md     ポジショニング・メッセージング・競合リファレンス
  lp-copy.md         LP コピー(EN / JA 対訳、実装のソース・オブ・トゥルース)
  playbooks/
    b2c-launch.md    型 #01 — B2C ローンチ(0→1)。勝ち筋 / チェックリスト / 自動化候補
  cases/
    shogunai-launch.md  型 #01 の 1 回目の実行。7日トライアル設計 + X 運用
site/
  index.html         LP(EN・デフォルト)
  ja/index.html      LP(JA)
  assets/            CSS / SVG / OGP 画像
  robots.txt sitemap.xml 404.html
tools/
  make-og.mjs        OGP 画像(1200×630 PNG)生成スクリプト
```

## 型(プレイブック)について

`docs/playbooks/` が事業の本体。**実行を資産に変換した結果**がここに溜まる。

ルール:

1. 施策の起票時に、既存の型の何回目か / 新規の型かを宣言する。
2. **型への差分が書き戻されるまで、施策をクローズしない。**
3. 同じことを 2 回手でやったら、3 回目は機械化する(→ 各プレイブックの「昇格ルール」)。
4. 外部調査由来の数値は、自社の実測値に差し替わって初めて価値を持つ。

## サイトを見る

ビルド不要。静的ファイルをそのまま配信する。

```bash
cd site && python3 -m http.server 4173
# → http://localhost:4173/      (EN)
# → http://localhost:4173/ja/   (JA)
```

## デプロイ

Cloudflare Pages / Vercel いずれも設定は同じ。

| 項目 | 値 |
| --- | --- |
| Build command | (なし) |
| Output directory | `site` |
| Framework preset | None / Static |

ドメインは `gtmos.com` を想定(取得可・未取得)。
`site/` 内の `https://gtmos.com` を実ドメインに置換すれば他ドメインでも動く。

## 設計方針

- **ゼロビルド / ゼロ JS**。外部リクエストは 0 本(フォント・スクリプト・CDN を一切読まない)。
  Lighthouse Performance / SEO / Best Practices 100 を素で出す構成。
- **EN がデフォルト、JA は `/ja/`**。ターゲット順序(グローバル → 国内)に合わせている。
  単一ドメインに SEO 評価を集約するためサブディレクトリ構成。
- **コピーは翻訳ではなく各言語ネイティブ表現**。対訳は `docs/lp-copy.md` に一元管理し、
  HTML はその実装として扱う。コピーを直すときは先に `lp-copy.md` を直す。

## 差し込み待ちのプレースホルダ

実データが決まり次第、以下を置換する。

| 箇所 | 現在の値 | 備考 |
| --- | --- | --- |
| 連絡先 | `hello@gtmos.com` | ドメイン取得後に有効化。フォーム化するなら CTA の `href` を差し替え |
| 実績セクション | 定性文のみ | 具体事例・数値が出たら `#proof` にカード追加 |
| X / SNS | `@` 未設定 | `twitter:site` / footer リンク |
| ロゴ | 暫定 SVG(`assets/gtmos-mark.svg`) | 正式ロゴ確定後に差し替え |

## OGP 画像の再生成

コピーやデザインを変えたら再生成する(Playwright + プリインストール Chromium を使用)。

```bash
node tools/make-og.mjs
```
