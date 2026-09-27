// scripts/kabu/sim.mjs
// 設計書 §11 の「長期運用のための自動テスト」。PR / push で回す（.github/workflows/kabu-check.yml）。
//
//   決定論・A/B 対称・停止性・状態係数の clamp・勝率曲線・分割検出・精算の順序非依存。
//
// 実データが無くても回るよう合成データ（fixtures.mjs）で検証する。実データがあれば
// そちらも読んで同じ不変条件を確かめる。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCore } from "./load.mjs";
import { ROOT } from "./paths.mjs";
import { synth, synthMoves, synthSplits, rng } from "./fixtures.mjs";

let pass = 0, warn = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${msg}${detail ? "  — " + detail : ""}`); }
};
const soft = (cond, msg, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail ? "  — " + detail : ""}`); }
  else { warn++; console.log(`  WARN  ${msg}${detail ? "  — " + detail : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

const { CB, KB } = await loadCore();
console.log(`株バトル シム  — エンジンは src/engine.js（株バトルに同梱）`);

const SECTORS = KB.sectors();
const { universe, fin, latest } = synth(120, SECTORS, 20260926);
const moves = synthMoves(SECTORS);
const codes = Object.keys(universe.stocks);

const buildAt = (code, date, unlocked) => KB.buildFromStock({
  code, u: universe.stocks[code], fin: fin[code], state: latest.stocks[code],
  moves, date: date || latest.date, unlocked
});
const todayOf = (code) => {
  const base = buildAt(code);
  return KB.applyMods(base, KB.stateMods(latest.stocks[code], latest.market, {}));
};

// ══════════════ 1. 業種と属性 ══════════════
section("1. 業種 → 五行");
ok(SECTORS.length === 33, "対応表は 33 業種ちょうど", `${SECTORS.length} 件`);
ok(SECTORS.every((s) => KB.sectorElem(s) >= 0 && KB.sectorElem(s) <= 4), "全業種が 0..4 の属性に落ちる");
{
  // 設計書 §4.3 の覚え文が相克（CB の d=2・最も有利）になっていること
  const chain = [
    ["輸送用機器", "化学"],        // 製造 → 素材
    ["化学", "食料品"],            // 素材 → 生活
    ["食料品", "電気機器"],        // 生活 → 情報
    ["電気機器", "銀行業"],        // 情報 → 金融
    ["銀行業", "輸送用機器"]       // 金融 → 製造
  ];
  const mults = chain.map(([a, b]) => CB.affinity(KB.sectorElem(a), KB.sectorElem(b)));
  ok(mults.every((m) => m > 1.12), "「製造→素材→生活→情報→金融→製造」がすべて相克（×1.13）",
    mults.map((m) => m.toFixed(2)).join(" "));
  // 五行そのものの相克（木剋土・土剋水・水剋火・火剋金・金剋木）と一致していること
  const ring = [[KB.WOOD, KB.EARTH], [KB.EARTH, KB.WATER], [KB.WATER, KB.FIRE], [KB.FIRE, KB.METAL], [KB.METAL, KB.WOOD]];
  ok(ring.every(([a, b]) => CB.affinity(a, b) > 1.12), "本物の五行相克と一致している");
  const counts = {};
  for (const s of SECTORS) { const e = KB.sectorElem(s); counts[e] = (counts[e] || 0) + 1; }
  ok(Object.keys(counts).length === 5, "5 属性すべてに業種が割り当てられている",
    CB.ELEMENTS.map((el, i) => `${el.name}${counts[i] || 0}`).join(" "));
}
ok(KB.normSector("石油石炭製品") === "石油・石炭製品" && KB.sectorElem("情報通信業") === KB.sectorElem("情報・通信業"),
  "業種名の表記ゆれを吸収する");

// ══════════════ 2. 素体 ══════════════
section("2. 素体（決算 → ステータス）");
{
  let inRange = true, provOk = true;
  for (const code of codes) {
    const b = buildAt(code);
    for (const k of CB.STAT_KEYS) if (b.stats[k] < 24 || b.stats[k] > 100) inRange = false;
    const p = KB.buildFromStock({ code, u: universe.stocks[code], fin: null, state: latest.stocks[code], moves, date: latest.date });
    for (const k of CB.STAT_KEYS) if (p.stats[k] < 24 || p.stats[k] > 100) provOk = false;
    if (!p.kabu.provisional) provOk = false;
  }
  ok(inRange, "全銘柄のステータスが 24..100 に収まる");
  ok(provOk, "決算が無い銘柄は暫定素体（24..100・provisional フラグ）で埋まる");

  const b = buildAt(codes[0]);
  ok(b.kabu.hp >= 24 && b.kabu.hp <= 100 && b.hpAdd >= 0, "体力（時価総額）が 24..100 と hpAdd に出る",
    `hp=${b.kabu.hp} hpAdd=${b.hpAdd}`);
  ok(["SS", "S", "A", "B", "C", "D"].includes(b.kabu.rareRank), "レア度が SS..D のどれかになる", b.kabu.rareRank);
  ok(b.kabu.traitKeys.length >= 1 && b.kabu.traitKeys.length <= 2, "特性は 1〜2 個", b.kabu.traitKeys.join("/"));
  ok(CB.TRAITS.some((t) => t.key === b.trait.key), "trait は CB の特性語彙のどれか", b.trait.key);

  // 金融は「守が低く見えるが体力が大きい」（業種別の下駄を履かせていないことの確認）
  const finCodes = codes.filter((c) => KB.sectorElem(universe.stocks[c].sector33) === KB.METAL);
  const others = codes.filter((c) => KB.sectorElem(universe.stocks[c].sector33) !== KB.METAL);
  const avg = (arr, f) => arr.reduce((a, c) => a + f(buildAt(c)), 0) / Math.max(1, arr.length);
  soft(avg(finCodes, (b2) => b2.stats.SPD) < avg(others, (b2) => b2.stats.SPD),
    "金融は総資産回転率が構造的に低く 速 が低めに出る",
    `金融 ${avg(finCodes, (b2) => b2.stats.SPD).toFixed(1)} / 他 ${avg(others, (b2) => b2.stats.SPD).toFixed(1)}`);
}

// ══════════════ 3. 技 ══════════════
section("3. 技");
{
  // 設計書 §6.2 の 18 種はエンジンが全部そのまま効かせる（§17 で取り込んだので丸め込みなし）
  const ENGINE = Object.keys(KB.ENGINE_KINDS);
  let allEngine = true, hasSector = true, canAttack = true, badKinds = new Set();
  for (const code of codes) {
    const b = buildAt(code);
    if (!b.moves.length) hasSector = false;
    for (const m of b.moves) if (!ENGINE.includes(m.kind)) { allEngine = false; badKinds.add(m.kind); }
    // 補助技（盾・回復・毒など）しか持たない銘柄がいると、その銘柄は永久に殴れない
    if (!b.moves.some((m) => KB.DAMAGING_KINDS[m.kind])) canAttack = false;
  }
  ok(allEngine, `moves.json の全 kind をエンジンがそのまま効かせる（${ENGINE.length} 種）`,
    badKinds.size ? `未知: ${[...badKinds].join(",")}` : "");
  ok(hasSector, "固有技が無い銘柄でも技が 1 つ以上ある（業種技で戦える）");
  ok(canAttack, "どの銘柄も攻撃手段を 1 つは持つ（補助技だけの銘柄がいない）");
  ok(b0ElemIsOwn(), "1 本目（業種技）は自分の属性（十八番）");

  // 技が 2 本しかないと 5 属性のうち 2 つしかカバーできず、相手の属性だけで勝敗が決まりすぎる
  // （エンジンの chooseMove は「相手に一番有利な技」を選ぶ）。固有技が 0〜1 本の銘柄にも
  // 業種技を足して 3 本に揃えてある（§6.3）。カバー範囲が狭まっていないか毎回見る。
  {
    const counts = codes.map((code) => buildAt(code).moves.length);
    const covers = codes.map((code) => new Set(buildAt(code).moves.map((m) => m.elem)).size);
    const lo = (a) => Math.min.apply(null, a), av = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    ok(lo(counts) >= 3, "固有技が無い銘柄でも技が 3 本ある（属性のカバー用）",
      `最少 ${lo(counts)} 本・平均 ${av(counts).toFixed(1)} 本`);
    ok(lo(covers) >= 2, "技がカバーする属性が 2 種以上ある（十八番 + カバー技）",
      `最少 ${lo(covers)} 種・平均 ${av(covers).toFixed(2)} 種`);
  }

  // 必殺技は解放条件を満たした日だけ選択肢に入る
  const mv = {
    schemaVersion: 1, sector: moves.sector,
    stocks: { [codes[0]]: { moves: [{ name: "固有A", kind: "first" }], ultimate: { name: "必殺", kind: "delay", unlock: ["awaken"] } } }
  };
  const locked = KB.buildFromStock({ code: codes[0], u: universe.stocks[codes[0]], fin: fin[codes[0]], state: latest.stocks[codes[0]], moves: mv, date: latest.date, unlocked: {} });
  const opened = KB.buildFromStock({ code: codes[0], u: universe.stocks[codes[0]], fin: fin[codes[0]], state: latest.stocks[codes[0]], moves: mv, date: latest.date, unlocked: { awaken: true } });
  ok(!locked.moves.some((m) => m.ultimate) && opened.moves.some((m) => m.ultimate),
    "必殺技は解放条件を満たした日だけ技に入る");
  ok(opened.moves.filter((m) => m.ultimate).every((m) => m.kind === "finisher"),
    "必殺技は瀕死時に出る枠（finisher）としてエンジンに見える");
}
function b0ElemIsOwn() {
  return codes.every((code) => { const b = buildAt(code); return b.moves[0].elem === b.elem; });
}

// ══════════════ 4. 状態（株価 → コンディション）══════════════
section("4. 状態");
{
  let clamped = true, baseUntouched = true;
  for (const code of codes) {
    const base = buildAt(code);
    const snapshot = JSON.stringify(base.stats);
    const mods = KB.stateMods(latest.stocks[code], latest.market, { earnings: true, exDiv: true, divYield: 0.06, streak: 4, hit: true });
    for (const k of CB.STAT_KEYS) if (mods[k] < KB.MOD_LO - 1e-9 || mods[k] > KB.MOD_HI + 1e-9) clamped = false;
    if (mods.hpMul < KB.MOD_LO - 1e-9 || mods.hpMul > KB.MOD_HI + 1e-9) clamped = false;
    KB.applyMods(base, mods);
    if (JSON.stringify(base.stats) !== snapshot) baseUntouched = false;
  }
  ok(clamped, `状態係数の積が ${KB.MOD_LO}〜${KB.MOD_HI} に収まる（状態が素体を覆い尽くさない）`);
  ok(baseUntouched, "applyMods は素体を書き換えない");

  // 向きの確認
  const s = { close: 1000, chg1: 0.07, ytdPos: 0.95, chgYtd: 0.4, volRatio: 3, range: 0.06, dev25: 0.2, per: 30, pbr: 3, sectorPer: 12, stale: 0, limitUp: true };
  const up = KB.stateMods(s, { nk225Chg: 0.04 }, {});
  ok(up.ATK > 1 && up.DEF < 1, "上げた日は攻寄り・守薄め", `攻 ×${up.ATK.toFixed(2)} 守 ×${up.DEF.toFixed(2)}`);
  ok(up.unlocked.awaken && up.unlocked.limitUp, "年初来高値圏・ストップ高で必殺技が解放される");
  ok(up.critAdd > 0 && up.order > 0, "ストップ高で会心↑・勢いで行動順↑");
  const down = KB.stateMods({ close: 1000, chg1: -0.07, ytdPos: 0.05, dev25: -0.2, volRatio: 0.5, range: 0.01, stale: 0, limitDown: true }, { nk225Chg: -0.05 }, {});
  ok(down.DEF > 1 && down.ATK < 1, "下げた日は守寄り", `攻 ×${down.ATK.toFixed(2)} 守 ×${down.DEF.toFixed(2)}`);
  ok(down.stunFirst, "ストップ安は初手行動不能");
  ok(down.hpMul < 1 && down.critAdd > 0, "逆境は体力↓・会心↑（反発の芽）");
  const stale = KB.stateMods({ close: 1000, chg1: 0.07, ytdPos: 0.99, stale: 5 }, { nk225Chg: -0.05 }, {});
  ok(CB.STAT_KEYS.every((k) => stale[k] === 1) && stale.hpMul === 1 && stale.tags.includes("消息不明"),
    "消息不明（stale ≥ 3）は状態係数がすべて 1.0（素体のまま）");
}

// ══════════════ 5. 不変条件（決定論・対称・停止）══════════════
section("5. 不変条件");
{
  const a = KB.squadOf([todayOf(codes[0]), todayOf(codes[1]), todayOf(codes[2])]);
  const b = KB.squadOf([todayOf(codes[3]), todayOf(codes[4]), todayOf(codes[5])]);
  // squadBattle の戻り値は winnerSide / turns / decision / dealtA / dealtB（winner・rounds は無い）
  const fingerprint = (r) => JSON.stringify(r.games.map((g) => [g.winnerSide, g.turns, g.decision, g.dealtA, g.dealtB, g.critsA, g.critsB]));
  const r1 = CB.squadMatch(a, b, 42), r2 = CB.squadMatch(a, b, 42);
  ok(fingerprint(r1) === fingerprint(r2) && r1.games.every((g) => g.turns > 0),
    "同じ日・同じ隊なら同じ結果（決定論）", `${r1.scoreA}-${r1.scoreB}・${r1.games.map((g) => g.turns + "T").join("/")}`);

  const rAB = CB.squadMatch(a, b, 7), rBA = CB.squadMatch(b, a, 7);
  const winnerAB = rAB.scoreA > rAB.scoreB ? "a" : "b";
  const winnerBA = rBA.scoreA > rBA.scoreB ? "b" : "a";
  ok(winnerAB === winnerBA, "A/B を入れ替えても勝者が同じ（対称）", `${winnerAB} / ${winnerBA}`);

  let stops = true, maxTurns = 0, wiped = 0, judged = 0;
  for (let i = 0; i + 6 <= codes.length; i += 6) {
    const x = KB.squadOf([todayOf(codes[i]), todayOf(codes[i + 1]), todayOf(codes[i + 2])]);
    const y = KB.squadOf([todayOf(codes[i + 3]), todayOf(codes[i + 4]), todayOf(codes[i + 5])]);
    const r = CB.squadMatch(x, y, i + 1);
    if (!r.games.length || r.games.length > 3) stops = false;
    if (r.scoreA + r.scoreB !== r.games.length || Math.max(r.scoreA, r.scoreB) !== 2) stops = false;
    for (const g of r.games) {
      if (!(g.turns >= 1 && g.turns <= 40)) stops = false;   // squadBattle の MAXR = 40
      maxTurns = Math.max(maxTurns, g.turns);
      if (g.decision === "殲滅") wiped++; else judged++;
    }
  }
  ok(stops, "どの組み合わせでも 2 本先取・各ゲーム 1〜40 ターンで終わる（停止性）",
    `最長 ${maxTurns}T・殲滅 ${wiped} / 判定 ${judged}`);

  // 日付が変わると展開が変わる（hash(date, code) が種）
  const d1 = buildAt(codes[0], "2026-09-25").hash, d2 = buildAt(codes[0], "2026-09-26").hash;
  ok(d1 !== d2, "日付が変わると個体のハッシュが変わる（日替わりの展開差）");
  ok(buildAt(codes[0], "2026-09-25").hash === buildAt(codes[0], "2026-09-25").hash, "同じ日付なら同じハッシュ");
}

// ══════════════ 6. 勝率曲線 ══════════════
section("6. 勝率曲線（レア度差 0 で 45〜55%）");
{
  const byRare = {};
  for (const code of codes) {
    const b = buildAt(code);
    (byRare[b.kabu.rareRank] = byRare[b.kabu.rareRank] || []).push(code);
  }
  const pool = Object.entries(byRare).filter(([, v]) => v.length >= 6);
  let wins = 0, games = 0;
  const r = rng(999);
  for (const [, list] of pool) {
    for (let t = 0; t < 400; t++) {
      const pick = () => list[Math.floor(r() * list.length)];
      const sa = KB.squadOf([todayOf(pick()), todayOf(pick()), todayOf(pick())]);
      const sb = KB.squadOf([todayOf(pick()), todayOf(pick()), todayOf(pick())]);
      const res = CB.squadMatch(sa, sb, t + 1);
      if (res.scoreA === res.scoreB) continue;
      games++;
      if (res.scoreA > res.scoreB) wins++;
    }
  }
  const rate = games ? wins / games : 0;
  soft(games > 0 && rate >= 0.45 && rate <= 0.55,
    "同レア度帯の勝率が 45〜55%", `${(rate * 100).toFixed(1)}%（${games} 戦・${pool.length} 帯）`);
}

// ══════════════ 7. 分割・併合の検出 ══════════════
section("7. 株式分割・併合（§8.3）");
{
  ok(JSON.stringify(KB.detectSplit(1 / 2 - 1, 3e6, 1e6)) === '{"kind":"split","n":2}', "1/2 に張り付いた日を 2 分割として検出");
  ok(KB.detectSplit(1 / 10 - 1, 5e6, 1e6).n === 10, "1/10 も検出する");
  ok(KB.detectSplit(2 - 1, 4e6, 1e6).kind === "merge", "n-1 は併合として検出");
  ok(KB.detectSplit(1 / 2 - 1, 1.2e6, 1e6) === null, "出来高が平時の 3 倍未満なら分割と見なさない");
  ok(KB.detectSplit(-0.08, 5e6, 1e6) === null, "ただの急落を分割と誤検出しない");
  ok(KB.detectSplit(1 / 3 - 1 + 0.015, 5e6, 1e6) !== null && KB.detectSplit(1 / 3 - 1 + 0.05, 5e6, 1e6) === null,
    "許容誤差は ±2%");
  const before = { units: 100, cost: 3000 };
  const after = KB.adjustHolding(before, { kind: "split", n: 5 });
  ok(after.units === 500 && after.cost === 600 && Math.abs(after.units * after.cost - before.units * before.cost) < 1e-6,
    "分割で口数 ×n・取得単価 ÷n（資金価値は保存される）", `${after.units} 口 @${after.cost}`);
  const merged = KB.adjustHolding(before, { kind: "merge", n: 2 });
  ok(Math.abs(merged.units * merged.cost - before.units * before.cost) < 1e-6, "併合でも資金価値は保存される");
}

// ══════════════ 8. 日替わり相手 ══════════════
section("8. 今日の主役（§7.4）");
{
  const p1 = KB.protagonists(latest), p2 = KB.protagonists(latest);
  ok(JSON.stringify(p1) === JSON.stringify(p2), "主役の選び方は決定論", JSON.stringify(p1));
  const picked = [p1.up, p1.down, p1.hot].filter(Boolean);
  ok(new Set(picked).size === picked.length, "同じ銘柄が複数枠を占めない（同一なら次点に送る）");
  const best = Object.entries(latest.stocks).filter(([, s]) => s.stale < 3).sort((a, b) => b[1].chg1 - a[1].chg1)[0][0];
  ok(p1.up === best, "値上がり率 1 位が「上」枠に入る", `${p1.up}`);

  const stalled = JSON.parse(JSON.stringify(latest));
  stalled.stocks[best].stale = 4;
  ok(KB.protagonists(stalled).up !== best, "消息不明の銘柄は主役に選ばれない");
}

// ══════════════ 9. 未処理日の精算（§7.1）══════════════
section("9. 未処理日の精算");
{
  // 「開かなかった日も後から再現できる」= 日ごとの結果が他の日に依存しない
  const days = ["2026-09-22", "2026-09-24", "2026-09-25"];
  const resultFor = (date) => {
    const sq = KB.squadOf([buildAt(codes[0], date), buildAt(codes[1], date), buildAt(codes[2], date)]);
    const foe = KB.squadOf([buildAt(codes[3], date), buildAt(codes[4], date), buildAt(codes[5], date)]);
    const r = CB.squadMatch(sq, foe, KB.hashStr(date));
    return `${r.scoreA}-${r.scoreB}`;
  };
  const inOrder = days.map(resultFor).join(",");
  const reversed = days.slice().reverse().map(resultFor).reverse().join(",");
  ok(inOrder === reversed, "日ごとの結果が処理順に依らない（まとめ精算できる）", inOrder);
}

// ══════════════ 10. 実データがあれば同じ不変条件を ══════════════
section("10. 実データ");
{
  const uPath = resolve(ROOT, "kabu", "universe.json");
  const lPath = resolve(ROOT, "kabu", "data", "latest.json");
  if (!existsSync(uPath) || !existsSync(lPath)) {
    console.log("  SKIP  kabu/universe.json・kabu/data/latest.json が未生成（M1 で作る）");
  } else {
    const U = JSON.parse(readFileSync(uPath, "utf8"));
    const L = JSON.parse(readFileSync(lPath, "utf8"));
    const rc = Object.keys(U.stocks);
    // 銘柄集合の一致は、設計書 §11 では **validate.mjs 側の受け持ち**（「universe と latest の
    // 銘柄集合が一致するか」は validate の箇条書きに書かれている）。validate はこれを NG ＝
    // コミット阻止として扱うので、sim で同じ門番を二重に置かず WARN で知らせるだけにする。
    // sim の受け持ちはバランス・決定論・停止性で、取り込みの前後関係ではない。
    //   latest にいて universe にいない … 名簿を引けない（validate が NG で止める）
    //   universe にいて latest にいない … 取得がまだ追いついていないだけ
    const orphan = Object.keys(L.stocks || {}).filter((c) => !U.stocks[c]);
    soft(orphan.length === 0, "latest の銘柄はすべて universe にいる（止めるのは validate 側）",
      orphan.length ? `はみ出し ${orphan.length} 件: ${orphan.slice(0, 5).join(", ")}` : `${Object.keys(L.stocks || {}).length} 銘柄`);
    const noState = rc.filter((c) => !L.stocks[c]);
    soft(noState.length === 0, "universe の銘柄はすべて latest にいる",
      noState.length ? `未取得 ${noState.length} / ${rc.length} 件（fetch-prices が追いつくまで）` : `${rc.length} 銘柄`);
    let built = 0, bad = 0;
    for (const c of rc) {
      const finPath = resolve(ROOT, "kabu", "data", "fin", `${c}.json`);
      const f = existsSync(finPath) ? JSON.parse(readFileSync(finPath, "utf8")) : null;
      const b = KB.buildFromStock({ code: c, u: U.stocks[c], fin: f && f.ttm, state: L.stocks[c], moves: null, date: L.date });
      built++;
      for (const k of CB.STAT_KEYS) if (!(b.stats[k] >= 24 && b.stats[k] <= 100)) bad++;
    }
    ok(bad === 0, "実データでも全銘柄のステータスが 24..100", `${built} 銘柄`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 以降は「実データがあるときだけ」の節。合成データでは測れないもの
// （レア度差ごとの勝率曲線・属性相性の効き・状態タグの発生率・必殺技の解放率・分布）を見る。
// universe.json / latest.json / fin/ が無ければ全部 SKIP して落ちない。
// ══════════════════════════════════════════════════════════════════════
const REAL = (() => {
  const p = (...a) => resolve(ROOT, "kabu", ...a);
  try {
    if (!existsSync(p("universe.json")) || !existsSync(p("data", "latest.json"))) return null;
    const U = JSON.parse(readFileSync(p("universe.json"), "utf8"));
    const L = JSON.parse(readFileSync(p("data", "latest.json"), "utf8"));
    if (!U || !U.stocks || !L || !L.stocks) return null;
    const M = existsSync(p("moves.json")) ? JSON.parse(readFileSync(p("moves.json"), "utf8")) : null;
    const finDir = p("data", "fin");
    const rcodes = Object.keys(U.stocks).filter((c) => L.stocks[c] && U.stocks[c].listed !== false);
    if (!rcodes.length) return null;
    // 特性 serene（時価総額 上位 10）。焼き込みと同じ入力にする
    const top10 = new Set(Object.entries(L.stocks)
      .filter(([, s]) => isFinite(Number(s && s.mcap)))
      .sort((a, b) => b[1].mcap - a[1].mcap || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10).map(([c]) => c));
    const finCache = new Map();
    const finOf = (c) => {
      if (finCache.has(c)) return finCache.get(c);
      let f = null;
      try {
        const fp = resolve(finDir, `${c}.json`);
        if (existsSync(fp)) f = JSON.parse(readFileSync(fp, "utf8")).ttm || null;
      } catch { f = null; }
      finCache.set(c, f); return f;
    };
    let withFin = 0;
    for (const c of rcodes) if (finOf(c)) withFin++;
    return { U, L, M, codes: rcodes, finOf, top10, withFin, hasFin: withFin > 0 };
  } catch (e) {
    console.log(`  SKIP  実データが読めません（${e.message}）`);
    return null;
  }
})();

// 実データの個体（素体・今日）。3,500 銘柄でも 1 回ずつしか組まないようキャッシュする
const _base = new Map(), _today = new Map();
function rBase(c) {
  if (_base.has(c)) return _base.get(c);
  const b = KB.buildFromStock({
    code: c, u: REAL.U.stocks[c], fin: REAL.finOf(c), state: REAL.L.stocks[c],
    moves: REAL.M, date: REAL.L.date, mcapTop10: REAL.top10.has(c)
  });
  _base.set(c, b); return b;
}
function rToday(c) {
  if (_today.has(c)) return _today.get(c);
  const b = KB.applyMods(rBase(c), KB.stateMods(REAL.L.stocks[c], REAL.L.market, {}));
  _today.set(c, b); return b;
}
/** 標本の頭打ち。銘柄が 3,500 に増えても対戦の本数が増えないよう、等間隔に間引く */
function spread(list, cap) {
  if (list.length <= cap) return list.slice();
  const step = list.length / cap, out = [];
  for (let i = 0; i < cap; i++) out.push(list[Math.floor(i * step)]);
  return out;
}
const POOL_CAP = 400;
const avgTotal = (bs) => bs.reduce((a, b) => a + b.total, 0) / bs.length;
const pctS = (v) => `${(v * 100).toFixed(1)}%`;

// ══════════════ 11. 勝率曲線（レア度差ごと）══════════════
// 設計書 §11 は「レア度差 0 で 45〜55%」しか書いていないが、差がついたときに
// なだらかに上がることと、**差が開いても 100% にはならない**こと（BarcodeTool の
// コードバトル設計 v8 の勝率曲線の方針）を測る。相手スケーリング（§7.4 の梯子）は
// かけない＝素の差がそのまま出る条件で見る。
section("11. 勝率曲線（レア度差ごと・実データ）");
const RARE_ORDER = ["D", "C", "B", "A", "S", "SS"];   // 弱 → 強
if (!REAL) {
  console.log("  SKIP  kabu/universe.json・kabu/data/latest.json が未生成");
} else if (!REAL.hasFin) {
  console.log("  SKIP  kabu/data/fin/ が未生成（レア度は決算から決まるので測れない）");
} else {
  // レア度は決算（§4.4）から決まる。決算が無い銘柄は素体もレア度も暫定（C 固定）なので、
  // 混ぜるとレア度差が「意味のない差」になる。決算のある銘柄だけで測る。
  const withFin = REAL.codes.filter((c) => REAL.finOf(c));
  if (withFin.length < REAL.codes.length) console.log(`       決算のある ${withFin.length} / ${REAL.codes.length} 銘柄だけで測る（暫定素体はレア度 C 固定のため）`);
  // 標本はレア度帯**ごと**に頭打ちする。全体から等間隔に間引くと、多い帯（D）で埋まって
  // 少ない帯（SS・S）が 2〜3 銘柄になり、その数体の個性が勝率に出てしまう。
  const RANK_CAP = 80;
  const byRank = {};
  for (const c of withFin) {
    const rk = rBase(c).kabu.rareRank;
    (byRank[rk] = byRank[rk] || []).push(c);
  }
  for (const rk of Object.keys(byRank)) byRank[rk] = spread(byRank[rk], RANK_CAP);
  const pool = RARE_ORDER.flatMap((r) => byRank[r] || []);
  console.log(`       標本 ${pool.length} 銘柄（各帯 最大 ${RANK_CAP}）  ` + RARE_ORDER.slice().reverse().map((r) => `${r}${(byRank[r] || []).length}`).join(" "));

  const r = rng(20260926);
  const curve = [];   // {label, rate, games}
  for (const d of [0, 1, 2, 3]) {
    let wins = 0, games = 0;
    const pairs = [];
    for (let i = 0; i < RARE_ORDER.length; i++) {
      for (let j = 0; j < RARE_ORDER.length; j++) {
        const gap = i - j;                           // i = 強い側
        if (d < 3 ? gap !== d : gap < 3) continue;
        if (!(byRank[RARE_ORDER[i]] || []).length || !(byRank[RARE_ORDER[j]] || []).length) continue;
        pairs.push([byRank[RARE_ORDER[i]], byRank[RARE_ORDER[j]]]);
      }
    }
    if (!pairs.length) { curve.push({ label: d === 3 ? "3 段以上" : `${d} 段`, rate: null, games: 0 }); continue; }
    const per = Math.max(40, Math.ceil(900 / pairs.length));
    for (const [hi, lo] of pairs) {
      for (let t = 0; t < per; t++) {
        const pick = (l) => rToday(l[Math.floor(r() * l.length)]);
        const strong = KB.squadOf([pick(hi), pick(hi), pick(hi)]);
        const weak = KB.squadOf([pick(lo), pick(lo), pick(lo)]);
        // 先攻・後攻の偏りを打ち消すため 1 回ごとに入れ替える
        const flip = t % 2 === 1;
        const res = flip ? CB.squadMatch(weak, strong, t + 1) : CB.squadMatch(strong, weak, t + 1);
        const strongScore = flip ? res.scoreB : res.scoreA;
        const weakScore = flip ? res.scoreA : res.scoreB;
        if (strongScore === weakScore) continue;
        games++; if (strongScore > weakScore) wins++;
      }
    }
    curve.push({ label: d === 3 ? "3 段以上" : `${d} 段`, rate: games ? wins / games : null, games });
  }
  for (const p of curve) console.log(`       レア度差 ${p.label}: ${p.rate == null ? "標本なし" : pctS(p.rate)}（${p.games} 戦）`);

  const d0 = curve.find((p) => p.label === "0 段");
  soft(d0 && d0.rate != null && d0.rate >= 0.45 && d0.rate <= 0.55,
    "レア度差 0 の勝率が 45〜55%", d0 && d0.rate != null ? pctS(d0.rate) : "標本なし");

  const got = curve.filter((p) => p.rate != null && p.games >= 40);
  // なだらかに上がる = 差が開いて勝率が下がらない（標本ゆらぎ分 3pt の緩みを持たせる）
  let mono = true;
  for (let i = 1; i < got.length; i++) if (got[i].rate < got[i - 1].rate - 0.03) mono = false;
  soft(got.length >= 2 && mono, "レア度差が開くほど強い方の勝率が上がる（下がらない）",
    got.map((p) => `${p.label} ${pctS(p.rate)}`).join(" → "));
  soft(got.length >= 2 && got[got.length - 1].rate > (got[0].rate + 0.03),
    "差 0 と最大差のあいだに差が付いている（レア度が意味を持つ）",
    got.length >= 2 ? `${pctS(got[0].rate)} → ${pctS(got[got.length - 1].rate)}` : "標本不足");
  const top = got.length ? Math.max(...got.map((p) => p.rate)) : 0;
  soft(got.length > 0 && top < 0.95, "レア度差があっても 100% にはならない（番狂わせが残る）",
    `最大 ${pctS(top)}`);
}

// ══════════════ 12. 属性相性の効き（設計書 §4.3）══════════════
// 相克（×1.13）で殴る側と被克（×0.89）で殴る側の勝率差。有利すぎ（一方通行）でも
// 無意味すぎ（属性を見なくてよい）でも困るので、目安 10〜40 ポイントに入るかを見る。
// 素体の差が混ざらないよう、隊の平均 total が近い組だけを使う。
section("12. 属性相性の効き（実データ）");
if (!REAL) {
  console.log("  SKIP  実データが未生成");
} else {
  const pool = spread(REAL.codes, POOL_CAP);
  const byElem = {};
  for (const c of pool) (byElem[rBase(c).elem] = byElem[rBase(c).elem] || []).push(c);
  console.log("       標本 " + CB.ELEMENTS.map((el, i) => `${el.name}${(byElem[i] || []).length}`).join(" "));
  // 相性の効きは「技が何属性をカバーしているか」で決まる（chooseMove が有利な技を選ぶ）。
  // 数字の背景が分かるように一緒に出す。
  {
    const mv = pool.map((c) => rBase(c).moves.length);
    const cv = pool.map((c) => new Set(rBase(c).moves.map((m) => m.elem)).size);
    const av = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    console.log(`       技 平均 ${av(mv).toFixed(2)} 本（最少 ${Math.min.apply(null, mv)}）／カバー属性 平均 ${av(cv).toFixed(2)} 種（最少 ${Math.min.apply(null, cv)}）`);
  }

  const r = rng(760320);
  const TOL = 2;                       // 平均 total の許容差
  const pickSq = (l) => KB.squadOf([0, 1, 2].map(() => rToday(l[Math.floor(r() * l.length)])));
  const matched = (la, lb) => {        // 平均 total が近い組を引く（引けなければ null）
    for (let k = 0; k < 30; k++) {
      const A = pickSq(la), B = pickSq(lb);
      if (Math.abs(avgTotal(A.beasts) - avgTotal(B.beasts)) <= TOL) return [A, B];
    }
    return null;
  };

  // 相克（CB の d=2・×1.13）になっている属性の組を CB.affinity から拾う
  const pairs = [];
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) {
    if (a !== b && CB.affinity(a, b) > 1.12 && (byElem[a] || []).length && (byElem[b] || []).length) pairs.push([a, b]);
  }
  if (!pairs.length) {
    console.log("  SKIP  相克の組に標本が揃いません");
  } else {
    let wins = 0, games = 0, skipped = 0;
    const per = Math.max(60, Math.ceil(1200 / pairs.length));
    for (const [a, b] of pairs) {
      for (let t = 0; t < per; t++) {
        const m = matched(byElem[a], byElem[b]);
        if (!m) { skipped++; continue; }
        const flip = t % 2 === 1;                       // 先攻の偏りを打ち消す
        const res = flip ? CB.squadMatch(m[1], m[0], t + 11) : CB.squadMatch(m[0], m[1], t + 11);
        const sA = flip ? res.scoreB : res.scoreA, sB = flip ? res.scoreA : res.scoreB;
        if (sA === sB) continue;
        games++; if (sA > sB) wins++;
      }
    }
    // 同属性（相性なし）の対戦を対照として測る。ここが 50% から離れていれば
    // 「属性の効き」ではなく標本の偏りを見てしまっている合図。
    let nWins = 0, nGames = 0;
    for (let a = 0; a < 5; a++) {
      const l = byElem[a]; if (!l || l.length < 2) continue;
      for (let t = 0; t < 120; t++) {
        const m = matched(l, l); if (!m) continue;
        const res = CB.squadMatch(m[0], m[1], t + 301);
        if (res.scoreA === res.scoreB) continue;
        nGames++; if (res.scoreA > res.scoreB) nWins++;
      }
    }
    const rate = games ? wins / games : 0;
    const gapPt = (rate * 2 - 1) * 100;                  // 相克側 − 被克側（ポイント）
    const nRate = nGames ? nWins / nGames : 0;
    console.log(`       相克側の勝率 ${pctS(rate)}（${games} 戦、平均 total 差 ≤${TOL} の組だけ・引けず見送り ${skipped}）`);
    console.log(`       対照: 同属性どうし ${pctS(nRate)}（${nGames} 戦）`);
    soft(nGames > 0 && Math.abs(nRate - 0.5) <= 0.05, "対照（同属性どうし）は 45〜55%（測り方に偏りがない）", pctS(nRate));
    soft(games > 0 && gapPt >= 10 && gapPt <= 40,
      "相克で殴る側と被克で殴る側の勝率差が 10〜40 ポイント（有利すぎず無意味すぎず）",
      `${gapPt.toFixed(1)} ポイント`);
  }
}

// ══════════════ 13. 状態タグの発生率（設計書 §5.1）══════════════
// 覚醒・逆境・暴走・冬眠・ストップ高… が実データで何件出ているか。
// 全部 0 件なら「状態が誰にも効いていない」＝検出ロジックが死んでいる。
section("13. 状態タグの発生率（実データ）");
const NAMED_TAGS = ["覚醒", "逆境", "暴走", "冬眠", "ストップ高", "ストップ安", "注目", "荒れ", "粘り", "期待", "消息不明"];
if (!REAL) {
  console.log("  SKIP  実データが未生成");
} else {
  const count = {};
  let n = 0;
  for (const c of REAL.codes) {
    const tags = KB.stateMods(REAL.L.stocks[c], REAL.L.market, {}).tags || [];
    n++;
    for (const t of tags) count[t] = (count[t] || 0) + 1;
  }
  const rows = Object.entries(count).sort((a, b) => b[1] - a[1]);
  for (const [t, v] of rows) console.log(`       ${t}: ${v} 件（${pctS(v / n)}）`);
  if (!rows.length) console.log("       （1 件も出ていません）");
  const marketTags = (REAL.L.market && (REAL.L.market.nk225Chg <= -0.03 || REAL.L.market.nk225Chg >= 0.03)) ? "（全体イベント日）" : "";
  soft(rows.length > 0, `状態タグが 1 つ以上出ている（${n} 銘柄）${marketTags}`, `${rows.length} 種`);
  const named = NAMED_TAGS.filter((t) => count[t]);
  soft(named.length >= 3, "覚醒・逆境・暴走・冬眠・ストップ高 などの名前つきタグが 3 種以上出ている",
    named.length ? named.map((t) => `${t}${count[t]}`).join(" ") : "0 種");
  // 1 つの状態が全銘柄に出るのは「条件が緩すぎる」合図（全員同じなら状態の意味がない）
  const glued = rows.filter(([t, v]) => v === n && t !== "消息不明").map(([t]) => t);
  soft(glued.length === 0, "全銘柄に付くタグは無い（条件が緩すぎない）", glued.join("・") || "なし");
}

// ══════════════ 14. 必殺技の解放率（設計書 §6.4）══════════════
// 「今日その必殺技を解放できている銘柄」の割合。awaken（年初来高値圏）・limitUp（ストップ高）
// はデータから決まり、earnings は KB.isEarningsDay の推定（焼き込みがあればそれ）で決まる。
// streak（予想 3 連勝）だけはセーブ側の値なのでここでは数えない（＝ここで出る率は下限）。
section("14. 必殺技の解放率（実データ）");
if (!REAL) {
  console.log("  SKIP  実データが未生成");
} else if (!REAL.M || !REAL.M.stocks) {
  console.log("  SKIP  kabu/moves.json が未生成");
} else {
  // その銘柄が今日「決算日」か。latest に焼き込まれていればそれを使い、無ければ fiscalId から推定する
  const earningsOf = (c) => {
    const s = REAL.L.stocks[c] || {};
    if ("earnings" in s) return !!s.earnings;
    if (typeof KB.isEarningsDay !== "function") return false;
    const fid = (typeof s.fiscalId === "string" && s.fiscalId) || ((REAL.finOf(c) || {}).fiscalId);
    return fid ? KB.isEarningsDay(REAL.L.date, fid) : false;
  };
  const withUlt = REAL.codes.filter((c) => (REAL.M.stocks[c] || {}).ultimate);
  let open = 0;
  const byCond = {};
  for (const c of withUlt) {
    const ult = REAL.M.stocks[c].ultimate;
    const u = KB.stateMods(REAL.L.stocks[c], REAL.L.market, { earnings: earningsOf(c) }).unlocked || {};
    if (KB.isUnlocked(ult, u)) open++;
    for (const k of (Array.isArray(ult.unlock) ? ult.unlock : [])) {
      byCond[k] = byCond[k] || { need: 0, met: 0 };
      byCond[k].need++; if (u[k]) byCond[k].met++;
    }
  }
  const rate = withUlt.length ? open / withUlt.length : 0;
  const earnAll = REAL.codes.filter(earningsOf).length;
  console.log(`       必殺技を持つ ${withUlt.length} 銘柄のうち今日解放 ${open} 件 = ${pctS(rate)}`);
  for (const [k, v] of Object.entries(byCond)) {
    const note = k === "streak" ? "（セーブ側の値なので 0 固定・下限扱い）" : "";
    console.log(`       ${k}: 条件に挙げている ${v.need} 銘柄中 ${v.met} 件成立${note}`);
  }
  // 決算日そのものは「その日たまたま当たるか」なので 0 件でも異常ではない。見るべきは
  // **推定日がばらけているか**。全銘柄が同じ fiscalId だと決算日ボス（§9.3）が
  // 「四半期に 1 日、全銘柄いっせいに」しか起きず、日替わりの楽しみにならない。
  const estDays = {};
  let noFiscal = 0;
  for (const c of REAL.codes) {
    const s = REAL.L.stocks[c] || {};
    const fid = (typeof s.fiscalId === "string" && s.fiscalId) || ((REAL.finOf(c) || {}).fiscalId);
    if (!fid || typeof KB.estimatedEarningsDate !== "function") { noFiscal++; continue; }
    // 決算日は「四半期末 + 35〜45 日」の帯。戻り値は {from, to} なので帯の頭で数える
    const e = KB.estimatedEarningsDate(fid, REAL.L.date);
    if (e && e.from) estDays[e.from] = (estDays[e.from] || 0) + 1; else noFiscal++;
  }
  const uniq = Object.keys(estDays).sort();
  console.log(`       今日が決算日（推定）の銘柄 ${earnAll} / ${REAL.codes.length} 件（四半期末 +${KB.EARNINGS_FROM}〜${KB.EARNINGS_TO} 日）`);
  console.log(`       決算日の推定が付く ${REAL.codes.length - noFiscal} 銘柄 → 相異なる推定日 ${uniq.length} 日: ${uniq.slice(0, 6).join(" ")}${uniq.length > 6 ? " …" : ""}`);
  soft(uniq.length === 0 || uniq.length >= 4,
    "決算日の推定がばらけている（決算日ボスが年に何度も来る）",
    uniq.length ? `${uniq.length} 日（${uniq.map((d) => `${d}:${estDays[d]}`).slice(0, 6).join(" ")}）` : "fiscalId が無く測れない");
  soft(withUlt.length > 0, "必殺技を持つ銘柄が実データにいる", `${withUlt.length} 銘柄`);
  soft(withUlt.length === 0 || (rate > 0 && rate < 0.5),
    "必殺技の解放が「たまに起きる特別」の範囲（0% 超 50% 未満）", pctS(rate));
}

// ══════════════ 15. レア度・属性の分布 ══════════════
// 全上場企業に広げるとレア度は D〜SS に散るはず（大型株だけなら A・B に偏る）。
// 偏りは数式の失敗とは限らない（ロスターの性質）ので「注意」まで。
section("15. レア度・属性の分布（実データ）");
if (!REAL) {
  console.log("  SKIP  実データが未生成");
} else {
  const n = REAL.codes.length;
  const rare = {}, elem = {}, rareFin = {};
  let nFin = 0;
  for (const c of REAL.codes) {
    const b = rBase(c);
    rare[b.kabu.rareRank] = (rare[b.kabu.rareRank] || 0) + 1;
    elem[b.elem] = (elem[b.elem] || 0) + 1;
    if (!b.kabu.provisional) { nFin++; rareFin[b.kabu.rareRank] = (rareFin[b.kabu.rareRank] || 0) + 1; }
  }
  const show = (tbl, tot) => RARE_ORDER.slice().reverse().map((r) => `${r}:${tbl[r] || 0}(${pctS((tbl[r] || 0) / Math.max(1, tot))})`).join(" ");
  console.log(`       レア度（全 ${n} 銘柄）      ${show(rare, n)}`);
  console.log(`       レア度（決算あり ${nFin} 銘柄）${show(rareFin, nFin)}`);
  console.log(`       属性   ${CB.ELEMENTS.map((el, i) => `${el.name}:${elem[i] || 0}(${pctS((elem[i] || 0) / n)})`).join(" ")}`);
  if (nFin < n) console.log(`       決算が無い ${n - nFin} 銘柄は暫定素体（レア度 C 固定）。レア度の判定は決算ありだけで見る`);
  // レア度は決算（§4.4）から決まるので、決算のある銘柄だけで散り方を見る
  const thinRare = nFin ? RARE_ORDER.filter((r) => (rareFin[r] || 0) / nFin < 0.01) : [];
  soft(nFin > 0 && thinRare.length === 0, "決算のある銘柄はどのレア度帯にも 1% 以上いる",
    !nFin ? "決算データなし" : (thinRare.length ? `1% 未満: ${thinRare.join("・")}` : `${nFin} 銘柄`));
  const thinElem = CB.ELEMENTS.map((el, i) => [el.name, (elem[i] || 0) / n]).filter(([, v]) => v < 0.05);
  soft(thinElem.length === 0, "どの属性にも 5% 以上いる", thinElem.length ? `5% 未満: ${thinElem.map(([k, v]) => `${k} ${pctS(v)}`).join("・")}` : `${n} 銘柄`);
}

// ══════════════ 16. セーブのスキーマ（設計書 §8.6）══════════════
// blankStore() が持つフィールドと loadStore() が読むフィールドがずれていると、
// 「セーブしたのに戻ってこない項目」が静かに生まれる。src/template.html を
// 文字列として読んで突き合わせる（別のエージェントが編集中でも落ちないよう、
// 解析できない形なら SKIP）。src/ は読むだけ。
section("16. セーブのスキーマ（blankStore ↔ loadStore）");
{
  const tPath = resolve(ROOT, "src", "template.html");
  const brace = (src, from) => {               // src[from] = "{" として対応する "}" の位置を返す
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {             // 文字列は読み飛ばす
        const q = ch;
        for (i++; i < src.length; i++) { if (src[i] === "\\") i++; else if (src[i] === q) break; }
        continue;
      }
      if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2); if (i < 0) return -1; i++; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (!depth) return i; }
    }
    return -1;
  };
  if (!existsSync(tPath)) {
    console.log("  SKIP  src/template.html がありません");
  } else {
    let src = "";
    try { src = readFileSync(tPath, "utf8"); } catch { src = ""; }
    const bAt = src.indexOf("function blankStore");
    const lAt = src.indexOf("function loadStore");
    const retAt = bAt >= 0 ? src.indexOf("return {", bAt) : -1;
    const bEnd = retAt >= 0 ? brace(src, src.indexOf("{", retAt)) : -1;
    const lOpen = lAt >= 0 ? src.indexOf("{", src.indexOf(")", lAt)) : -1;
    const lEnd = lOpen >= 0 ? brace(src, lOpen) : -1;
    if (bEnd < 0 || lEnd < 0) {
      console.log("  SKIP  blankStore() / loadStore() を読み取れる形で見つけられませんでした（編集中？）");
    } else {
      const body = src.slice(src.indexOf("{", retAt) + 1, bEnd);
      // 返すオブジェクトの「深さ 1」のキーだけ拾う（入れ子のキーは数えない）
      const fields = [];
      {
        let depth = 0;
        for (let i = 0; i < body.length; i++) {
          const ch = body[i];
          if (ch === '"' || ch === "'" || ch === "`") { const q = ch; for (i++; i < body.length; i++) { if (body[i] === "\\") i++; else if (body[i] === q) break; } continue; }
          if (ch === "/" && body[i + 1] === "/") { while (i < body.length && body[i] !== "\n") i++; continue; }
          if (ch === "/" && body[i + 1] === "*") { i = body.indexOf("*/", i + 2); if (i < 0) break; i++; continue; }
          if (ch === "{" || ch === "[" || ch === "(") { depth++; continue; }
          if (ch === "}" || ch === "]" || ch === ")") { depth--; continue; }
          if (depth === 0 && /[A-Za-z_$]/.test(ch)) {
            const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
            if (m) { fields.push(m[1]); i += m[0].length - 1; }
            else { while (i < body.length && /[\w$]/.test(body[i])) i++; }
          }
        }
      }
      const readBody = src.slice(lOpen, lEnd + 1);
      const read = new Set();
      for (const m of readBody.matchAll(/\bj\.([A-Za-z_$][\w$]*)/g)) read.add(m[1]);
      for (const m of readBody.matchAll(/\bj\[\s*"([^"]+)"\s*\]/g)) read.add(m[1]);

      if (!fields.length) {
        console.log("  SKIP  blankStore() のフィールドを読み取れませんでした（編集中？）");
      } else {
        console.log(`       blankStore: ${fields.join(" ")}`);
        console.log(`       loadStore が読む: ${[...read].sort().join(" ")}`);
        const notRead = fields.filter((f) => !read.has(f));
        const notInBlank = [...read].filter((f) => !fields.includes(f));
        soft(notRead.length === 0, "blankStore() の全フィールドを loadStore() が読んでいる（セーブが消えない）",
          notRead.length ? `読まれていない: ${notRead.join(" ")}` : `${fields.length} 項目`);
        soft(notInBlank.length === 0, "loadStore() が読むフィールドはすべて blankStore() にある（初期値がある）",
          notInBlank.length ? `初期値が無い: ${notInBlank.join(" ")}` : `${read.size} 項目`);
        const verAt = /\bj\.v\s*!==\s*(\d+)/.exec(readBody);
        const keyAt = /SAVE_KEY\s*=\s*"([^"]+)"/.exec(src);
        soft(!!verAt && !!keyAt && keyAt[1].endsWith(`_v${verAt[1]}`),
          "セーブキーの版番号と loadStore() が受け付ける v が揃っている（§8.6）",
          `${keyAt ? keyAt[1] : "?"} / j.v === ${verAt ? verAt[1] : "?"}`);
      }
    }
  }
}

