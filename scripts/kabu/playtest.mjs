// scripts/kabu/playtest.mjs
// ゲーム性を数字で見るための道具。sim.mjs（不変条件の検査）とは別物で、CI では回さない。
//
// sim.mjs が見ているのは「壊れていないか」で、こちらが見るのは「遊べるか」:
//   ・初日のパーティで勝ちすぎ／負けすぎていないか
//   ・資金が増えすぎて、何日目に「何でも買える」状態になるか
//   ・パーティを強くする意味があるか（相手が自分に合わせてくるので、意味が消えていないか）
//   ・毎朝の予想が勝敗を動かしているか
//   ・日替わり相手がどれくらいばらけるか（毎日同じ顔ぶれになっていないか）
//
// 実データは 1 日ぶんしか無いので、そこから先は株価をランダムウォークさせて作る。
// 目的はバランスを見ることなので、値動きが本物である必要はない（分布が妥当であればよい）。
//
// 使い方:
//   node scripts/kabu/playtest.mjs              … 既定（200 日 × 40 回）
//   node scripts/kabu/playtest.mjs --days 60    … 日数
//   node scripts/kabu/playtest.mjs --runs 10    … 試行回数
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./vendor-cb.mjs";
import { loadCore } from "./load.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const DAYS = arg("--days", 200);
const RUNS = arg("--runs", 40);
const INITIAL_CASH = 300000;
// ゲーム本体（src/template.html）と同じ値にしておくこと
const UNIT = 100;                            // 1 口 = 1 単元 = 100 株
const WIN_MIN = 5000, WIN_MAX = 50000;       // 勝利報酬
const PREDICT_REWARD = 3000;                 // 予想の的中 1 体ぶん

const { CB, KB } = await loadCore();

const KABU = resolve(ROOT, "kabu");
const universe = JSON.parse(readFileSync(resolve(KABU, "universe.json"), "utf8"));
const latest0 = JSON.parse(readFileSync(resolve(KABU, "data", "latest.json"), "utf8"));
const moves = existsSync(resolve(KABU, "moves.json")) ? JSON.parse(readFileSync(resolve(KABU, "moves.json"), "utf8")) : null;

const FIN_DIR = resolve(KABU, "data", "fin");
const fin = Object.create(null);
for (const f of existsSync(FIN_DIR) ? readdirSync(FIN_DIR) : []) {
  if (!f.endsWith(".json")) continue;
  try { fin[f.slice(0, -5)] = JSON.parse(readFileSync(resolve(FIN_DIR, f), "utf8")).ttm; } catch { }
}

// ══════════════ 決定論的な乱数（試行を再現できるように）══════════════
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15); t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ══════════════ 市場を 1 日進める ══════════════
// 日次ボラティリティ 2%（東証の大型株でおおむねこのあたり）。銘柄ごとの癖は付けない。
const SIGMA = 0.02;

/** latest.json から、歩かせるのに必要な最小限の状態を取り出す */
function initMarket(latest) {
  const m = new Map();
  for (const [code, s] of Object.entries(latest.stocks)) {
    const close = Number(s.close);
    if (!(close > 0)) continue;
    m.set(code, {
      close,
      base: Number(s.chgYtd) > -1 ? close / (1 + Number(s.chgYtd)) : close,   // 年初の終値
      sma25: Number(s.sma25) > 0 ? Number(s.sma25) : close,
      ytdHigh: Number(s.ytdHigh) > 0 ? Number(s.ytdHigh) : close,
      ytdLow: Number(s.ytdLow) > 0 ? Number(s.ytdLow) : close,
      eps: Number(s.per) > 0 ? close / Number(s.per) : 0,
      bps: Number(s.pbr) > 0 ? close / Number(s.pbr) : 0,
      shares: Number(s.mcap) > 0 ? Number(s.mcap) / close : 0,
      // 焼き込まれた素体はそのまま使う（決算は四半期に 1 回しか変わらないので日々は動かない）
      baked: s
    });
  }
  return m;
}

const LIMIT_TABLE = [
  [100, 30], [200, 50], [500, 80], [700, 100], [1000, 150], [1500, 300], [2000, 400],
  [3000, 500], [5000, 700], [7000, 1000], [10000, 1500], [15000, 3000], [20000, 4000],
  [30000, 5000], [50000, 7000], [70000, 10000], [100000, 15000]
];
const priceLimit = (b) => {
  for (const [c, w] of LIMIT_TABLE) if (b < c) return w;
  return 30000;
};

