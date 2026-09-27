// scripts/kabu/fetch-prices.mjs
// 日足を取って「今日の状態」を計算し、kabu/data/latest.json と kabu/data/daily/<日付>.json を書く。
// あわせて「どの日の履歴が実在するか」の目録 kabu/data/index.json を作り直す。
// 設計書 §5（状態）・§2.1（失敗時の挙動）・§8.3（分割）・§7.1（未処理日のまとめ精算）。
//
// ゲームは latest.json だけ読めば動く（派生値はここで焼き込む。ブラウザ側では計算しない）。
// ただし「開かなかった日をまとめて精算する」には daily/ の在り処を知る必要がある。
// ディレクトリ一覧を取る手段が無い（GitHub Pages は静的配信）ので、目録を JSON で置く。
//
// 素体（攻守速技運・体力・レア度・特性）もここで焼き込む。設計書 §1 の
// 「ゲームが実行時に読むのは latest.json・universe.json・moves.json だけ」を守るため。
// 全上場企業（約 3,500 社）では、ゲームが銘柄ごとの fin/<code>.json を取りに行く形は破綻する。
// 技は焼き込まない（moves.json を見ればゲーム側で組めるので二重に持たない）。
//
// 使い方:
//   node scripts/kabu/fetch-prices.mjs            … 取得して書き出す
//   node scripts/kabu/fetch-prices.mjs --dry      … 書き込まない
//   node scripts/kabu/fetch-prices.mjs --limit 5  … 先頭 N 銘柄だけ（動作確認用）
//   node scripts/kabu/fetch-prices.mjs --conc 12  … 同時取得数（既定 10）
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { ROOT } from "./vendor-cb.mjs";
import { loadCore } from "./load.mjs";
import * as yahoo from "./sources/yahoo.mjs";

const UNIVERSE = resolve(ROOT, "kabu", "universe.json");
const DATA = resolve(ROOT, "kabu", "data");
const LATEST = resolve(DATA, "latest.json");
const DAILY_DIR = resolve(DATA, "daily");
const INDEX = resolve(DATA, "index.json");
const FIN_DIR = resolve(DATA, "fin");
const NK225_SYMBOL = "^N225";

const source = yahoo;   // 設計書 §8.5: ここを差し替えれば取得元を替えられる

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

// ══════════════ 値幅制限（JPX の制限値幅表）══════════════
// 前日終値（基準値段）に対する制限値幅。ストップ高／ストップ安の判定に使う（§5.1）。
const LIMIT_TABLE = [
  [100, 30], [200, 50], [500, 80], [700, 100], [1000, 150], [1500, 300], [2000, 400],
  [3000, 500], [5000, 700], [7000, 1000], [10000, 1500], [15000, 3000], [20000, 4000],
  [30000, 5000], [50000, 7000], [70000, 10000], [100000, 15000], [150000, 30000],
  [200000, 40000], [300000, 50000], [500000, 70000], [700000, 100000], [1000000, 150000],
  [1500000, 300000], [2000000, 400000], [3000000, 500000], [5000000, 700000],
  [7000000, 1000000], [10000000, 1500000], [15000000, 3000000], [20000000, 4000000],
  [30000000, 5000000], [50000000, 7000000]
];
export function priceLimit(base) {
  const b = Number(base);
  if (!isFinite(b) || b <= 0) return Infinity;
  for (const [ceil, width] of LIMIT_TABLE) if (b < ceil) return width;
  return 10000000;
}

// ══════════════ 派生値 ══════════════
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function median(a) {
  const v = a.filter((x) => isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return 0;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ══════════════ 気質（テクニカル）設計書 §15 ══════════════
// 日足 1 年から計算できる、実在のテクニカル指標。追加の通信は要らない（すでに 1 年ぶん取っている）。
// 実測での散らばり（120 銘柄）:
//   ヒストリカル・ボラティリティ  10.9% 〜 122.3%（11 倍）
//   ベータ                        -0.23 〜 1.34（市場と逆に動く銘柄まである）
//   自己相関                      -0.30（平均回帰）〜 +0.26（モメンタム）
//   最大ドローダウン              -12.8% 〜 -45.2%
//   売買代金                      0.04 億 〜 31 億円/日（776 倍）
// 決算（四半期）より速く、株価（毎日）より遅い ＝ その銘柄の「性格」。

const meanOf = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sdOf = (a) => { const m = meanOf(a); return Math.sqrt(meanOf(a.map((x) => (x - m) ** 2))); };

/** 日足 → 対数リターンの系列（日付つき。市場と突き合わせるため） */
export function returnsOf(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].close > 0 && rows[i].close > 0) out.push({ date: rows[i].date, r: Math.log(rows[i].close / rows[i - 1].close) });
  }
  return out;
}

/**
 * @param {Array} rows      日足（日付昇順）
 * @param {Map}   marketRet 日付 → 日経平均の対数リターン
 */