// ══════════════ 17. 分割・併合を実データで（設計書 §8.3）══════════════
// Yahoo が返す分割イベント（latest.json の splits）と、前日比からの推測（KB.detectSplit）が
// 矛盾しないこと。系列が調整済みなら推測は何も言わない（それは矛盾ではない）。
section("17. 分割・併合（latest.json の splits）");
/**
 * Yahoo が返した分割イベントと、前日比からの推測（KB.detectSplit）を突き合わせる。
 * 実データ・合成データのどちらにも同じ物差しを当てられるよう関数にしてある。
 */
function checkSplits(L, where) {
  const splits = Array.isArray(L.splits) ? L.splits : [];
  let shapeBad = [], ratioBad = [], conflict = [], fired = 0, quiet = 0, noState = 0;
  for (const ev of splits) {
    const code = String(ev && ev.code);
    const den = Number(ev && ev.denominator), nu = Number(ev && ev.numerator);
    if (!code || !(den > 0) || !(nu > 0)) { shapeBad.push(JSON.stringify(ev)); continue; }
    // Yahoo の比は「1 株 → numerator/denominator 株」。株数が増える = 分割
    const ratio = nu / den;
    // ratio は数値で numerator/denominator と同じ値のはず（sources/yahoo.mjs がそう作る）
    if ("ratio" in ev && !(typeof ev.ratio === "number" && isFinite(ev.ratio) && Math.abs(ev.ratio / ratio - 1) <= 1e-9)) {
      ratioBad.push(`${code}: ratio=${JSON.stringify(ev.ratio)} ≠ ${nu}/${den}=${ratio}`);
    }
    const want = ratio > 1 ? { kind: "split", n: ratio } : { kind: "merge", n: 1 / ratio };
    const s = L.stocks[code];
    if (!s) { noState++; continue; }
    const guess = KB.detectSplit(s.chg1, s.volume, s.avgVolume20);
    if (!guess) { quiet++; continue; }               // 調整済みの系列。推測が黙るのが正しい
    fired++;
    if (guess.kind !== want.kind || Math.abs(guess.n - want.n) > 0.01) {
      conflict.push(`${code}: 推測 ${guess.kind}×${guess.n} ≠ Yahoo ${want.kind}×${want.n.toFixed(2)}（chg1=${s.chg1}）`);
    }
  }
  console.log(`       ${where}: splits ${splits.length} 件  推測が反応 ${fired} / 黙った ${quiet}（調整済み系列）/ 状態なし ${noState}`);
  ok(shapeBad.length === 0, `splits の各要素に code と numerator/denominator がある（${where}）`,
    shapeBad.length ? shapeBad.slice(0, 3).join(" / ") : `${splits.length} 件`);
  ok(ratioBad.length === 0, `splits の ratio が数値で numerator/denominator と一致する（${where}）`,
    ratioBad.length ? ratioBad.slice(0, 3).join(" / ") : `${splits.length} 件`);
  soft(conflict.length === 0, `KB.detectSplit の推測が分割イベントと矛盾しない（${where}）`,
    conflict.length ? conflict.slice(0, 5).join(" / ") : `矛盾 0 件（反応 ${fired} 件）`);
  // 分割の日は「テンション」「荒れ」の判定を無効にしたい（§8.3）。素の値のままだと
  // 未調整の前日比がそのまま状態に効いてしまうので、気づけるようにしておく。
  const leaked = splits.filter((ev) => {
    const s = L.stocks[String(ev && ev.code)];
    return s && !s.split && KB.detectSplit(s.chg1, s.volume, s.avgVolume20);
  }).map((ev) => ev.code);
  soft(leaked.length === 0, `推測が反応する銘柄には latest.json 側にも split が立っている（${where}）`,
    leaked.length ? `立っていない: ${leaked.slice(0, 5).join(", ")}` : "なし");
}
if (REAL && Array.isArray(REAL.L.splits) && REAL.L.splits.length) {
  checkSplits(REAL.L, "実データ");
} else {
  // 実データの splits はほとんどの日が空。突き合わせの経路が腐らないよう合成データで通す。
  console.log(REAL
    ? `  （実データの splits が空。${REAL.L.date} に分割・併合なし → 合成データで突き合わせ経路を通す）`
    : "  （実データが未生成 → 合成データで突き合わせ経路を通す）");
  checkSplits(synthSplits(latest), "合成データ");
}

