// scripts/kabu/fetch-fin.mjs
// 決算を取って kabu/data/fin/<code>.json を書く。設計書 §4.1・§8.1。週次で回す。
//
// 素体（攻守速技運）はここで取れた TTM から計算される。決算が無い銘柄は暫定素体のまま。
// 更新が遅れても困らない（§2.1「J-Quants 失敗: 素体は前回のまま」と同じ扱い）。
//
// 全上場企業（約 3,500 社）が対象なので、
//   ・配当は fetch-prices.mjs が日足と一緒に拾って latest.json の div に置いてある。
//     ここでは latest.json から読むだけにして、1 銘柄 1 リクエストで済ませる（以前は 2 本だった）。
//   ・Yahoo に決算が無い銘柄は相当数ある。静かに飛ばして暫定素体のままにし、件数だけ出す。
//
// 使い方:
//   node scripts/kabu/fetch-fin.mjs             … 全銘柄
//   node scripts/kabu/fetch-fin.mjs --limit 5   … 先頭 N 銘柄だけ
//   node scripts/kabu/fetch-fin.mjs --code 7203 … 1 銘柄だけ
//   node scripts/kabu/fetch-fin.mjs --conc 8    … 同時取得数（既定 6）
//   node scripts/kabu/fetch-fin.mjs --dry       … 書き込まない
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./vendor-cb.mjs";
import * as finSource from "./sources/yahoo-fin.mjs";
import * as priceSource from "./sources/yahoo.mjs";

const UNIVERSE = resolve(ROOT, "kabu", "universe.json");
const DATA = resolve(ROOT, "kabu", "data");
const LATEST = resolve(DATA, "latest.json");
const FIN_DIR = resolve(DATA, "fin");

// 決算は 1 銘柄 1 リクエスト（fundamentals-timeseries はまとめて返ってくる）。
// 日足より重いレスポンスなので日足より控えめにする。
const DEFAULT_CONC = 6;

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