export function technicals(rows, marketRet) {
  if (!rows || rows.length < 40) return null;
  const ret = returnsOf(rows);
  if (ret.length < 40) return null;
  const rs = ret.map((x) => x.r);

  // ヒストリカル・ボラティリティ（年率）。ダメージの振れ幅に効く
  const vol = sdOf(rs) * Math.sqrt(250);

  // ベータ（日経平均への感応度）。暴落の日・祭りの日の受け方が銘柄ごとに変わる
  let beta = 1, corr = 0;
  if (marketRet && marketRet.size) {
    const a = [], b = [];
    for (const x of ret) { const m = marketRet.get(x.date); if (m != null) { a.push(x.r); b.push(m); } }
    if (a.length >= 30) {
      const ma = meanOf(a), mb = meanOf(b);
      let cov = 0, varm = 0;
      for (let i = 0; i < a.length; i++) { cov += (a[i] - ma) * (b[i] - mb); varm += (b[i] - mb) ** 2; }
      beta = varm > 0 ? cov / varm : 1;
      const sa = sdOf(a), sb = sdOf(b);
      corr = sa > 0 && sb > 0 ? (cov / a.length) / (sa * sb) : 0;
    }
  }

  // 自己相関（1 日ラグ）。正＝勢いが続く（モメンタム）、負＝行き過ぎたら戻る（平均回帰）
  let autocorr = 0;
  {
    const x = rs.slice(0, -1), y = rs.slice(1);
    const mx = meanOf(x), my = meanOf(y);
    let s = 0, sx = 0, sy = 0;
    for (let i = 0; i < x.length; i++) { s += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
    autocorr = sx > 0 && sy > 0 ? s / Math.sqrt(sx * sy) : 0;
  }

  // 最大ドローダウンと、そこから戻せているか
  let peak = -Infinity, mdd = 0;
  for (const r of rows) { peak = Math.max(peak, r.close); mdd = Math.min(mdd, r.close / peak - 1); }
  const recovery = peak > 0 ? rows[rows.length - 1].close / peak : 1;   // 1 に近いほど高値圏まで戻している

  // 売買代金（流動性）。薄い銘柄は動きが鈍い
  const turnover = meanOf(rows.slice(-60).map((r) => r.close * r.volume));

  return {
    vol: round4(vol), beta: round2(beta), corr: round2(corr),
    autocorr: round2(autocorr), mdd: round4(mdd), recovery: round4(recovery),
    turnover: Math.round(turnover)
  };
}

/**
 * 日足の系列から「今日の状態」を作る。設計書 §5 の派生値をすべてここで確定させる。
 * @param {Array} rows 日付昇順の日足
 * @param {{eps?:number,bps?:number,shares?:number}} [fin]
 */
export function deriveState(rows, fin) {
  if (!rows || rows.length < 2) return null;
  const last = rows[rows.length - 1], prev = rows[rows.length - 2];
  const close = last.close, prevClose = prev.close;

  const year = last.date.slice(0, 4);
  const inYear = rows.filter((r) => r.date.slice(0, 4) === year);
  const firstOfYear = inYear.length ? inYear[0] : rows[0];
  const ytdHigh = inYear.length ? Math.max(...inYear.map((r) => r.high)) : last.high;
  const ytdLow = inYear.length ? Math.min(...inYear.map((r) => r.low)) : last.low;
  const span = ytdHigh - ytdLow;

  const vol20 = rows.slice(-20).map((r) => r.volume);
  const avgVolume20 = mean(vol20);
  const sma25 = mean(rows.slice(-25).map((r) => r.close));

  const width = priceLimit(prevClose);
  const eps = fin && isFinite(fin.eps) ? Number(fin.eps) : null;
  const bps = fin && isFinite(fin.bps) ? Number(fin.bps) : null;
  const shares = fin && isFinite(fin.shares) ? Number(fin.shares) : null;

  return {
    date: last.date,
    close: round2(close),
    prevClose: round2(prevClose),
    open: round2(last.open), high: round2(last.high), low: round2(last.low),
    volume: last.volume,
    avgVolume20: Math.round(avgVolume20),
    chg1: safeDiv(close, prevClose) - 1,
    chgYtd: safeDiv(close, firstOfYear.close) - 1,
    ytdHigh: round2(ytdHigh), ytdLow: round2(ytdLow),
    // レンジ幅 0（上場直後など）なら真ん中に置く
    ytdPos: span > 0 ? clamp01((close - ytdLow) / span) : 0.5,
    volRatio: avgVolume20 > 0 ? last.volume / avgVolume20 : 1,
    range: prevClose > 0 ? (last.high - last.low) / prevClose : 0,
    sma25: round2(sma25),
    dev25: sma25 > 0 ? close / sma25 - 1 : 0,
    limitUp: isFinite(width) && close >= prevClose + width - 1e-9,
    limitDown: isFinite(width) && close <= prevClose - width + 1e-9,
    per: eps && eps > 0 ? round2(close / eps) : null,
    pbr: bps && bps > 0 ? round2(close / bps) : null,
    mcap: shares && shares > 0 ? Math.round(close * shares) : 0,
    stale: 0, suspect: false
  };
}

const safeDiv = (a, b) => (isFinite(a) && isFinite(b) && b !== 0 ? a / b : 1);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round2 = (v) => (isFinite(v) ? Math.round(v * 100) / 100 : 0);
const round4 = (v) => (isFinite(v) ? Math.round(v * 10000) / 10000 : 0);

/**
 * 異常値の見張り（§2.1）。前日比 ±60% を超えて出来高が平時並みなら、配信のおかしさを疑う。
 * 分割・併合は §8.3 で別に扱う（Yahoo は分割イベントを直接くれるのでそちらを優先）。
 */
// 日本株で 1 株 100 万円を超える銘柄は事実上ない（最高値でもファーストリテイリングの 7 万円台。
// 実測の分位は 50% が 1,514 円・99.9% でも 79,600 円）。ところが全上場企業を相手にすると、
// 流動性の薄い銘柄で桁が 5〜6 桁ずれた終値が実際に混じる:
//   1909 日本ドライケミカル 16,280,000,512 円（実際は 3,700 円前後。1:4,400,000 の併合比を掛けた疑い）
//   2180 サニーサイドアップ  1,886,167,168 円（実際は 1,309 円。split イベントは無い）
//   7426 山大                  240,292,736 円（実際は 1,700 円前後。meta も一貫して壊れている）
// meta（chartPreviousClose）との突き合わせでは検出できないので、絶対値の上限で弾く。
const PRICE_CEILING = 1e6;
export function isUsableClose(close) {
  return isFinite(close) && close > 0 && close <= PRICE_CEILING;
}

// 時価総額（= 終値 × 発行済株式数）の上限。日本最大でも 40 兆円台なので 200 兆円を超えたら
// 発行済株式数か分割調整が壊れている。体力（§4.2）・レア度（§4.4）・特性 serene・
// mcapTop10 に直に効くので、壊れた値をそのまま通すと上位 10 枠を占領してしまう。
const MCAP_CEILING = 2e14;
export function isUsableMcap(mcap) {
  return isFinite(mcap) && mcap >= 0 && mcap <= MCAP_CEILING;
}

/**
 * 分割・併合の比が常識の範囲か（§8.3）。実在する分割・併合はせいぜい 1:10〜10:1 で、
 * 設計書 §8.3 が挙げている n も 2・3・4・5・10 まで。範囲外は上場廃止会社の整理や
 * 取得元の単位の取り違え（例: 1:4400000）なので取り込まない。
 * 口数と取得単価に直接効く値なので、おかしなものを latest.json に載せてはいけない。
 */
const SPLIT_MIN = 0.1, SPLIT_MAX = 10;
export function isSaneSplit(split) {
  const r = Number(split && split.ratio);
  if (!isFinite(r) || r <= 0) return false;
  return r >= SPLIT_MIN - 1e-9 && r <= SPLIT_MAX + 1e-9;
}

export function looksSuspect(state, splitToday) {
  if (splitToday) return false;
  if (Math.abs(state.chg1) <= 0.60) return false;
  const volSpike = state.avgVolume20 > 0 && state.volume >= state.avgVolume20 * 2;
  return !volSpike;
}

// ══════════════ 取得の回し方 ══════════════
// 3,500 銘柄を 1 本ずつ取るので、同時数は「相手に迷惑をかけない」と「現実的な時間で終わる」
// の折り合い。既定 10（Yahoo のチャート API は 1 銘柄 1 リクエスト・レスポンス 100KB 前後）。
// 途中経過を 15 秒ごとに出す（無言で何十分も黙らない）。
const DEFAULT_CONC = 10;

async function pool(items, size, worker, label) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  const t0 = Date.now();
  let lastLog = t0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
      done++;
      const now = Date.now();
      if (label && (now - lastLog >= 15000) && done < items.length) {
        lastLog = now;
        const per = (now - t0) / done;
        const rest = Math.round((items.length - done) * per / 1000);
        console.log(`[${label}] ${done} / ${items.length} 件（${((now - t0) / 1000).toFixed(0)} 秒経過・残り ${rest} 秒見込み）`);
      }
    }
  });
  await Promise.all(runners);
  if (label) console.log(`[${label}] ${done} 件すべて処理しました（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  return out;
}

// fin/ は 3,500 ファイルになるので、1 銘柄ごとに existsSync を呼ばずに一覧を 1 回だけ取る。
// 同じ銘柄を派生値の計算と素体の焼き込みで 2 回引くので、読んだものは覚えておく。
let finFiles = null;
const finCache = new Map();
function readFin(code) {
  if (finCache.has(code)) return finCache.get(code);
  if (finFiles === null) finFiles = new Set(existsSync(FIN_DIR) ? readdirSync(FIN_DIR) : []);
  let ttm = null;
  if (finFiles.has(`${code}.json`)) {
    try {
      const j = JSON.parse(readFileSync(resolve(FIN_DIR, `${code}.json`), "utf8"));
      ttm = j && j.ttm ? j.ttm : j;
    } catch { ttm = null; }
  }
  finCache.set(code, ttm);
  return ttm;
}

/** 直近 1 年ぶんの 1 株配当の合計。日足と一緒に返ってくる events から作る（§4.1 の div）*/
export function annualDividend(dividends, asOf) {
  if (!Array.isArray(dividends) || !dividends.length) return 0;
  const base = asOf ? Date.parse(`${asOf}T00:00:00Z`) : Date.now();
  const cutoff = new Date(base - 370 * 86400000).toISOString().slice(0, 10);
  return round2(dividends.filter((d) => d.date >= cutoff).reduce((s, d) => s + Number(d.amount || 0), 0));
}

// ══════════════ 履歴の目録 index.json（§7.1）══════════════
// ゲームは「最後に開いた日」から「latest.json の日付」までを順に精算する。その途中の日が
// daily/ に実在するかどうかを知る手段がこれ（静的配信ではディレクトリ一覧が取れない）。
//
//   { "schemaVersion": 1, "updatedAt": "2026-09-26", "latest": "2026-09-25",
//     "dailyExt": ".json.gz", "dailyKind": "thin",
//     "days": ["2026-09-24", "2026-09-25"], "archived": ["2025"] }
//
// days       … daily/ に実在する日（アーカイブ済みの年は入らない）を昇順で
// latest     … latest.json の日付と必ず一致する
// archived   … 年次アーカイブ（archive.mjs）に畳んだ年。無ければ []
// dailyExt   … 日次ファイルの拡張子。ゲームは `kabu/data/daily/${date}${dailyExt}` を取る。
//              形を替えてもここを見れば分かる（ゲーム側を直さずに済ませるための口）
// dailyKind  … "thin" = 日次は精算に要る項目だけ（全項目は latest.json にある）。§8.7 参照
//
// 拡張子は `.json` でも `.json.gz` でもよい形にしておく（移行中は両方が混ざる）。
const DATE_JSON = /^(\d{4})-\d{2}-\d{2}\.json(\.gz)?$/;
const DAILY_EXT = ".json.gz";
const DAILY_KIND = "thin";

/** 既存の index.json（無ければ null）。archived を引き継ぐために読む */
export function readIndex() {
  if (!existsSync(INDEX)) return null;
  try { return JSON.parse(readFileSync(INDEX, "utf8")); } catch { return null; }
}

/**
 * daily/ を実際に走査して index.json の中身を組む（メモリ上の想定ではなくファイルから作る）。
 * @param {{latest?:string|null, today?:string, addArchived?:string[], removeArchived?:string[]}} [opt]
 *   latest         … 省略時は latest.json から読む
 *   addArchived    … archive.mjs が畳んだ年を足すときに渡す
 *   removeArchived … archive.mjs --restore が戻した年を外すときに渡す
 */
export function buildIndex(opt = {}) {
  const prev = readIndex();
  const dropped = new Set((opt.removeArchived || []).map(String));
  const archived = [...new Set([
    ...(Array.isArray(prev && prev.archived) ? prev.archived.map(String) : []),
    ...(opt.addArchived || []).map(String)
  ])].filter((y) => !dropped.has(y)).sort();
  const archivedYears = new Set(archived);

  const days = [...new Set(
    (existsSync(DAILY_DIR) ? readdirSync(DAILY_DIR) : [])
      .map((f) => DATE_JSON.exec(f))
      .filter((m) => m && !archivedYears.has(m[1]))   // 畳んだ年の残骸は目録に載せない
      .map((m) => m[0].slice(0, 10))                  // "2026-09-25.json.gz" → "2026-09-25"
  )].sort();

  let latest = opt.latest;
  if (latest === undefined) {
    latest = null;
    if (existsSync(LATEST)) {
      try { latest = JSON.parse(readFileSync(LATEST, "utf8")).date || null; } catch { latest = null; }
    }
  }

  return {
    schemaVersion: 1,
    updatedAt: opt.today || new Date().toISOString().slice(0, 10),
    latest,
    dailyExt: DAILY_EXT,
    dailyKind: DAILY_KIND,
    days,
    archived
  };
}

// ══════════════ 日次スナップショットの薄い形（§8.7）══════════════
// 全上場企業だと latest.json は 1〜2MB になる。同じものを毎日 daily/ にも置くと、git の履歴に
// 毎日 1〜2MB が永久に積まれて年 300MB を超える。日次は「開かなかった日をあとから精算する」
// ためだけにあるので、精算に要らない項目（open/high/low/volume/sma25/per/pbr/mcap など）は
// latest.json にだけ置き、日次からは落とす。
//
// さらに gzip で置く（daily/<日付>.json.gz）。拡張子は index.json の dailyExt で分かるので、
// ゲーム側は `daily/${date}${idx.dailyExt}` を取り、.gz なら DecompressionStream("gzip") を通す。
//
// 約束: **キーが無い＝false / 0**。false や 0 のキーは書かない（1 銘柄あたり数十バイト効く）。
// per / pbr / sectorPer / sectorPbr も載せる。設計書 §5.1 の「粘り」「期待」がこの 4 つだけで
// 決まるので、落とすと「あとから精算した日だけ 2 つの効果が消える」ことになる（gzip 後は数 KB）。
const THIN_NUM = ["close", "chg1", "chgYtd", "ytdPos", "volRatio", "range", "dev25",
  "per", "pbr", "sectorPer", "sectorPbr"];
const THIN_FALSY = ["limitUp", "limitDown", "suspect", "provisional", "mcapTop10", "stale", "split", "earnings"];
const THIN_KEEP = ["stats", "hp", "hpAdd", "rare", "rareRank", "traitKeys", "fiscalId", "fund", "tech", "div", "mcap"];

/** latest.json 1 銘柄ぶん → 日次に載せる薄い形 */
export function thinStock(s) {
  const t = {};
  for (const k of THIN_NUM) if (s[k] !== undefined && s[k] !== null) t[k] = s[k];
  for (const k of THIN_KEEP) if (s[k] !== undefined) t[k] = s[k];
  for (const k of THIN_FALSY) if (s[k]) t[k] = s[k];
  return t;
}

/** latest.json 全体 → 日次に書く薄い形 */
export function thinSnapshot(out) {
  const stocks = {};
  for (const [code, s] of Object.entries(out.stocks)) stocks[code] = thinStock(s);
  return {
    schemaVersion: out.schemaVersion,
    kind: DAILY_KIND,
    date: out.date,
    generatedAt: out.generatedAt,
    source: out.source,
    marketOpen: out.marketOpen,
    market: out.market,
    counts: out.counts,
    splits: out.splits,
    stocks
  };
}

/** index.json を書く。行数の増え方が素直なので差分が読める形（2 字下げ）にしておく */
export function writeIndex(idx) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(INDEX, JSON.stringify(idx, null, 2) + "\n", "utf8");
  return idx;
}

async function main() {
  if (!existsSync(UNIVERSE)) throw new Error("kabu/universe.json がありません。先に build-universe.mjs を回してください");
  const universe = JSON.parse(readFileSync(UNIVERSE, "utf8"));
  const prev = existsSync(LATEST) ? JSON.parse(readFileSync(LATEST, "utf8")) : null;

  let codes = Object.keys(universe.stocks).filter((c) => universe.stocks[c].listed);
  const limit = Number(arg("--limit", 0));
  if (limit > 0) codes = codes.slice(0, limit);
  const conc = Math.max(1, Number(arg("--conc", DEFAULT_CONC)) || DEFAULT_CONC);

  // 素体の計算式（src/kabu-core.js）は取得より先に用意しておく。
  // ここで落ちるなら何十分もかけて取ったあとではなく最初に落ちてほしい。
  const { KB } = await loadCore();

  console.log(`[prices] ${codes.length} 銘柄 + 日経平均 を ${source.NAME} から取得（同時 ${conc} 本）`);

  // 日経平均（暴落の日・祭りの日の判定）。これが取れないと市場全体のイベントが出せないが、
  // 銘柄側は取れるので致命ではない（nk225Chg = 0 として続ける）。
  // 1 年ぶん取るのは、ベータ（日経への感応度）を銘柄ごとに出すため（§15 の気質）。
  let nk = null, marketRet = new Map();
  try {
    nk = await source.fetchDaily(NK225_SYMBOL, { range: "1y" });
    for (const x of returnsOf(nk.rows)) marketRet.set(x.date, x.r);
    console.log(`[prices] 日経平均 ${nk.rows.length} 営業日ぶん（ベータの基準に ${marketRet.size} 日を使います）`);
  } catch (e) {
    console.log(`[prices] 日経平均が取れません（${e.message}）— nk225Chg は 0、ベータは 1 として続けます`);
  }

  const results = await pool(codes, conc, async (code) => {
    try {
      const d = await source.fetchDaily(code, { range: "1y" });
      return { code, ok: true, data: d };
    } catch (e) {
      return { code, ok: false, error: e.message };
    }
  }, "prices");

  const okCount = results.filter((r) => r.ok).length;
  console.log(`[prices] 取得成功 ${okCount} / ${codes.length}`);

  // 全体の失敗（取得元が止まった）なら latest.json を更新しない（§2.1）。
  // 全上場企業になると「Yahoo に無い銘柄」が常に一定数いるので、絶対値の閾値だけでは
  // 判断できない。前回どれだけ取れていたかと比べて、急に減ったら取得元の異常とみなす。
  if (okCount === 0) throw new Error("1 銘柄も取得できませんでした。latest.json は更新しません");
  if (okCount < codes.length * 0.5) {
    throw new Error(`取得できたのが ${okCount} / ${codes.length} で半分未満です。取得元の異常とみなし latest.json は更新しません`);
  }
  const prevFetched = prev && prev.counts ? Number(prev.counts.fetched) || 0 : 0;
  // --limit で一部だけ回した時は前回と比べても意味がないので見ない
  if (!limit && prevFetched > 0 && okCount < prevFetched * 0.8) {
    throw new Error(`取得できたのが ${okCount} 件で、前回の ${prevFetched} 件から 2 割以上減りました。` +
      `取得元の異常とみなし latest.json は更新しません（上場廃止が本当に増えたのなら手で 1 度回してください）`);
  }

  // 市場の日付 = 取れた銘柄の最新日付の最多値（1 銘柄だけ配信が遅れていても引っ張られない）
  const dateVotes = new Map();
  for (const r of results) {
    if (!r.ok || !r.data.rows.length) continue;
    const d = r.data.rows[r.data.rows.length - 1].date;
    dateVotes.set(d, (dateVotes.get(d) || 0) + 1);
  }
  const marketDate = [...dateVotes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0][0];
  const prevDate = prev && prev.date ? prev.date : null;
  const marketOpen = prevDate ? marketDate > prevDate : true;
  console.log(`[prices] 市場日付 ${marketDate}${prevDate ? `（前回 ${prevDate}）` : ""} marketOpen=${marketOpen}`);

  const stocks = {};
  const splitEvents = [];
  const droppedSplits = [];
  const unusable = [];
  const badMcap = [];
  let staleCount = 0, suspectCount = 0, techCount = 0;

  for (const r of results) {
    const code = r.code;
    const before = prev && prev.stocks ? prev.stocks[code] : null;

    if (!r.ok) {
      // 1 銘柄の失敗は前回の値を引き継いで stale を進める（§2.1）
      if (before) {
        stocks[code] = Object.assign({}, before, { stale: (Number(before.stale) || 0) + 1 });
        staleCount++;
      } else {
        console.log(`[prices] ${code} は取得できず前回値もありません（${r.error}）— 今回は入れません`);
      }
      continue;
    }

    const fin = readFin(code);
    const st = deriveState(r.data.rows, fin);
    if (!st) {
      if (before) { stocks[code] = Object.assign({}, before, { stale: (Number(before.stale) || 0) + 1 }); staleCount++; }
      continue;
    }

    // 気質（§15）。日足 1 年から計算するので追加の通信は無い。
    // 上場直後などで日足が足りない銘柄は付かない（その場合ゲーム側は標準の気質として扱う）。
    const tech = technicals(r.data.rows, marketRet);
    if (tech) { st.tech = tech; techCount++; }

    const short = universe.stocks[code] ? universe.stocks[code].short : "";

    // 桁の狂った終値は suspect 扱い。§2.1 のとおり前回値を使うが、前回値まで同じく壊れている
    // なら latest.json に入れない（壊れた値を stale で永久に引き継いでしまうため）
    if (!isUsableClose(st.close)) {
      const canCarry = before && isUsableClose(Number(before.close));
      unusable.push(`${code} ${short} close=${st.close}` +
        (canCarry ? `（前回値 ${before.close} を使います）` : "（使える前回値が無いので latest.json に入れません）"));
      if (canCarry) {
        stocks[code] = Object.assign({}, before, { suspect: true, stale: (Number(before.stale) || 0) + 1 });
        staleCount++; suspectCount++;
      }
      continue;
    }

    // 時価総額が桁違いなら発行済株式数が壊れている。0 にして体力・レア度・上位 10 から外す
    // （終値は正しいので銘柄そのものは残す）
    if (!isUsableMcap(st.mcap)) {
      badMcap.push(`${code} ${short} mcap=${(st.mcap / 1e12).toFixed(0)} 兆円`);
      st.mcap = 0;
    }

    // 分割・併合（§8.3）。Yahoo は分割イベントを直接くれるのでそれを使う。
    // ただし比が常識の範囲を外れているものは取り込まない（落としたことはログに残す）
    let todaySplit = (r.data.splits || []).find((s) => s.date === st.date) || null;
    if (todaySplit && !isSaneSplit(todaySplit)) {
      droppedSplits.push(`${code} ${universe.stocks[code] ? universe.stocks[code].short : ""} ` +
        `${todaySplit.numerator}:${todaySplit.denominator}（比 ${todaySplit.ratio}）`);
      todaySplit = null;
    }
    if (todaySplit) {
      splitEvents.push({ code, date: todaySplit.date, ratio: todaySplit.ratio, numerator: todaySplit.numerator, denominator: todaySplit.denominator });
      st.split = todaySplit.ratio;
      // 分割当日は「テンション」「荒れ」の判定を無効化（見かけの急落は実体ではない）
      st.chg1 = 0;
      st.range = 0;
    }

    st.suspect = looksSuspect(st, !!todaySplit);
    if (st.suspect) {
      suspectCount++;
      if (before) {
        // 疑わしい日はその銘柄だけ前回値を使う（§2.1）
        stocks[code] = Object.assign({}, before, { suspect: true, stale: (Number(before.stale) || 0) + 1 });
        continue;
      }
    }

    // 年間 1 株配当（§4.1 の div）。日足と一緒に配当イベントが返ってくるので、ここで拾って
    // latest.json に載せる。fetch-fin.mjs はこれを使い回して配当のための再取得をしない（§8.8）
    const div = annualDividend(r.data.dividends, st.date);
    if (div > 0) st.div = div;   // 無配は書かない（キーが無い＝0）

    // 丸め（latest.json を小さく保つ。ゲームは小数第 4 位まであれば足りる）
    for (const k of ["chg1", "chgYtd", "ytdPos", "volRatio", "range", "dev25"]) st[k] = round4(st[k]);
    stocks[code] = st;
  }

  // 同属性の PER / PBR 中央値（§5.1 の「粘り」「期待」の基準）
  const byElem = new Map();
  for (const [code, s] of Object.entries(stocks)) {
    const e = universe.stocks[code] ? universe.stocks[code].elem : 4;
    if (!byElem.has(e)) byElem.set(e, { per: [], pbr: [] });
    if (s.per != null) byElem.get(e).per.push(s.per);
    if (s.pbr != null) byElem.get(e).pbr.push(s.pbr);
  }
  const elemMedian = new Map([...byElem].map(([e, v]) => [e, { per: round2(median(v.per)), pbr: round2(median(v.pbr)) }]));
  for (const [code, s] of Object.entries(stocks)) {
    const e = universe.stocks[code] ? universe.stocks[code].elem : 4;
    const m = elemMedian.get(e) || { per: 0, pbr: 0 };
    s.sectorPer = m.per; s.sectorPbr = m.pbr;
  }

  // ── 素体を焼き込む（設計書 §1）──────────────────────────────
  // ゲームが読むのは latest.json・universe.json・moves.json だけ、という約束を守るために、
  // 決算 → ステータスの計算はここで済ませる。式は src/kabu-core.js のものをそのまま使う
  // （ブラウザと Node で同じソースが動く。ここで数式を書き直すと必ずずれる）。
  // 技は焼き込まない（moves.json からゲーム側で組める。二重に持つと必ず食い違う）。
  //
  // 時価総額 上位 10（§4.5 の特性「大御所」）。全銘柄の mcap が出そろってから決める。
  // 壊れた時価総額は上で 0 にしてあるので、ここは素直に上から 10 件でよい
  const top10 = new Set(
    Object.entries(stocks)
      .filter(([, s]) => Number(s.mcap) > 0)
      .sort((a, b) => Number(b[1].mcap) - Number(a[1].mcap))
      .slice(0, 10).map(([c]) => c)
  );

  let provisionalCount = 0;
  for (const [code, s] of Object.entries(stocks)) {
    // 前回値を引き継いだ銘柄（stale / suspect）には前回の焼き込みが残っている。
    // 「キーが無い＝false」の約束なので、消してから焼き直さないと古い true が生き残る
    for (const k of ["provisional", "mcapTop10", "earnings", "fiscalId"]) delete s[k];

    const fin = readFin(code);
    if (!fin) provisionalCount++;
    // moves は渡さない（技は焼き込まないので、組んだ結果 b.moves は捨てる）
    const b = KB.buildFromStock({
      code, u: universe.stocks[code] || {}, fin, state: s,
      moves: null, date: marketDate, mcapTop10: top10.has(code)
    });
    s.stats = b.stats;
    s.hp = b.kabu.hp;
    s.hpAdd = b.hpAdd;
    s.rare = round4(b.kabu.rare);
    s.rareRank = b.kabu.rareRank;
    s.traitKeys = b.kabu.traitKeys;
    if (b.kabu.provisional) s.provisional = true;   // 決算が無い銘柄（キーが無い＝決算あり）
    if (top10.has(code)) s.mcapTop10 = true;

    // 今日のお題（設計書 §16）の判定に要る決算 3 項目。ゲームは銘柄ごとの fin/*.json を
    // 一括では読まない（3,700 ファイル）ので、ここで 3 つだけ載せておく。
    // 売上成長率・営業利益率・自己資本比率。1 銘柄 20 バイトほど。
    for (const k of ["fund"]) delete s[k];
    if (fin && Number(fin.sales) > 0) {
      s.fund = {
        g: round4(Number(fin.salesGrowth) || 0),
        opm: round4(Number(fin.op) / Number(fin.sales)),
        eq: round4(Number(fin.eqRatio) || 0)
      };
    }

    // 決算発表日（推定）。calendar.json（J-Quants 前提）に届かないので、設計書 §2 の
    // 「前回発表日 + 3 か月で推定」に沿って決算期末からの経過日数で立てる。
    // 日付の計算は src/kabu-core.js のものを呼ぶだけにする（ここで書き直すと必ずずれる）。
    // 判定は「日付とその銘柄の fiscalId」だけで決まる（＝いつ取得を回したかに依らない）。
    // latest.json に焼き込んだ値を validate.mjs が同じ関数で再計算して照合するので、
    // ここに別の規則を混ぜると必ず食い違う。週 1 回しか決算を取りに行かない遅れは
    // KB 側の窓（前 1 日・後ろ 8 日）が吸収する。
    if (fin && fin.fiscalId) {
      s.fiscalId = String(fin.fiscalId);
      if (KB.isEarningsDay(marketDate, s.fiscalId)) s.earnings = true;   // キーが無い＝決算日でない
    }
  }
  const earningsCount = Object.values(stocks).filter((s) => s.earnings).length;
  console.log(`[prices] 素体を焼き込み: ${Object.keys(stocks).length} 銘柄` +
    `（決算が無く暫定素体のまま ${provisionalCount} 件・時価総額上位 10 = ${[...top10].join(" ")}）`);
  console.log(`[prices] 決算発表日（推定）に当たる銘柄 ${earningsCount} 件`);

  const nkRows = nk ? nk.rows : [];
  const nk225Chg = nkRows.length >= 2 ? round4(nkRows[nkRows.length - 1].close / nkRows[nkRows.length - 2].close - 1) : 0;

  const out = {
    schemaVersion: 1,
    date: marketDate,
    generatedAt: new Date().toISOString(),
    source: source.NAME,
    marketOpen,
    market: {
      nk225: nkRows.length ? round2(nkRows[nkRows.length - 1].close) : null,
      nk225Chg,
      crash: nk225Chg <= -0.03,
      festival: nk225Chg >= 0.03
    },
    counts: {
      stocks: Object.keys(stocks).length, fetched: okCount,
      stale: staleCount, suspect: suspectCount, provisional: provisionalCount
    },
    splits: splitEvents,
    stocks
  };

  console.log(`[prices] 日経平均 ${out.market.nk225}（${(nk225Chg * 100).toFixed(2)}%）` +
    `${out.market.crash ? " 暴落の日" : ""}${out.market.festival ? " 祭りの日" : ""}`);
  if (splitEvents.length) console.log(`[prices] 分割・併合 ${splitEvents.length} 件: ` + splitEvents.map((s) => `${s.code} ${s.numerator}:${s.denominator}`).join(", "));
  if (unusable.length) {
    console.log(`[prices] 1 株 100 万円を超える終値を ${unusable.length} 件弾きました（配信事故）:`);
    for (const u of unusable.slice(0, 10)) console.log(`    ${u}`);
    if (unusable.length > 10) console.log(`    …他 ${unusable.length - 10} 件`);
  }
  if (badMcap.length) {
    console.log(`[prices] 時価総額が 200 兆円を超える銘柄を ${badMcap.length} 件、mcap = 0 にしました（発行済株式数が壊れている）:`);
    for (const b of badMcap.slice(0, 10)) console.log(`    ${b}`);
    if (badMcap.length > 10) console.log(`    …他 ${badMcap.length - 10} 件`);
  }
  if (droppedSplits.length) {
    console.log(`[prices] 常識の範囲（1:10〜10:1）を外れた分割比を ${droppedSplits.length} 件落としました（latest.json には載せません）:`);
    for (const d of droppedSplits.slice(0, 10)) console.log(`    ${d}`);
    if (droppedSplits.length > 10) console.log(`    …他 ${droppedSplits.length - 10} 件`);
  }
  console.log(`[prices] 気質（ボラ・ベータ・自己相関・最大DD・売買代金）を付けた銘柄 ${techCount} 件`);
  if (staleCount) console.log(`[prices] 前回値を引き継いだ銘柄 ${staleCount} 件`);
  if (suspectCount) console.log(`[prices] 異常値として退けた銘柄 ${suspectCount} 件`);

  const json = JSON.stringify(out);
  // 日次は「薄い形 + gzip」で書く（§8.7）。全項目を生で毎日置くと git の履歴が年 450MB 増える
  const thin = JSON.stringify(thinSnapshot(out)) + "\n";
  const thinGz = gzipSync(Buffer.from(thin, "utf8"), { level: 9 });
  if (has("--dry")) {
    console.log(`[prices] --dry なので書き込みません（latest.json ${(json.length / 1024).toFixed(0)} KB・` +
      `daily ${(thinGz.length / 1024).toFixed(0)} KB＝薄い形 ${(thin.length / 1024).toFixed(0)} KB の gzip）`);
    return;
  }
  mkdirSync(DAILY_DIR, { recursive: true });
  writeFileSync(LATEST, json + "\n", "utf8");
  writeFileSync(resolve(DAILY_DIR, `${marketDate}${DAILY_EXT}`), thinGz);
  console.log(`[prices] 書き出し: latest.json ${(json.length / 1024).toFixed(0)} KB / ` +
    `daily/${marketDate}${DAILY_EXT} ${(thinGz.length / 1024).toFixed(0)} KB` +
    `（薄い形 ${(thin.length / 1024).toFixed(0)} KB = 全項目の ${(thin.length / json.length * 100).toFixed(0)}%、それを gzip）`);

  // 履歴の目録（§7.1）。daily/ を走査し直して作るので、手で消した日も自然に反映される
  const idx = writeIndex(buildIndex({ latest: marketDate }));
  console.log(`[prices] 書き出し: kabu/data/index.json（履歴 ${idx.days.length} 日` +
    `${idx.archived.length ? ` / アーカイブ済み ${idx.archived.join("・")} 年` : ""}）`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("fetch-prices.mjs")) {
  main().catch((e) => { console.error("[prices] " + e.message); process.exit(1); });
}
