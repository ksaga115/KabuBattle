// scripts/kabu/archive.mjs
// 古い年の日次スナップショットを 1 ファイルに畳む年次ジョブ。設計書 §8.7。
//
//   kabu/data/daily/<年>-*.json.gz   →   kabu/data/daily/<年>.jsonl.gz（1 行 1 日の JSON・日付昇順・gzip）
//
// 1 日ぶんは `<日付>.json.gz`（既定）でも `<日付>.json`（昔の形）でもよい。どちらも読む。
//
// daily/ は 1 日ぶん × 250 営業日で年 15MB 前後まで増える。ゲームが読むのは latest.json と
// 直近 60 日ぶんだけなので（§7.1）、古い年は畳んでしまってよい。畳んだ年は index.json の
// archived に載るので、ゲームは「その年は日次が無い」と分かる。
//
// 今年と去年は畳まない。年明けに走らせても直近 60 日が必ず日次のまま残るようにするため。
//
// 使い方:
//   node scripts/kabu/archive.mjs                 … 畳める年を自動で選んで畳む
//   node scripts/kabu/archive.mjs --dry           … 何をするかだけ表示（書き込まない）
//   node scripts/kabu/archive.mjs --year 2025     … 年を指定
//   node scripts/kabu/archive.mjs --year 2025 --force   … 今年・去年の禁止を解く（普段は使わない）
//   node scripts/kabu/archive.mjs --restore 2025  … 畳んだ年を <日付>.json に戻す（往復の確認・巻き戻し）
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { ROOT } from "./vendor-cb.mjs";
import { buildIndex, writeIndex } from "./fetch-prices.mjs";

const DATA = resolve(ROOT, "kabu", "data");
const DAILY_DIR = resolve(DATA, "daily");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const DATE_JSON = /^(\d{4})-\d{2}-\d{2}\.json(\.gz)?$/;
const DAILY_EXT = ".json.gz";     // 書き戻す（--restore）ときの形。fetch-prices.mjs と揃える
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/** <年>.jsonl.gz の置き場所 */
export function archivePath(year) {
  return resolve(DAILY_DIR, `${year}.jsonl.gz`);
}

/** 1 日ぶんを読む（.json.gz でも .json でもよい） */
function readDay(file) {
  const buf = readFileSync(resolve(DAILY_DIR, file));
  return JSON.parse((file.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8"));
}

// ══════════════ 畳む・開く（ここだけで形が決まる）══════════════

/**
 * 日次スナップショットの配列を JSONL + gzip に畳む。
 * @param {Array<{date:string, obj:object}>} days 日付昇順
 * @returns {Buffer}
 */
export function packDays(days) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let seen = null;
  for (const d of sorted) {
    if (d.date === seen) throw new Error(`同じ日付が 2 回あります: ${d.date}`);
    seen = d.date;
    // 日付は中身の date から復元する。ファイル名と食い違うなら畳まない（黙って壊さない）
    if (d.obj && d.obj.date !== d.date) {
      throw new Error(`${d.date}.json の中の date が「${d.obj && d.obj.date}」で食い違っています`);
    }
  }
  // 改行を含まない 1 行 1 日。JSON.stringify は既定で改行を出さないのでそのまま行になる
  const text = sorted.map((d) => JSON.stringify(d.obj)).join("\n") + "\n";
  return gzipSync(Buffer.from(text, "utf8"), { level: 9 });
}

/**
 * 畳んだものを開く（元の日次スナップショットの配列に戻す）。
 * @param {Buffer} buf
 * @returns {Array<{date:string, obj:object}>}
 */
export function unpackDays(buf) {
  const text = gunzipSync(buf).toString("utf8");
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { throw new Error(`${i + 1} 行目が JSON ではありません: ${e.message}`); }
    if (!obj || typeof obj.date !== "string") throw new Error(`${i + 1} 行目に date がありません`);
    out.push({ date: obj.date, obj });
  });
  return out;
}

/** 畳んだ年を読む（ゲーム側から使う想定は無いが、巻き戻しと検証に使う） */
export function readArchive(year) {
  const p = archivePath(year);
  if (!existsSync(p)) throw new Error(`${year}.jsonl.gz がありません`);
  return unpackDays(readFileSync(p));
}

// ══════════════ 走査 ══════════════

/** daily/ にある 1 日ぶんのファイルを年ごとに集める（日付 → ファイル名） */
function scanDaily() {
  if (!existsSync(DAILY_DIR)) return new Map();
  const byYear = new Map();
  for (const f of readdirSync(DAILY_DIR).sort()) {
    const m = DATE_JSON.exec(f);
    if (!m) continue;
    if (!byYear.has(m[1])) byYear.set(m[1], new Map());
    const days = byYear.get(m[1]);
    const date = f.slice(0, 10);
    if (!days.has(date)) days.set(date, f);   // 同じ日が .json と .json.gz の両方にあれば先頭（.json）
  }
  return byYear;
}

/** 畳んでよい年（今年と去年は除く）。設計書 §8.7 */
function foldableYears(byYear, thisYear) {
  return [...byYear.keys()].filter((y) => Number(y) <= thisYear - 2).sort();
}

// ══════════════ 畳む ══════════════