async function pool(items, size, worker, label) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  const t0 = Date.now();
  let lastLog = t0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
      done++;
      const now = Date.now();
      if (label && now - lastLog >= 15000 && done < items.length) {
        lastLog = now;
        const rest = Math.round((items.length - done) * ((now - t0) / done) / 1000);
        console.log(`[${label}] ${done} / ${items.length} 件（${((now - t0) / 1000).toFixed(0)} 秒経過・残り ${rest} 秒見込み）`);
      }
    }
  }));
  if (label) console.log(`[${label}] ${done} 件すべて処理しました（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  return out;
}

/**
 * 年間 1 株配当。fetch-prices.mjs が日足の events から拾って latest.json に置いたものを使い回す。
 * まだ latest.json が無い銘柄だけ、その場で日足を取って拾う（初回だけの保険）。
 */
function dividendReader(latest) {
  const table = new Map();
  for (const [code, s] of Object.entries((latest && latest.stocks) || {})) {
    table.set(code, Number(s.div) || 0);
  }
  let borrowed = 0, fetched = 0;
  return {
    async get(code) {
      if (table.has(code)) { borrowed++; return table.get(code); }
      fetched++;
      try {
        const d = await priceSource.fetchDaily(code, { range: "1y" });
        const divs = d.dividends || [];
        if (!divs.length) return 0;
        const cutoff = new Date(Date.now() - 370 * 86400000).toISOString().slice(0, 10);
        return divs.filter((x) => x.date >= cutoff).reduce((s, x) => s + x.amount, 0);
      } catch { return 0; }
    },
    report() { return { borrowed, fetched }; }
  };
}

async function main() {
  if (!existsSync(UNIVERSE)) throw new Error("kabu/universe.json がありません。先に build-universe.mjs を回してください");
  const universe = JSON.parse(readFileSync(UNIVERSE, "utf8"));

  let codes = Object.keys(universe.stocks).filter((c) => universe.stocks[c].listed);
  const one = arg("--code", null);
  if (one) codes = codes.filter((c) => c === one);
  const limit = Number(arg("--limit", 0));
  if (limit > 0) codes = codes.slice(0, limit);
  if (!codes.length) throw new Error("対象の銘柄がありません");
  const conc = Math.max(1, Number(arg("--conc", DEFAULT_CONC)) || DEFAULT_CONC);

  const latest = existsSync(LATEST) ? JSON.parse(readFileSync(LATEST, "utf8")) : null;
  const div = dividendReader(latest);
  if (!latest) console.log("[fin] latest.json がまだありません。配当はその場で日足から拾います（初回だけ）");

  console.log(`[fin] ${codes.length} 銘柄を ${finSource.NAME} から取得（同時 ${conc} 本）`);

  let okCount = 0, pretaxCount = 0;
  // 決算が Yahoo に無い銘柄は珍しくない（新規上場・小型株）。1 件ずつ騒がず、理由ごとに数える
  const reasons = new Map();
  const examples = [];
  const results = await pool(codes, conc, async (code) => {
    try {
      const raw = await finSource.fetchQuarterly(code);
      const ttm = finSource.toTtm(raw, { annualDividend: await div.get(code) });
      okCount++;
      if (ttm.opIsPretax) pretaxCount++;
      return { code, ok: true, ttm };
    } catch (e) {
      // 「該当なし」「四半期が足りない」などをまとめる（銘柄名の部分を落として揃える）
      const why = String(e.message).replace(/^\S+\.T:\s*/, "").replace(/（[^）]*）/g, "").trim() || "不明";
      reasons.set(why, (reasons.get(why) || 0) + 1);
      if (examples.length < 10) examples.push(`${code} ${universe.stocks[code].short}: ${e.message}`);
      return { code, ok: false };
    }
  }, "fin");

  const ng = codes.length - okCount;
  console.log(`[fin] 取得成功 ${okCount} / ${codes.length}（営業利益が無く税引前利益で代用 ${pretaxCount} 件）`);
  const d = div.report();
  console.log(`[fin] 配当: latest.json から使い回し ${d.borrowed} 件 / その場で日足を取ったの ${d.fetched} 件`);
  if (ng) {
    console.log(`[fin] 決算が取れなかった銘柄 ${ng} 件（素体は暫定のまま。異常ではありません）:`);
    for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`    ${n} 件  ${why}`);
    for (const e of examples.slice(0, 5)) console.log(`    例: ${e}`);
  }
  if (okCount === 0) throw new Error("1 銘柄も取得できませんでした。fin は更新しません");

  if (has("--dry")) { console.log("[fin] --dry なので書き込みません"); return; }
  mkdirSync(FIN_DIR, { recursive: true });
  let written = 0, changed = 0;
  for (const r of results) {
    if (!r || !r.ok) continue;
    const path = resolve(FIN_DIR, `${r.code}.json`);
    const body = {
      schemaVersion: 1, code: r.code, source: finSource.NAME,
      updatedAt: new Date().toISOString().slice(0, 10),
      ttm: r.ttm
    };
    const json = JSON.stringify(body, null, 1) + "\n";
    // 中身が変わっていなければ書かない（毎週 99 ファイルが無意味にコミットされるのを避ける）
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    const beforeTtm = before ? safeTtm(before) : null;
    if (beforeTtm && JSON.stringify(beforeTtm) === JSON.stringify(r.ttm)) { written++; continue; }
    writeFileSync(path, json, "utf8");
    written++; changed++;
  }
  console.log(`[fin] ${written} 銘柄（内容が変わって書き直したのは ${changed} 件）→ kabu/data/fin/`);

  // universe から消えた銘柄（上場廃止・種類株式の除外・コード変更）の決算を片付ける。
  // 置いたままだと「universe にいない決算」が残り続け、リポジトリにも検証にも残骸が積もる。
  // 全銘柄を回した時だけ（--limit / --code では消さない。対象外の銘柄まで消してしまう）
  if (!one && !limit) {
    const live = new Set(Object.keys(universe.stocks).map((c) => `${c}.json`));
    const stale = readdirSync(FIN_DIR).filter((f) => f.endsWith(".json") && !live.has(f));
    for (const f of stale) unlinkSync(resolve(FIN_DIR, f));
    if (stale.length) {
      console.log(`[fin] universe にいない決算を ${stale.length} 件片付けました: ` +
        stale.map((f) => f.slice(0, -5)).slice(0, 15).join(", ") + (stale.length > 15 ? " …" : ""));
    }
  }
}

function safeTtm(text) {
  try { return JSON.parse(text).ttm; } catch { return null; }
}

main().catch((e) => { console.error("[fin] " + e.message); process.exit(1); });
