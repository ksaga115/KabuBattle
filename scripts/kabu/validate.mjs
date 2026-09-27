// scripts/kabu/validate.mjs
// ゲームが読めない JSON をコミットさせないための検査。設計書 §11。
// Actions は取得のあと必ずこれを通し、落ちたらコミットしない。
//
// 設計書 §1 は kabu/schema/*.json（JSON Schema）を置く構成だったが、検証器を別に書くと
// 「スキーマと検証の二重管理」になって必ずずれる。ここでは検証器そのものを唯一の規定にし、
// 依存パッケージを増やさない（恒常的に回るワークフローの依存は少ないほどよい）。
//
// 使い方:
//   node scripts/kabu/validate.mjs          … 全部
//   node scripts/kabu/validate.mjs --quiet  … 失敗だけ表示
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./paths.mjs";
import { loadCore } from "./load.mjs";

const KABU = resolve(ROOT, "kabu");
const DATA = resolve(KABU, "data");
const quiet = process.argv.includes("--quiet");

let errors = 0, warns = 0, checks = 0;
const bad = (msg) => { errors++; console.log(`  NG   ${msg}`); };
const warn = (msg) => { warns++; console.log(`  注意 ${msg}`); };
const good = (msg) => { checks++; if (!quiet) console.log(`  OK   ${msg}`); };
const section = (t) => { if (!quiet) console.log(`\n── ${t} ──`); else console.log(`── ${t} ──`); };

// ブラウザの fetch().json() は先頭の BOM を落としてから読む。Node の JSON.parse は落とさないので、
// 「ブラウザでは読めるのに検査だけ落ちる」を避けるためここでも落としておく。
const readJson = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
// 証券コードは 4 文字ちょうど（設計書 §0 の柱 4「証券コード + 将来の英字対応」）。
//   ・数字 4 桁（7203）        … 従来のコード
//   ・数字 3 桁 + 英字（130A） … 2024 年以降の新規上場で使われる形
// 末尾を任意（`\d{4}[0-9A-Z]?`）にすると 5 文字の**種類株式・優先株式**（94345・25935 など）を
// 通してしまう。あれを普通株と同じ土俵に乗せると時価総額が桁違いになり、
// 「時価総額 上位 10 = 特性 serene」や今日の主役の選び方を壊す（実際に壊した）。
// 逆に 4 桁必須にすると `130A` 形が丸ごと漏れる（実際に 172 銘柄漏れていた）。
const isCode = (c) => /^\d{3}[0-9A-Z]$/.test(c);
const num = (v) => typeof v === "number" && isFinite(v);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