/** 1 日進めて、その日の latest.json 相当を作る */
function stepMarket(m, r, date, prevNk) {
  const nkShock = gauss(r) * 0.01;                 // 市場全体の動き
  const stocks = {};
  for (const [code, st] of m) {
    const prevClose = st.close;
    const z = gauss(r);
    let close = prevClose * Math.exp(nkShock + SIGMA * z - SIGMA * SIGMA / 2);
    // 値幅制限で止める（ストップ高・ストップ安が出るように）
    const w = priceLimit(prevClose);
    close = Math.min(prevClose + w, Math.max(prevClose - w, close));
    close = Math.max(1, Math.round(close * 10) / 10);

    st.close = close;
    st.sma25 += (close - st.sma25) / 25;
    st.ytdHigh = Math.max(st.ytdHigh, close);
    st.ytdLow = Math.min(st.ytdLow, close);

    const span = st.ytdHigh - st.ytdLow;
    const volRatio = Math.exp(gauss(r) * 0.45);
    stocks[code] = Object.assign({}, st.baked, {
      close, prevClose,
      chg1: close / prevClose - 1,
      chgYtd: st.base > 0 ? close / st.base - 1 : 0,
      ytdPos: span > 0 ? (close - st.ytdLow) / span : 0.5,
      volRatio,
      range: Math.abs(gauss(r)) * 0.015,
      dev25: st.sma25 > 0 ? close / st.sma25 - 1 : 0,
      limitUp: close >= prevClose + w - 1e-9,
      limitDown: close <= prevClose - w + 1e-9,
      per: st.eps > 0 ? close / st.eps : null,
      pbr: st.bps > 0 ? close / st.bps : null,
      mcap: st.shares > 0 ? close * st.shares : 0,
      stale: 0, suspect: false
    });
  }
  // 同属性の PER・PBR 中央値（§5.1 の「粘り」「期待」の基準）
  const byElem = new Map();
  for (const [code, s] of Object.entries(stocks)) {
    const e = universe.stocks[code] ? universe.stocks[code].elem : 4;
    if (!byElem.has(e)) byElem.set(e, { per: [], pbr: [] });
    if (s.per) byElem.get(e).per.push(s.per);
    if (s.pbr) byElem.get(e).pbr.push(s.pbr);
  }
  const med = (a) => { if (!a.length) return 0; const v = a.slice().sort((x, y) => x - y); const i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
  const table = new Map([...byElem].map(([e, v]) => [e, { per: med(v.per), pbr: med(v.pbr) }]));
  for (const [code, s] of Object.entries(stocks)) {
    const e = universe.stocks[code] ? universe.stocks[code].elem : 4;
    const t = table.get(e) || { per: 0, pbr: 0 };
    s.sectorPer = t.per; s.sectorPbr = t.pbr;
  }

  const nk = prevNk * Math.exp(nkShock);
  return {
    day: { schemaVersion: 1, date, marketOpen: true, market: { nk225: nk, nk225Chg: nkShock, crash: nkShock <= -0.03, festival: nkShock >= 0.03 }, stocks },
    nk
  };
}

// ══════════════ 個体を組む ══════════════
const beastOf = (code, day, extra, unlocked) => {
  const b = KB.buildFromStock({ code, u: universe.stocks[code], fin: fin[code] || null, state: day.stocks[code], moves, date: day.date, unlocked });
  const mods = KB.stateMods(day.stocks[code], day.market, extra || {});
  return KB.applyMods(b, mods);
};

// ══════════════ 手の打ち方（戦略）══════════════
// どれも「毎日ゲームを開いて、その日のぶんを精算する」プレイヤー。違いは買い方と予想の有無。
const STRATEGIES = {
  "初日の3体を使い続ける": { upgrade: "never", predict: false },
  "買えるうちで一番強いのに乗り換える": { upgrade: "greedy", predict: false },
  "同上＋毎朝の予想あり": { upgrade: "greedy", predict: true },
  "適当に3体": { upgrade: "random", predict: false }
};

const RARE_VAL = { SS: 6, S: 5, A: 4, B: 3, C: 2, D: 1 };
const rareOf = (code, day) => RARE_VAL[(day.stocks[code] && day.stocks[code].rareRank) || "D"] || 1;

/** 買えるものの中から良さそうな 3 体を選ぶ。属性がばらけるように 1 体ずつ埋める */
function pickParty(day, budget, how, r) {
  const codes = Object.keys(day.stocks).filter((c) => universe.stocks[c] && universe.stocks[c].listed);
  if (how === "random") {
    const out = [];
    const cheap = codes.filter((c) => day.stocks[c].close * UNIT <= budget / 3);
    const pool = cheap.length >= 3 ? cheap : codes;
    for (let i = 0; i < 3 && pool.length; i++) out.push(pool[Math.floor(r() * pool.length)]);
    return out;
  }
  const affordable = codes.filter((c) => day.stocks[c].close * UNIT <= budget / 3);
  const pool = (affordable.length >= 3 ? affordable : codes)
    .slice().sort((a, b) => rareOf(b, day) - rareOf(a, day) || (a < b ? -1 : 1));
  const out = [], used = new Set();
  for (const c of pool) {
    const e = universe.stocks[c].elem;
    if (used.has(e)) continue;
    out.push(c); used.add(e);
    if (out.length === 3) break;
  }
  while (out.length < 3 && pool.length) out.push(pool[out.length]);
  return out;
}

// ══════════════ 1 試行 ══════════════
function play(strategyName, seed) {
  const cfg = STRATEGIES[strategyName];
  const r = rng(seed);
  const m = initMarket(latest0);
  let nk = Number(latest0.market.nk225) || 40000;

  let cash = INITIAL_CASH;
  const holdings = new Map();     // code -> {units, cost}  cost は 1 口（100 株）あたり
  let party = [];
  const log = [];
  let wins = 0, games = 0, hits = 0, misses = 0;
  const foeSeen = new Map();
  let affWins = 0, affGames = 0, disWins = 0, disGames = 0;

  const valueOf = (day) => [...holdings].reduce((s, [c, h]) => s + (day.stocks[c] ? day.stocks[c].close * UNIT * h.units : 0), 0);
  const buy = (code, day) => {
    const p = day.stocks[code].close * UNIT;
    if (cash < p) return false;
    cash -= p;
    const h = holdings.get(code);
    if (h) { h.cost = (h.cost * h.units + p) / (h.units + 1); h.units++; }
    else holdings.set(code, { units: 1, cost: p });
    return true;
  };
  const sell = (code, day) => {
    const h = holdings.get(code);
    if (!h || !day.stocks[code]) return;
    cash += day.stocks[code].close * UNIT * h.units;
    holdings.delete(code);
  };

  for (let d = 0; d < DAYS; d++) {
    const date = new Date(Date.UTC(2026, 8, 28) + d * 86400000).toISOString().slice(0, 10);
    const stepped = stepMarket(m, r, date, nk);
    const day = stepped.day; nk = stepped.nk;

    // ── 編成 ──
    if (cfg.upgrade !== "never" || party.length < 3) {
      const budget = cash + valueOf(day);
      const want = pickParty(day, budget, cfg.upgrade, r);
      // いま持っていて要らないものを手放してから買う（資金を作る）
      for (const c of [...holdings.keys()]) if (!want.includes(c)) sell(c, day);
      const got = [];
      for (const c of want) { if (holdings.has(c) || buy(c, day)) got.push(c); }
      if (got.length === 3) party = got;
      else if (party.length < 3) party = got;
    }
    if (party.length < 3) { log.push({ d, cash, equity: cash + valueOf(day), win: null, rare: 0 }); continue; }

    // ── 予想（機械の予想と同じ単純ルール: 25 日線の上なら上）──
    const extras = {};
    for (const c of party) {
      if (!cfg.predict) { extras[c] = {}; continue; }
      const guess = day.stocks[c].dev25 >= 0 ? "up" : "down";
      const chg = day.stocks[c].chg1;
      const actual = chg > 0.003 ? "up" : chg < -0.003 ? "down" : "flat";
      if (actual === "flat") { extras[c] = {}; continue; }
      if (guess === actual) { extras[c] = { hit: true }; hits++; cash += PREDICT_REWARD; }
      else { extras[c] = { hit: false }; misses++; }
    }

    // ── 対戦 ──
    const mine = party.map((c) => beastOf(c, day, extras[c]));
    const p = KB.protagonists(day);
    const foeCodes = [p.up, p.hot, p.down].filter(Boolean);
    while (foeCodes.length < 3) foeCodes.push(foeCodes[0]);
    for (const c of foeCodes.slice(0, 3)) foeSeen.set(c, (foeSeen.get(c) || 0) + 1);
    const myRare = mine.reduce((s, b) => s + b.kabu.rare, 0) / 3;
    const foes = foeCodes.slice(0, 3).map((c) => { const b = beastOf(c, day, {}); return KB.scaleToParty(b, myRare, b.kabu.rare); });

    const res = CB.squadMatch(KB.squadOf(mine), KB.squadOf(foes), KB.hashStr(date));
    const win = res.scoreA > res.scoreB;
    games++; if (win) wins++;

    // 属性相性が実際に効いているか（前衛どうしの相克・被克で分ける）
    const a = CB.affinity(mine[0].elem, foes[0].elem);
    if (a > 1.1) { affGames++; if (win) affWins++; }
    else if (a < 0.9) { disGames++; if (win) disWins++; }

    if (win) {
      const strength = foes.reduce((s, b) => s + b.total, 0) / 3;
      cash += Math.round(WIN_MIN + Math.max(0, Math.min(1, (strength - 30) / 60)) * (WIN_MAX - WIN_MIN));
    }

    log.push({ d, cash, equity: cash + valueOf(day), win, rare: myRare, party: party.slice() });
  }

  return { strategyName, wins, games, hits, misses, log, foeSeen, affWins, affGames, disWins, disGames };
}

// ══════════════ 集計 ══════════════
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + "%" : "—");
const yen = (v) => Math.round(v).toLocaleString("ja-JP");