// ══════════════ 18. 今日の主役に時価総額の下限を入れた効果（§7.4）══════════════
// 3,500 銘柄から素で「値上がり率 1 位」を採ると、ほぼ毎日 数百円の超小型株のストップ高になり、
// 「その日の相場そのものが敵」という趣旨から外れる。KB.MIN_MCAP（100 億円）の下限あり／なしで
// 主役がどう変わるかを並べて、下限が効きすぎていないか（大型株だけの退屈な顔ぶれになっていないか）も見る。
section("18. 今日の主役と時価総額の下限（§7.4）");
if (!REAL) {
  console.log("  SKIP  実データが未生成");
} else if (KB.MIN_MCAP == null) {
  console.log("  SKIP  KB.MIN_MCAP がありません（下限なしの実装）");
} else {
  const OKU = 1e8;
  const name = (c) => {
    const u = REAL.U.stocks[c] || {};
    const s = REAL.L.stocks[c] || {};
    return `${u.short || u.name || c}(${c}) 時価${(Number(s.mcap) / OKU).toFixed(0)}億 ${(Number(s.chg1) * 100).toFixed(1)}% 出来高比${Number(s.volRatio).toFixed(1)}`;
  };
  const withFloor = KB.protagonists(REAL.L);
  const noFloor = KB.protagonists(REAL.L, { minMcap: 0 });
  for (const slot of ["up", "down", "hot"]) {
    const a = withFloor[slot], b = noFloor[slot];
    const label = { up: "上", down: "下", hot: "出来高" }[slot];
    console.log(`       ${label}  下限あり: ${a ? name(a) : "なし"}`);
    console.log(`       ${label}  下限なし: ${b ? name(b) : "なし"}${a === b ? "  （同じ）" : ""}`);
  }
  const slots = ["up", "down", "hot"];
  ok(slots.every((s) => withFloor[s]), "下限ありでも主役 3 体が揃う（出せない日を作らない）",
    slots.map((s) => withFloor[s]).join(" / "));
  const picked = slots.map((s) => withFloor[s]).filter(Boolean);
  ok(new Set(picked).size === picked.length, "下限ありでも同じ銘柄が複数枠を占めない");
  ok(JSON.stringify(KB.protagonists(REAL.L)) === JSON.stringify(withFloor), "下限ありでも決定論");

  // 下限が効いている銘柄はすべて下限以上であること（決算未取得で mcap が無い銘柄は素通り＝仕様）
  const belowFloor = picked.filter((c) => {
    const m = Number((REAL.L.stocks[c] || {}).mcap);
    return isFinite(m) && m > 0 && m < KB.MIN_MCAP;
  });
  soft(belowFloor.length === 0, `主役は全員 時価総額 ${(KB.MIN_MCAP / OKU).toFixed(0)} 億円以上`,
    belowFloor.length ? `下限未満: ${belowFloor.map(name).join(" / ")}（候補が 3 体に足りず下限を外した日）` : "なし");

  const changed = slots.filter((s) => withFloor[s] !== noFloor[s]);
  console.log(`       下限で入れ替わった枠 ${changed.length} / 3${changed.length ? `（${changed.map((s) => ({ up: "上", down: "下", hot: "出来高" }[s])).join("・")}）` : ""}`);
  // 下限が「毎日ぜんぶ差し替える」ほど強いなら、素の選び方が超小型株に食われていた証拠
  const mcapOf = (c) => Number((REAL.L.stocks[c] || {}).mcap) / OKU;
  const med = (arr) => { const a = arr.filter(isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
  console.log(`       主役の時価総額 中央値  下限あり ${med(picked.map(mcapOf)).toFixed(0)}億 / 下限なし ${med(slots.map((s) => noFloor[s]).filter(Boolean).map(mcapOf)).toFixed(0)}億`);
  // 下限を上げすぎると「毎日おなじ大型株」になる。全体の何割が候補に残っているかを見ておく
  const all = Object.entries(REAL.L.stocks).filter(([, s]) => Number(s.stale) < 3 && !s.suspect);
  const kept = all.filter(([, s]) => !(Number(s.mcap) > 0) || Number(s.mcap) >= KB.MIN_MCAP);
  const keepRate = all.length ? kept.length / all.length : 0;
  console.log(`       下限を通る銘柄 ${kept.length} / ${all.length} = ${pctS(keepRate)}`);
  soft(keepRate >= 0.20 && keepRate <= 0.95,
    "下限を通る銘柄が全体の 20〜95%（絞りすぎず、効かなすぎず）", pctS(keepRate));
}

console.log(`\n${pass} PASS / ${warn} WARN / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