// daily/ の 1 日ぶんは `<date>.json` でも `<date>.json.gz` でもよい（設計書 §8.7 の「薄い形＋gzip」）。
// どちらの形でも検査が同じように効くよう、日付だけを取り出して扱う。
const DAILY = resolve(DATA, "daily");
function dailyFiles() {
  if (!existsSync(DAILY)) return new Map();
  const out = new Map();   // date -> ファイル名
  for (const f of readdirSync(DAILY)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json(\.gz)?$/.exec(f);
    if (m && !out.has(m[1])) out.set(m[1], f);
  }
  return new Map([...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };

const { CB, KB } = await loadCore();

// ══════════════ universe.json ══════════════
section("universe.json");
const uPath = resolve(KABU, "universe.json");
let universe = null;
if (!existsSync(uPath)) {
  bad("kabu/universe.json がありません");
} else {
  universe = readJson(uPath);
  if (universe.schemaVersion !== 1) bad(`schemaVersion が 1 ではありません（${universe.schemaVersion}）`);
  else good("schemaVersion = 1");

  const codes = Object.keys(universe.stocks || {});
  if (!codes.length) bad("stocks が空です");
  else good(`${codes.length} 銘柄`);

  let shapeBad = 0, elemBad = 0, codeBad = 0;
  for (const c of codes) {
    const s = universe.stocks[c];
    if (!isCode(c)) { codeBad++; continue; }
    if (typeof s.name !== "string" || !s.name) shapeBad++;
    else if (typeof s.sector33 !== "string") shapeBad++;
    else if (typeof s.listed !== "boolean") shapeBad++;
    else if (!Array.isArray(s.indices)) shapeBad++;
    else if (!Array.isArray(s.renamedFrom)) shapeBad++;
    // elem は対応表から機械的に決まる（手で書き換えられていないことの確認。設計書 §3）
    if (s.elem !== KB.sectorElem(s.sector33)) elemBad++;
  }
  if (codeBad) bad(`証券コードとして不正なキーが ${codeBad} 件`); else good("キーはすべて証券コードの形");
  if (shapeBad) bad(`必須項目が欠けている銘柄が ${shapeBad} 件`); else good("必須項目（name/sector33/listed/indices/renamedFrom）が揃っている");
  if (elemBad) bad(`elem が業種の対応表と食い違う銘柄が ${elemBad} 件（手で書き換えた？）`); else good("elem はすべて業種の対応表どおり");

  const delistedBad = codes.filter((c) => {
    const s = universe.stocks[c];
    return (s.listed && s.delistedAt) || (!s.listed && !s.delistedAt);
  }).length;
  if (delistedBad) bad(`listed と delistedAt が矛盾する銘柄が ${delistedBad} 件`); else good("listed と delistedAt に矛盾なし");
}

// ══════════════ moves.json ══════════════
section("moves.json");
const mPath = resolve(KABU, "moves.json");
let moves = null;
const DESIGN_KINDS = new Set([
  "strike", "crit", "pierce", "drain", "multi", "sure", "first", "stack", "gamble",
  "delay", "shield", "reflect", "swap", "dot", "debuff", "heal", "counter", "finisher", "regen"
]);
const UNLOCKS = new Set(["awaken", "limitUp", "earnings", "streak"]);

if (!existsSync(mPath)) {
  warn("kabu/moves.json がありません（技なしでも動くが、業種技だけになります）");
} else {
  moves = readJson(mPath);
  if (moves.schemaVersion !== 1) bad(`schemaVersion が 1 ではありません（${moves.schemaVersion}）`);
  else good("schemaVersion = 1");

  // 33 業種すべてに業種技があること（無い業種の銘柄は技が 0 本になりかねない）
  const sectors = KB.sectors();
  const missing = sectors.filter((s) => !(moves.sector || {})[s]);
  if (missing.length) bad(`業種技が無い業種 ${missing.length} 件: ${missing.join("・")}`);
  else good(`33 業種すべてに業種技がある`);

  const extra = Object.keys(moves.sector || {}).filter((s) => !sectors.includes(s));
  if (extra.length) warn(`対応表に無い業種の技: ${extra.join("・")}`);

  let kindBad = [], nameBad = 0, unknownCode = [], unlockBad = [], badCode = [];
  const checkMove = (m, where) => {
    if (!m || typeof m !== "object") { kindBad.push(`${where}: 技がオブジェクトではない`); return; }
    if (typeof m.name !== "string" || !m.name) nameBad++;
    if (!DESIGN_KINDS.has(m.kind)) kindBad.push(`${where}: 未知の kind「${m.kind}」`);
    // kind ごとに要るパラメータ（欠けていても既定値で動くが、書き忘れは知らせる）
    const need = { multi: ["min", "max"], stack: ["add"], gamble: ["maxMult"], delay: ["turns"], shield: ["cut"], dot: ["rate"], debuff: ["cut"], heal: ["rate"], reflect: ["ratio"], finisher: ["mult"] }[m.kind];
    if (need) for (const k of need) if (!num(m[k])) kindBad.push(`${where}: kind=${m.kind} に ${k} がありません`);
  };
  for (const [s, m] of Object.entries(moves.sector || {})) checkMove(m, `業種技 ${s}`);

  for (const [code, e] of Object.entries(moves.stocks || {})) {
    if (!isCode(code)) badCode.push(code);
    if (universe && !universe.stocks[code]) unknownCode.push(code);
    (e.moves || []).forEach((m, i) => checkMove(m, `${code} 固有技${i + 1}`));
    if (e.ultimate) {
      checkMove(e.ultimate, `${code} 必殺技`);
      const ul = e.ultimate.unlock;
      if (!Array.isArray(ul) || !ul.length) unlockBad.push(`${code}: 必殺技に unlock がありません`);
      else for (const u of ul) if (!UNLOCKS.has(u)) unlockBad.push(`${code}: 未知の unlock「${u}」`);
    }
    if ((e.moves || []).length > 2) warn(`${code}: 固有技が 3 つ以上あります（使われるのは先頭 2 つ）`);
  }
  if (kindBad.length) { bad(`技の定義に問題 ${kindBad.length} 件`); for (const k of kindBad.slice(0, 15)) console.log(`         ${k}`); }
  else good("すべての技の kind とパラメータが揃っている");
  if (nameBad) bad(`名前が無い技が ${nameBad} 件`); else good("すべての技に名前がある");
  if (badCode.length) warn(`証券コードの形でないキーの技データ ${badCode.length} 件: ${badCode.slice(0, 10).join(", ")}`);
  else good("技データのキーはすべて証券コードの形");
  if (unknownCode.length) bad(`universe に無い銘柄の技: ${unknownCode.join(", ")}`); else good("技データの銘柄はすべて universe にいる");
  if (unlockBad.length) { bad(`必殺技の解放条件に問題 ${unlockBad.length} 件`); for (const k of unlockBad.slice(0, 10)) console.log(`         ${k}`); }
  else good("必殺技の解放条件はすべて既知（awaken / limitUp / earnings / streak）");

  if (universe) {
    const withOwn = Object.keys(moves.stocks || {}).length;
    const total = Object.keys(universe.stocks).length;
    good(`固有技つき ${withOwn} / ${total} 銘柄（残りは業種技だけで戦う）`);
  }
}

// ══════════════ latest.json ══════════════
section("latest.json");
const lPath = resolve(DATA, "latest.json");
let latest = null;
if (!existsSync(lPath)) {
  warn("kabu/data/latest.json がありません（先に fetch-prices.mjs を回してください）");
} else {
  latest = readJson(lPath);
  if (latest.schemaVersion !== 1) bad(`schemaVersion が 1 ではありません（${latest.schemaVersion}）`);
  else good("schemaVersion = 1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latest.date || "")) bad(`date が YYYY-MM-DD ではありません（${latest.date}）`);
  else good(`date = ${latest.date}`);

  // 日付が前回より戻っていないこと（履歴から確認する。`.json` でも `.json.gz` でも同じに見る）
  if (existsSync(DAILY)) {
    const days = [...dailyFiles().keys()];
    const newest = days[days.length - 1];
    if (newest && latest.date < newest) bad(`latest.json の日付 ${latest.date} が履歴の最新 ${newest} より前に戻っています`);
    else good(`日付は履歴と矛盾しない（履歴 ${days.length} 日ぶん）`);
  }

  const REQUIRED = ["close", "prevClose", "chg1", "chgYtd", "ytdPos", "volRatio", "range", "dev25"];
  const codes = Object.keys(latest.stocks || {});
  if (!codes.length) bad("stocks が空です");
  else good(`${codes.length} 銘柄`);

  // 形の検査は「どこで混入したか」を指し示すための診断。NG の判定は下の
  // 「latest にいて universe にいない」に任せる（universe が唯一の名簿なので、
  // そこに無いコードはこの検査を待たずに弾かれる）。二重に NG を出さない。
  const codeBadL = codes.filter((c) => !isCode(c));
  if (codeBadL.length) warn(`証券コードの形でないキーが ${codeBadL.length} 件: ${codeBadL.slice(0, 10).join(", ")}（5 文字は種類株式・優先株式）`);
  else good("キーはすべて証券コードの形（4 文字。数字 4 桁か 数字 3 桁 + 英字）");

  let missField = 0, rangeBad = [], suspectMissing = [];
  for (const c of codes) {
    const s = latest.stocks[c];
    for (const k of REQUIRED) if (!num(s[k])) { missField++; break; }
    if (num(s.ytdPos) && (s.ytdPos < 0 || s.ytdPos > 1)) rangeBad.push(`${c} ytdPos=${s.ytdPos}`);
    if (num(s.close) && s.close <= 0) rangeBad.push(`${c} close=${s.close}`);
    if (num(s.volRatio) && s.volRatio < 0) rangeBad.push(`${c} volRatio=${s.volRatio}`);
    // 前日比 ±60% を超えるなら suspect か split が立っていないとおかしい（§2.1）
    if (num(s.chg1) && Math.abs(s.chg1) > 0.60 && !s.suspect && !s.split) suspectMissing.push(`${c} chg1=${s.chg1}`);
  }
  if (missField) bad(`必須の派生値が欠けている銘柄が ${missField} 件`); else good(`全銘柄に ${REQUIRED.join("・")} がある`);
  if (rangeBad.length) { bad(`値域から外れた項目 ${rangeBad.length} 件`); for (const r of rangeBad.slice(0, 10)) console.log(`         ${r}`); }
  else good("値域（ytdPos 0..1・close > 0・volRatio ≥ 0）はすべて正常");
  if (suspectMissing.length) { bad(`前日比 ±60% 超なのに suspect も split も立っていない銘柄 ${suspectMissing.length} 件`); for (const r of suspectMissing.slice(0, 10)) console.log(`         ${r}`); }
  else good("極端な前日比にはすべて suspect か split が立っている");

  if (universe) {
    const uCodes = Object.keys(universe.stocks).filter((c) => universe.stocks[c].listed);
    const missingInLatest = uCodes.filter((c) => !latest.stocks[c]);
    const extraInLatest = codes.filter((c) => !universe.stocks[c]);
    if (missingInLatest.length) warn(`universe にいて latest にいない銘柄 ${missingInLatest.length} 件: ${missingInLatest.slice(0, 10).join(", ")}`);
    else good("universe の上場銘柄はすべて latest にいる");
    if (extraInLatest.length) bad(`latest にいて universe にいない銘柄 ${extraInLatest.length} 件: ${extraInLatest.slice(0, 10).join(", ")}`);
    else good("latest に余計な銘柄はいない");
  }

  if (!latest.market || !num(latest.market.nk225Chg)) bad("market.nk225Chg がありません");
  else good(`market.nk225Chg = ${latest.market.nk225Chg}`);

  // 時価総額の桁の妥当性。日本最大の企業でも 40 兆円台なので、それを大きく超えたら
  // 発行済株式数（決算）か分割調整のどこかが壊れている。時価総額は体力（§4.2）と
  // レア度（§4.4）と「時価総額 上位 10 = 特性 serene」に直接効くので見張る。
  // 直せるのはデータ層なので「注意」に留める。
  // まず株価そのもの。日本株でいちばん高い銘柄でも 1 株 10 万円台なので、
  // 1 株 1000 万円を超えたら分割・併合の調整が逆向きにかかっている疑いが濃い。
  const CLOSE_ABSURD = 1e7;
  const wildClose = codes
    .filter((c) => num(latest.stocks[c].close) && latest.stocks[c].close > CLOSE_ABSURD)
    .sort((a, b) => latest.stocks[b].close - latest.stocks[a].close);
  if (wildClose.length) {
    warn(`1 株 1000 万円を超える終値 ${wildClose.length} 件（分割・併合の調整が逆向き？）`);
    for (const c of wildClose.slice(0, 10)) {
      const s = latest.stocks[c];
      console.log(`         ${c} close=${s.close}（前日 ${s.prevClose}・chg1=${s.chg1}・split=${s.split == null ? "なし" : s.split}）${universe && universe.stocks[c] ? " " + universe.stocks[c].name : ""}`);
    }
  } else good("終値はすべて 1 株 1000 万円以内（桁が飛んでいない）");

  const MCAP_ABSURD = 200 * 1e12;   // 200 兆円（実在の上限 ≒ 42 兆円の約 5 倍）
  const absurd = codes
    .filter((c) => num(latest.stocks[c].mcap) && latest.stocks[c].mcap > MCAP_ABSURD)
    .sort((a, b) => latest.stocks[b].mcap - latest.stocks[a].mcap);
  if (absurd.length) {
    warn(`時価総額が 200 兆円を超える銘柄 ${absurd.length} 件（発行済株式数か分割調整が壊れている疑い）`);
    for (const c of absurd.slice(0, 10)) {
      const s = latest.stocks[c];
      console.log(`         ${c} ${(s.mcap / 1e12).toFixed(0)} 兆円（close=${s.close}）${universe && universe.stocks[c] ? " " + universe.stocks[c].name : ""}`);
    }
  } else good("時価総額はすべて 200 兆円以内（桁が飛んでいない）");
}

// ══════════════ fin/*.json ══════════════
section("fin/*.json");
const finDir = resolve(DATA, "fin");
if (!existsSync(finDir)) {
  warn("kabu/data/fin/ がありません（素体は暫定式のまま。fetch-fin.mjs を回すと本物になります）");
} else {
  const files = readdirSync(finDir).filter((f) => f.endsWith(".json"));
  good(`${files.length} 銘柄ぶんの決算`);
  let shapeBad = [], negSales = [], badName = [];
  for (const f of files) {
    const code = f.slice(0, -5);
    // 形は診断のみ（NG は下の「universe にいない」が受ける）
    if (!isCode(code)) { badName.push(code); continue; }
    const j = readJson(resolve(finDir, f));
    const t = j.ttm;
    if (!t) { shapeBad.push(`${code}: ttm がない`); continue; }
    for (const k of ["sales", "op", "ni", "assets", "equity", "eqRatio", "shares", "eps", "bps", "salesGrowth", "opmStd"]) {
      if (!num(t[k])) { shapeBad.push(`${code}: ${k} が数値でない`); break; }
    }
    if (num(t.sales) && t.sales <= 0) negSales.push(code);
    if (universe && !universe.stocks[code]) shapeBad.push(`${code}: universe にいない`);
  }
  if (badName.length) warn(`ファイル名が証券コードの形でない決算 ${badName.length} 件: ${badName.slice(0, 10).join(", ")}（5 文字は種類株式・優先株式）`);
  else good("決算のファイル名はすべて証券コードの形");
  if (shapeBad.length) { bad(`決算の形に問題 ${shapeBad.length} 件`); for (const s of shapeBad.slice(0, 10)) console.log(`         ${s}`); }
  else good("すべての決算に必要な項目が揃っている");
  if (negSales.length) bad(`売上が 0 以下の銘柄 ${negSales.length} 件: ${negSales.slice(0, 10).join(", ")}`);
  else good("売上はすべて正");
}

// ══════════════ data/index.json（履歴の目次。設計書 §8.7）══════════════
// ゲームと精算は「どの日が読めるか」をこの目次で知る。ここが実体とずれると
// 404 を取りに行く（＝ゲームが壊れる）ので、実在との一致は NG 扱いにする。
//   { schemaVersion:1, updatedAt, latest, days:[...], archived:["2025"] }
section("data/index.json");
const iPath = resolve(DATA, "index.json");
let index = null;
if (!existsSync(iPath)) {
  warn("kabu/data/index.json がありません（履歴の目次。archive.mjs が作ります）");
} else {
  try { index = readJson(iPath); } catch (e) { bad(`index.json が JSON として読めません: ${e.message}`); }
}
if (index) {
  if (index.schemaVersion !== 1) bad(`schemaVersion が 1 ではありません（${index.schemaVersion}）`);
  else good("schemaVersion = 1");

  if (!isDate(index.updatedAt)) warn(`updatedAt が YYYY-MM-DD ではありません（${index.updatedAt}）`);

  // latest は latest.json の date と一致していること（ずれると違う日を今日として読む）
  if (!isDate(index.latest)) bad(`latest が YYYY-MM-DD ではありません（${index.latest}）`);
  else if (latest && latest.date && index.latest !== latest.date) {
    bad(`index.latest（${index.latest}）が latest.json の date（${latest.date}）と一致しません`);
  } else if (latest) good(`latest = ${index.latest}（latest.json と一致）`);
  else warn(`latest = ${index.latest}（latest.json が無いので突き合わせは省略）`);

  const days = Array.isArray(index.days) ? index.days : null;
  if (!days) bad("days が配列ではありません");
  else {
    const fmtBad = days.filter((d) => !isDate(d));
    if (fmtBad.length) bad(`days に日付の形でない要素が ${fmtBad.length} 件: ${fmtBad.slice(0, 5).join(", ")}`);
    else good(`days は ${days.length} 件すべて YYYY-MM-DD`);

    const dup = days.filter((d, i) => days.indexOf(d) !== i);
    if (dup.length) bad(`days に重複 ${dup.length} 件: ${[...new Set(dup)].slice(0, 5).join(", ")}`);
    else good("days に重複なし");

    const sorted = days.every((d, i) => i === 0 || days[i - 1] <= d);
    if (!sorted) bad("days が昇順ではありません");
    else good("days は昇順");

    if (days.length && index.latest && days[days.length - 1] !== index.latest) {
      warn(`days の末尾（${days[days.length - 1]}）が latest（${index.latest}）と違います`);
    }

    // days に載っている日は実在すること（載っているのに無いと取りに行って 404）
    const have = dailyFiles();
    const ghosts = days.filter((d) => isDate(d) && !have.has(d));
    if (ghosts.length) { bad(`days に載っているのに daily/ に無い日 ${ghosts.length} 件: ${ghosts.slice(0, 8).join(", ")}`); }
    else good(`days の全 ${days.length} 日ぶんが daily/ に実在する`);

    // 逆に実在するのに載っていない日（アーカイブ済みの年は除く）。読み落としになるが
    // ゲームは落ちないので「注意」に留める。
    const archivedYears = new Set((Array.isArray(index.archived) ? index.archived : []).map(String));
    const set = new Set(days);
    const orphans = [...have.keys()].filter((d) => !set.has(d) && !archivedYears.has(d.slice(0, 4)));
    if (orphans.length) warn(`daily/ にあるのに days に無い日 ${orphans.length} 件: ${orphans.slice(0, 8).join(", ")}`);
    else good("daily/ の実体はすべて days に載っている（アーカイブ済みの年を除く）");
  }

  // archived の年は固めた実体があること（無くても今日は遊べるので「注意」）
  const archived = Array.isArray(index.archived) ? index.archived : null;
  if (index.archived !== undefined && !archived) bad("archived が配列ではありません");
  else if (archived && archived.length) {
    const missing = [];
    for (const y of archived) {
      const cand = [
        resolve(DAILY, `${y}.jsonl.gz`),
        resolve(DATA, `${y}.jsonl.gz`),
        resolve(DATA, "archive", `${y}.jsonl.gz`),
        resolve(DAILY, String(y), `${y}.jsonl.gz`)
      ];
      if (!cand.some(existsSync)) missing.push(String(y));
    }
    if (missing.length) warn(`archived に載っているのに <year>.jsonl.gz が見つからない年: ${missing.join(", ")}`);
    else good(`archived の ${archived.length} 年ぶんはすべて <year>.jsonl.gz が実在する`);
  } else if (archived) good("archived は空（まだ年次アーカイブなし）");
}

// ══════════════ 保存容量（設計書 §8.7 リポジトリの肥大化）══════════════
// 日次コミットは git 履歴に永久に積まれる。1 日ぶんが太りすぎていないか毎回見る。
section("保存容量");
{
  const DAY_WARN = 600 * 1024;   // 1 日ぶんの目安（§8.7 は 1 日 60KB 想定。10 倍で注意）
  if (existsSync(lPath)) {
    const n = sizeOf(lPath);
    good(`latest.json = ${kb(n)}`);
  }
  const have = dailyFiles();
  if (!have.size) {
    warn("kabu/data/daily/ に履歴がありません");
  } else {
    const dates = [...have.keys()];
    const newest = dates[dates.length - 1];
    const nPath = resolve(DAILY, have.get(newest));
    const n = sizeOf(nPath);
    good(`daily/ の最新 ${have.get(newest)} = ${kb(n)}（履歴 ${have.size} 日ぶん）`);
    if (n > DAY_WARN) warn(`daily/ の 1 日ぶんが ${kb(n)} あります（目安 ${kb(DAY_WARN)} 超）。薄い形か gzip を検討`);
    else good(`daily/ の 1 日ぶんは目安 ${kb(DAY_WARN)} 以内`);
    let total = 0, big = 0;
    for (const f of have.values()) { const s = sizeOf(resolve(DAILY, f)); if (s > 0) { total += s; if (s > DAY_WARN) big++; } }
    good(`daily/ 合計 ${kb(total)}（年 250 日換算で ${(total / Math.max(1, have.size) * 250 / 1048576).toFixed(1)}MB/年）`);
    if (big > 1) warn(`目安を超える日が ${big} 件あります`);
  }
}

// ══════════════ 通しで組み立てられるか ══════════════
section("ゲームが読めるか（実データで個体を組む）");
if (universe && latest) {
  const codes = Object.keys(universe.stocks).filter((c) => universe.stocks[c].listed && latest.stocks[c]);
  const finOf = (c) => {
    const p = resolve(finDir, `${c}.json`);
    if (!existsSync(p)) return null;
    try { return readJson(p).ttm; } catch { return null; }
  };
  // 特性 serene（時価総額 上位 10）の条件。焼き込みと同じ入力で再計算するためにここでも作る。
  // latest.json 側に mcapTop10 が焼き込まれていればそれに従う（validate が独自に順位を付け直すと、
  // 同じ入力で比べたことにならず「見せかけの不一致」が出る）。
  const bakedTop10 = Object.values(latest.stocks).some((s) => s && "mcapTop10" in s);
  const top10 = new Set(
    bakedTop10
      ? Object.keys(latest.stocks).filter((c) => latest.stocks[c].mcapTop10)
      : Object.entries(latest.stocks)
        .filter(([, s]) => num(s.mcap))
        .sort((a, b) => b[1].mcap - a[1].mcap || (a[0] < b[0] ? -1 : 1))
        .slice(0, 10).map(([c]) => c)
  );
  if (bakedTop10) {
    // 焼き込まれた mcapTop10 が本当に時価総額 上位 10 か（順位付けがずれていないか）
    const want = Object.entries(latest.stocks)
      .filter(([, s]) => num(s.mcap))
      .sort((a, b) => b[1].mcap - a[1].mcap || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10).map(([c]) => c).sort();
    const got = [...top10].sort();
    if (got.length !== 10) warn(`mcapTop10 が立っている銘柄が ${got.length} 件です（10 件のはず）`);
    else if (got.join(",") !== want.join(",")) warn(`mcapTop10 が時価総額 上位 10 と一致しません（焼き込み ${got.join("/")}）`);
    else good("mcapTop10 は時価総額 上位 10 と一致（特性 serene の条件）");
  }
  const TRAIT_VOCAB = new Set(CB.TRAITS.map((t) => t.key));

  const t0 = Date.now();
  // 全上場企業（約 3,500 銘柄）でも無言で長時間かからないよう、大規模なときだけ進捗を出す
  const step = codes.length >= 500 ? Math.ceil(codes.length / 10) : 0;
  let built = 0, statBad = [], moveBad = [], throwBad = [];
  // 焼き込まれた素体（latest.json 側の stats / hp / hpAdd / rare / rareRank / traitKeys / provisional）
  // との突き合わせ。焼き込みが古いとゲームの表示と対戦がずれる。
  let baked = 0, bakeStats = [], bakeRange = [], bakeOther = [], bakeVocab = [];
  // 焼き込まれた決算日（earnings）と KB.isEarningsDay の再計算の突き合わせ。
  // fiscalId が latest 側に焼き込まれていれば「まったく同じ入力」なので食い違いは NG、
  // fin/<code>.json から拾ってきた場合は入力が同じとは言い切れないので「注意」に留める。
  let earnBaked = 0, earnHard = [], earnSoft = [], earnNoFiscal = 0, earnDays = 0;
  const canEarnings = typeof KB.isEarningsDay === "function";
  for (const c of codes) {
    if (step && built && built % step === 0) console.log(`       … ${built}/${codes.length} 銘柄（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    try {
      const st = latest.stocks[c];
      const f = finOf(c);
      const b = KB.buildFromStock({ code: c, u: universe.stocks[c], fin: f, state: st, moves, date: latest.date, mcapTop10: top10.has(c) });
      built++;
      for (const k of CB.STAT_KEYS) if (!(b.stats[k] >= 24 && b.stats[k] <= 100)) statBad.push(`${c} ${k}=${b.stats[k]}`);
      if (!b.moves.length) moveBad.push(c);
      for (const m of b.moves) if (!["strike", "crit", "pierce", "drain", "finisher"].includes(m.kind)) moveBad.push(`${c} ${m.name}(${m.kind})`);
      // 状態を乗せても壊れないこと
      KB.applyMods(b, KB.stateMods(st, latest.market, {}));

      // ── 焼き込みの突き合わせ（焼き込みが無い銘柄は素通り）──
      if (st && st.stats && typeof st.stats === "object") {
        baked++;
        for (const k of CB.STAT_KEYS) {
          if (st.stats[k] !== b.stats[k]) { bakeStats.push(`${c} ${k}: 焼き込み ${st.stats[k]} ≠ 再計算 ${b.stats[k]}`); break; }
        }
        for (const k of CB.STAT_KEYS) {
          if (!(num(st.stats[k]) && st.stats[k] >= 24 && st.stats[k] <= 100)) { bakeRange.push(`${c} ${k}=${st.stats[k]}`); break; }
        }
        if ("hp" in st && st.hp !== b.kabu.hp) bakeOther.push(`${c} hp: ${st.hp} ≠ ${b.kabu.hp}`);
        if ("hpAdd" in st && st.hpAdd !== b.hpAdd) bakeOther.push(`${c} hpAdd: ${st.hpAdd} ≠ ${b.hpAdd}`);
        // rare は 0.85 / 0.72 / … の閾値で rareRank になるだけの生値。ファイルを軽くするために
        // 小数を丸めて焼き込むのは構わないので、丸め幅（1e-3）までは一致とみなす。
        if ("rare" in st && !(num(st.rare) && Math.abs(st.rare - b.kabu.rare) <= 1e-3)) bakeOther.push(`${c} rare: ${st.rare} ≠ ${b.kabu.rare}`);
        if ("rareRank" in st) {
          if (!["SS", "S", "A", "B", "C", "D"].includes(st.rareRank)) bakeVocab.push(`${c} rareRank=${st.rareRank}`);
          else if (st.rareRank !== b.kabu.rareRank) bakeOther.push(`${c} rareRank: ${st.rareRank} ≠ ${b.kabu.rareRank}`);
        }
        if ("traitKeys" in st) {
          if (!Array.isArray(st.traitKeys) || !st.traitKeys.length) bakeVocab.push(`${c} traitKeys が配列でない`);
          else {
            for (const k of st.traitKeys) if (!TRAIT_VOCAB.has(k)) bakeVocab.push(`${c} traitKeys に未知の特性「${k}」`);
            if (st.traitKeys.join("/") !== b.kabu.traitKeys.join("/")) bakeOther.push(`${c} traitKeys: ${st.traitKeys.join("/")} ≠ ${b.kabu.traitKeys.join("/")}`);
          }
        }
        if ("provisional" in st && !!st.provisional !== !!b.kabu.provisional) bakeOther.push(`${c} provisional: ${st.provisional} ≠ ${b.kabu.provisional}`);
      }

      // ── 決算日（earnings）の突き合わせ ──
      if (canEarnings && st && "earnings" in st) {
        earnBaked++;
        if (st.earnings) earnDays++;
        const own = typeof st.fiscalId === "string" && st.fiscalId;
        const fid = own || (f && f.fiscalId);
        if (!fid) earnNoFiscal++;
        else {
          const want = KB.isEarningsDay(latest.date, fid);
          if (!!st.earnings !== want) {
            const msg = `${c} earnings: 焼き込み ${!!st.earnings} ≠ 再計算 ${want}（fiscalId=${fid} → 推定 ${KB.estimatedEarningsDate(fid)}）`;
            (own ? earnHard : earnSoft).push(msg);
          }
        }
      }
    } catch (e) {
      throwBad.push(`${c}: ${e.message}`);
    }
  }
  if (throwBad.length) { bad(`個体を組む途中で落ちた銘柄 ${throwBad.length} 件`); for (const t of throwBad.slice(0, 10)) console.log(`         ${t}`); }
  else good(`${built} 銘柄すべてが例外なく個体になる（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  if (statBad.length) { bad(`ステータスが 24..100 を外れた ${statBad.length} 件`); for (const s of statBad.slice(0, 10)) console.log(`         ${s}`); }
  else good("全銘柄のステータスが 24..100");
  if (moveBad.length) { bad(`エンジンが扱えない技 ${moveBad.length} 件`); for (const m of moveBad.slice(0, 10)) console.log(`         ${m}`); }
  else good("全銘柄の技がエンジンの 5 種に落ちている");

  // ── 焼き込まれた素体の報告 ──
  // 焼き込みがまだ無い latest.json は「注意」まで（データ層の作業中かもしれない）。
  // 焼き込みがあるのに再計算と食い違うのは「データとゲームがずれている」ので NG。
  if (!baked) {
    warn(`latest.json に素体の焼き込み（stats/hp/rare/rareRank/traitKeys/provisional）がありません（${codes.length} 銘柄すべて）`);
  } else {
    good(`素体が焼き込まれている銘柄 ${baked} / ${codes.length}`);
    if (baked < codes.length) warn(`焼き込みが無い銘柄が ${codes.length - baked} 件あります（焼き込み途中？）`);
    if (bakeStats.length) { bad(`焼き込まれた stats が再計算と食い違う銘柄 ${bakeStats.length} 件（焼き込みが古い）`); for (const s of bakeStats.slice(0, 10)) console.log(`         ${s}`); }
    else good("焼き込まれた stats は全銘柄で KB.buildFromStock の結果と一致する");
    if (bakeRange.length) { bad(`焼き込まれた stats が 24..100 を外れた ${bakeRange.length} 件`); for (const s of bakeRange.slice(0, 10)) console.log(`         ${s}`); }
    else good("焼き込まれた stats はすべて 24..100");
    if (bakeVocab.length) { bad(`rareRank / traitKeys が語彙の外 ${bakeVocab.length} 件`); for (const s of bakeVocab.slice(0, 10)) console.log(`         ${s}`); }
    else good("rareRank は SS..D、traitKeys は CB の特性語彙のどれか");
    if (bakeOther.length) { warn(`stats 以外の焼き込みが再計算と食い違う ${bakeOther.length} 件`); for (const s of bakeOther.slice(0, 10)) console.log(`         ${s}`); }
    else good("hp / hpAdd / rare / rareRank / traitKeys / provisional も再計算と一致する");
  }

  // ── 焼き込まれた決算日（§9.3 の決算日ボス・§6.4 の unlock:earnings がこれで決まる）──
  if (!canEarnings) {
    warn("KB.isEarningsDay がありません（決算日の突き合わせは省略）");
  } else if (!earnBaked) {
    warn(`latest.json に earnings の焼き込みがありません（${codes.length} 銘柄すべて。決算日ボスと unlock:earnings が動きません）`);
  } else {
    good(`earnings が焼き込まれている銘柄 ${earnBaked} / ${codes.length}（うち今日が決算日 ${earnDays} 件）`);
    if (earnNoFiscal) warn(`fiscalId が取れず突き合わせできない銘柄 ${earnNoFiscal} 件`);
    if (earnHard.length) { bad(`焼き込まれた earnings が KB.isEarningsDay と食い違う ${earnHard.length} 件`); for (const s of earnHard.slice(0, 10)) console.log(`         ${s}`); }
    else if (earnSoft.length) { warn(`earnings が再計算と食い違う ${earnSoft.length} 件（fiscalId は fin/ から拾った値なので注意止まり）`); for (const s of earnSoft.slice(0, 10)) console.log(`         ${s}`); }
    else good("焼き込まれた earnings は KB.isEarningsDay の再計算と一致する");
  }

  // 日替わり相手が作れること（§7.4）
  const p = KB.protagonists(latest);
  if (!p.up || !p.down || !p.hot) bad(`今日の主役が揃いません: ${JSON.stringify(p)}`);
  else good(`今日の主役: 上${universe.stocks[p.up].short} / 下${universe.stocks[p.down].short} / 出来高${universe.stocks[p.hot].short}`);
} else {
  warn("universe か latest が無いので通し確認は省略");
}

console.log(`\n${checks} OK / ${warns} 注意 / ${errors} NG`);
process.exit(errors ? 1 : 0);