console.log(`株バトル 遊び心地の測定  — ${DAYS} 日 × ${RUNS} 回  （収録 ${Object.keys(universe.stocks).length} 銘柄・1 口 = ${UNIT} 株）\n`);

for (const name of Object.keys(STRATEGIES)) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(play(name, 1000 + i * 7919));

  const games = runs.reduce((s, r) => s + r.games, 0);
  const wins = runs.reduce((s, r) => s + r.wins, 0);
  console.log(`── ${name} ──`);
  console.log(`  通算勝率 ${pct(wins, games)}（${games} 戦）`);

  const buckets = [[0, 20], [20, 60], [60, 120], [120, DAYS]].filter(([a]) => a < DAYS);
  const line = buckets.map(([a, b]) => {
    let w = 0, g = 0;
    for (const r of runs) for (const e of r.log) if (e.win != null && e.d >= a && e.d < b) { g++; if (e.win) w++; }
    return `${a + 1}〜${Math.min(b, DAYS)}日 ${pct(w, g)}`;
  });
  console.log(`  期間別   ${line.join(" / ")}`);

  const med = (arr) => { const v = arr.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  const at = (d) => med(runs.map((r) => (r.log[d] ? r.log[d].equity : null)));
  const marks = [0, 19, 59, DAYS - 1].filter((d, i, a) => d < DAYS && a.indexOf(d) === i);
  console.log(`  総資産   ` + marks.map((d) => `${d + 1}日 ${yen(at(d))}`).join(" → ") + " 円（中央値）");

  const rareAt = (d) => {
    const v = runs.map((r) => (r.log[d] && r.log[d].rare ? r.log[d].rare : null)).filter((x) => x != null);
    return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) : "—";
  };
  console.log(`  パーティのレア度  初日 ${rareAt(0)} → ${Math.min(60, DAYS)}日 ${rareAt(Math.min(59, DAYS - 1))} → ${DAYS}日 ${rareAt(DAYS - 1)}`);

  const aw = runs.reduce((s, r) => s + r.affWins, 0), ag = runs.reduce((s, r) => s + r.affGames, 0);
  const dw = runs.reduce((s, r) => s + r.disWins, 0), dg = runs.reduce((s, r) => s + r.disGames, 0);
  console.log(`  前衛の相性  相克で当たった日 ${pct(aw, ag)}（${ag} 戦） / 被克 ${pct(dw, dg)}（${dg} 戦）`);

  if (STRATEGIES[name].predict) {
    const h = runs.reduce((s, r) => s + r.hits, 0), mi = runs.reduce((s, r) => s + r.misses, 0);
    console.log(`  予想の的中  ${pct(h, h + mi)}（的中 ${h} / 外れ ${mi}）`);
  }

  const seen = new Map();
  for (const r of runs) for (const [c, n] of r.foeSeen) seen.set(c, (seen.get(c) || 0) + n);
  const total = [...seen.values()].reduce((s, x) => s + x, 0);
  const top = [...seen].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log(`  相手の顔ぶれ  のべ ${seen.size} 銘柄。最頻 ${top.map(([c, n]) => `${universe.stocks[c] ? universe.stocks[c].short : c}(${pct(n, total)})`).join(" ")}`);
  console.log("");
}
