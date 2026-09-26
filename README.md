# 株バトル（KabuBattle）

日本株（まず日経 225）の **決算 → 素体**、**株価の動き → 日々の状態**、**事業・技術 → 技** でキャラクターを組み立て、
[BarcodeTool](https://github.com/ksaga115/BarcodeTool) の「コードバトル」エンジンで戦わせるゲーム。
契約金は株価、手放すと時価で戻る。毎朝の予想がバフになり、夕方に「その日の相場そのもの」が敵として現れる。

- 設計書: [`docs/設計書.md`](./docs/設計書.md)（長期運用前提。データの流れ・ID・保存形式・移行手順を先に固定）
- 状態: 設計承認済み。実装は M1（銘柄マスタ・技の初版・GitHub Actions）から着手予定
- 公開 URL（予定）: https://ksaga115.github.io/KabuBattle/

## 構成（予定）

| パス | 役割 |
|---|---|
| `index.html` | ゲーム本体（単一 HTML。静的 JSON を読むだけ） |
| `kabu/universe.json` | 銘柄マスタ（コード・社名・33 業種・属性・所属指数・上場状態） |
| `kabu/moves.json` | 技データ（業種技・固有技・必殺技。`origin` に元ネタの一言） |
| `kabu/art/` | キャラ画像（1 銘柄 1 枚、生成は一度きり） |
| `kabu/data/latest.json` | 今日の状態スナップショット（GitHub Actions が平日 16:30 JST に更新） |
| `kabu/data/fin/` | 決算（J-Quants、週次） |
| `scripts/kabu/` | 取得・検証・シミュレーション |
| `.github/workflows/` | 日次・週次・検証 |

## データソース

株価日足は stooq、決算は J-Quants（無料プラン）、業種は JPX。恒常費用ゼロ。詳細と失敗時の挙動は設計書 §2。