function fold(year, files, { dry }) {
  const days = [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, file]) => {
    let obj;
    try { obj = readDay(file); }
    catch (e) { throw new Error(`${file} が読めません: ${e.message}`); }
    return { date, file, obj, bytes: statSync(resolve(DAILY_DIR, file)).size };
  });
  const before = days.reduce((s, d) => s + d.bytes, 0);

  // 既に畳んだ年に日次が足されていた場合は取り込んで作り直す（新しいほうを採る）
  let merged = days;
  if (existsSync(archivePath(year))) {
    const old = readArchive(year);
    const m = new Map(old.map((d) => [d.date, d]));
    for (const d of days) m.set(d.date, d);
    merged = [...m.values()];
    console.log(`[archive] ${year}: 既存の ${year}.jsonl.gz に ${old.length} 日ぶんあるので合わせて作り直します`);
  }

  const buf = packDays(merged);
  console.log(`[archive] ${year}: ${days.length} 日ぶん ${kb(before)} → ${year}.jsonl.gz ${kb(buf.length)}` +
    `（${(buf.length / before * 100).toFixed(1)}%、合計 ${merged.length} 日）`);

  // 畳んだものから元に戻せることを確かめてから消す（戻せないなら消してはいけない）
  const back = new Map(unpackDays(buf).map((d) => [d.date, d.obj]));
  const ng = [];
  for (const d of merged) {
    const got = back.get(d.date);
    if (!got) { ng.push(`${d.date} が入っていない`); continue; }
    if (JSON.stringify(got) !== JSON.stringify(d.obj)) ng.push(`${d.date} の中身が一致しない`);
  }
  if (back.size !== merged.length) ng.push(`日数が ${merged.length} → ${back.size} で合わない`);
  if (ng.length) throw new Error(`往復の確認に失敗しました（${year}）: ` + ng.slice(0, 5).join("・"));
  console.log(`[archive] ${year}: 往復の確認 OK（${merged.length} 日すべて一致）`);

  if (dry) {
    console.log(`[archive] ${year}: --dry なので書き込みません（消す予定 ${days.length} ファイル）`);
    return { year, days: days.length, before, after: buf.length, written: false };
  }

  writeFileSync(archivePath(year), buf);
  for (const d of days) unlinkSync(resolve(DAILY_DIR, d.file));
  console.log(`[archive] ${year}: 1 日ぶんのファイルを ${days.length} 件削除しました`);
  return { year, days: days.length, before, after: buf.length, written: true };
}

// ══════════════ 戻す ══════════════

function restore(year, { dry }) {
  const days = readArchive(year);
  console.log(`[archive] ${year}: ${days.length} 日ぶんを <日付>${DAILY_EXT} に戻します`);
  if (dry) { console.log(`[archive] ${year}: --dry なので書き込みません`); return days.length; }
  mkdirSync(DAILY_DIR, { recursive: true });
  for (const d of days) {
    const body = Buffer.from(JSON.stringify(d.obj) + "\n", "utf8");
    writeFileSync(resolve(DAILY_DIR, `${d.date}${DAILY_EXT}`), gzipSync(body, { level: 9 }));
  }
  unlinkSync(archivePath(year));
  const idx = writeIndex(buildIndex({ removeArchived: [String(year)] }));
  console.log(`[archive] ${year}: 戻しました。index.json の履歴は ${idx.days.length} 日` +
    `${idx.archived.length ? ` / アーカイブ済み ${idx.archived.join("・")} 年` : ""}`);
  return days.length;
}

// ══════════════ 入口 ══════════════

function main() {
  const dry = has("--dry");
  const thisYear = new Date().getFullYear();
  const byYear = scanDaily();

  const restoreYear = arg("--restore", null);
  if (restoreYear) {
    if (!/^\d{4}$/.test(restoreYear)) throw new Error(`--restore には 4 桁の年を渡してください（${restoreYear}）`);
    restore(restoreYear, { dry });
    return;
  }

  const want = arg("--year", null);
  let years;
  if (want) {
    if (!/^\d{4}$/.test(want)) throw new Error(`--year には 4 桁の年を渡してください（${want}）`);
    if (!byYear.has(want)) {
      console.log(`[archive] ${want} 年の日次スナップショットは daily/ にありません。何もしません`);
      return;
    }
    if (Number(want) > thisYear - 2 && !has("--force")) {
      throw new Error(`${want} は今年（${thisYear}）か去年なので畳みません。` +
        `ゲームは直近 60 日を読むので日次のまま残します（設計書 §8.7）。どうしても畳むなら --force`);
    }
    years = [want];
  } else {
    years = foldableYears(byYear, thisYear);
    if (!years.length) {
      const have = [...byYear.keys()].sort();
      console.log(`[archive] 畳める年はありません` +
        `（daily/ にあるのは ${have.length ? have.join("・") + " 年" : "0 日ぶん"}。今年 ${thisYear} と去年 ${thisYear - 1} は畳まない）`);
      return;
    }
    console.log(`[archive] 畳める年: ${years.join("・")}（今年 ${thisYear} と去年 ${thisYear - 1} は残す）`);
  }

  const done = [];
  for (const y of years) done.push(fold(y, byYear.get(y), { dry }));

  if (!dry && done.some((d) => d.written)) {
    const idx = writeIndex(buildIndex({ addArchived: done.filter((d) => d.written).map((d) => d.year) }));
    console.log(`[archive] index.json を更新: 履歴 ${idx.days.length} 日 / アーカイブ済み ${idx.archived.join("・")} 年`);
  }
  const before = done.reduce((s, d) => s + d.before, 0);
  const after = done.reduce((s, d) => s + d.after, 0);
  console.log(`[archive] ${done.length} 年ぶん・${done.reduce((s, d) => s + d.days, 0)} 日ぶん: ${kb(before)} → ${kb(after)}` +
    `${dry ? "（--dry: 書き込んでいません）" : ""}`);
}

if (process.argv[1] && process.argv[1].endsWith("archive.mjs")) {
  try { main(); } catch (e) { console.error("[archive] " + e.message); process.exit(1); }
}
