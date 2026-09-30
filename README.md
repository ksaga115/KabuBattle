# 株バトル（KabuBattle）

日本株の **決算 → 素体**、**株価の動き → 日々の状態**、**事業・技術 → 技**、**値動きのクセ → 気質** で
キャラクターを組み立て、コードバトルのエンジンで戦わせるゲーム。
契約金は株価、手放すと時価で戻る。毎朝の予想がバフになり、夕方に「その日の相場そのもの」が敵として現れる。

- 設計書: [`docs/設計書.md`](./docs/設計書.md)（データの流れ・ID・保存形式・移行手順。§14 以降に実装で変えた点）
- 公開 URL: **https://ksaga115.github.io/KabuBattle/**
  （`kabu-pages` ワークフローが push のたびに公開し直す。データが更新されれば公開ページも新しくなる）
- 状態: **遊べます**。東証に上場している内国株式すべて（3,700 銘柄）・実データ入り。
  M1〜M2、予想・シーズン・称号（M5）、上場廃止・分割・年次アーカイブ（§8）、
  気質・ポートフォリオ・練度（§15）、今日のお題・日経との比較（§16）まで実装済み。
  未着手は決算日ボス（§9.3）とキャラ画像の生成（M4。いまは手続き生成の SVG）。

## 遊びかた（手元で）

ゲームは `kabu/*.json` を読むので、`index.html` をファイルとして直接開くとブラウザの制限で読み込めません。

```
node scripts/serve.mjs      # → http://127.0.0.1:8787/
```

資金 30 万円から始めて、「市場」で銘柄と契約し、「編成」で 3 体（前衛・中衛・後衛）を並べ、
「トップ」の精算ボタンで対戦します。セーブはこの端末の中だけ（localStorage）で、書き出し・読み込みができます。

## 構成

| パス | 役割 |
|---|---|
| `index.html` | ゲーム本体（単一 HTML。ビルド生成物なので直接編集しない） |
| `src/template.html` | 画面と進行。`index.html` のもと |
| `src/kabu-core.js` | 中核。決算・株価・事業 → 対戦エンジンが食える個体に翻訳する（`KB`） |
| `src/engine.js` | 対戦エンジン（同梱。出どころと変更点はファイル冒頭） |
| `kabu/universe.json` | 銘柄マスタ（コード・社名・33 業種・属性・市場/規模区分・上場状態。1 銘柄 1 行） |
| `kabu/moves.json` | 技データ（33 業種の業種技＋主要銘柄の固有技 2 つと必殺技。`origin` に元ネタの一言） |
| `kabu/data/latest.json` | 今日の状態スナップショット（ゲームはこれだけ読めば動く。素体も焼き込む） |
| `kabu/data/daily/` | 日次スナップショットの履歴（まとめ精算・監査用） |
| `kabu/data/index.json` | どの日の履歴が実在するかの目録（静的配信ではディレクトリ一覧が取れないため） |
| `kabu/data/fin/<code>.json` | 決算（TTM。週次） |
| `scripts/kabu/` | 取得・検証・シミュレーション |
| `.github/workflows/` | 日次・週次・検証 |

## 道具

```
node scripts/build-kabu.mjs           # index.html を組み立てる（ソースを直したら必ず）
node scripts/build-kabu.mjs --check   #   焼き直し忘れがないか見るだけ
node scripts/kabu/build-universe.mjs  # JPX から銘柄マスタを更新（内国株式すべて）
node scripts/kabu/build-universe.mjs --large-only   # 大型 99 銘柄に絞る（動作確認用）
node scripts/kabu/fetch-prices.mjs    # 日足 → latest.json（平日 16:30 JST に Actions が回す）
node scripts/kabu/fetch-fin.mjs       # 決算 → fin/<code>.json（週次）
node scripts/kabu/archive.mjs         # 古い年の日次履歴を 1 ファイルに畳む（§8.7）
node scripts/kabu/validate.mjs        # ゲームが読めない JSON をコミットさせないための検査
node scripts/kabu/sim.mjs             # 決定論・A/B 対称・停止性・勝率曲線・分割検出
node scripts/serve.mjs                # 手元で遊ぶための簡易サーバー
```

`--dry` を付けると書き込みません。`--limit N` で先頭 N 銘柄だけ試せます。

## データソース

株価日足・決算は Yahoo Finance、銘柄マスタ（社名・33 業種・規模区分）は JPX「東証上場銘柄一覧」。
いずれも認証もキーも不要で、恒常費用はゼロ。設計書が前提にしていた stooq と J-Quants が
使えなくなった経緯は §14。失敗時の挙動（1 銘柄の失敗は前回値を引き継ぎ、全体の失敗では更新しない）は §2.1。

## 対戦エンジン

エンジン（コードバトルの `CB`）は **株バトルに同梱**しています（`src/engine.js`）。もとは
[BarcodeTool](https://github.com/ksaga115/BarcodeTool) のもので、出どころ（コミット・sha256）と
株バトルのために変えたところはファイル冒頭に全部書いてあります。ビルドに通信は要りません。

エンジンの数式を触ったら、必ず `node scripts/kabu/sim.mjs` を回して決定論・A/B 対称・停止性・
勝率曲線が崩れていないことを確かめてください。

## 注意

遊びのためのものです。表示している株価・決算は実データですが、**投資判断には使えません**。
動くお金はゲーム内通貨だけで、課金も送金もありません。
