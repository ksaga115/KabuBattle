// scripts/build-kabu.mjs
// index.html（ゲーム本体）を組み立てる。設計書 §0.1・§10。
//
//   src/template.html   … 画面と進行（株バトル固有の部分）
//   BarcodeTool.html    … 対戦エンジン CB を、vendor/BarcodeTool.commit で固定したコミットから借りる
//   src/kabu-core.js    … 決算・株価・事業 → CB が食える個体、に翻訳する中核
//
// 3 つを合成して、リポジトリ直下に単一ファイル index.html を書き出す。
// BarcodeTool.html には一切手を加えない（原本不変）。
//
// 使い方:
//   node scripts/build-kabu.mjs           … index.html を書き出す
//   node scripts/build-kabu.mjs --check   … 書かずに、既存の index.html と一致するかだけ見る
//   node scripts/build-kabu.mjs --update  … 流用元の最新コミットと sha256 を表示する（固定値は手で進める）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ROOT, fetchVendorHtml, extractCB, readPin } from "./kabu/vendor-cb.mjs";

const TEMPLATE = resolve(ROOT, "src", "template.html");
const CORE = resolve(ROOT, "src", "kabu-core.js");
const OUT = resolve(ROOT, "index.html");

const has = (n) => process.argv.includes(n);

async function showUpdate() {
  const pin = readPin();
  const api = `https://api.github.com/repos/${pin.repo}/commits/HEAD`;
  const res = await fetch(api, { headers: { "User-Agent": "KabuBattle", Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`最新コミットが引けません（${res.status}）`);
  const head = (await res.json()).sha;
  if (head === pin.commit) { console.log(`[build] すでに最新です（${head.slice(0, 8)}）`); return; }
  const raw = await fetch(`https://raw.githubusercontent.com/${pin.repo}/${head}/${pin.file}`);
  if (!raw.ok) throw new Error(`${pin.file} が取れません（${raw.status}）`);
  const buf = Buffer.from(await raw.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  console.log(`[build] 流用元に新しいコミットがあります。vendor/BarcodeTool.commit を書き換えてください:`);
  console.log(`  commit=${head}`);
  console.log(`  sha256=${sha}`);
  console.log(`  （書き換えたあと node scripts/build-kabu.mjs と node scripts/kabu/sim.mjs を回して、`);
  console.log(`    決定論・A/B 対称・勝率曲線が崩れていないことを確かめること）`);
}

export async function build() {
  for (const p of [TEMPLATE, CORE]) {
    if (!existsSync(p)) throw new Error(`見つかりません: ${p}`);
  }
  const { html, pin, from } = await fetchVendorHtml();
  const cb = extractCB(html);
  const core = readFileSync(CORE, "utf8");
  const tpl = readFileSync(TEMPLATE, "utf8");

  let out = tpl;
  const put = (marker, code) => {
    if (!out.includes(marker)) throw new Error(`テンプレートに目印がありません: ${marker}`);
    out = out.replace(marker, () => code);   // 置換文字列中の $ を特別扱いさせない
  };
  put("/*__CB_ENGINE__*/", cb);
  put("/*__KABU_CORE__*/", core);
  put("__ENGINE_COMMIT__", pin.commit.slice(0, 8));
  put("__BUILD_DATE__", new Date().toISOString().slice(0, 10));

  const left = out.replace(/__proto__/g, "").match(/__[A-Z_]+__/g);
  if (left) throw new Error("未置換の目印が残っています: " + [...new Set(left)].join(", "));

  // 単一 HTML の確認。実行時に kabu/*.json を fetch するのは設計どおりだが、
  // 外部ファイルを <script src> や <link href> で読むことは無いはず。
  const suspects = [];
  for (const m of out.matchAll(/<link\s[^>]*href=["']([^"']+)["']/gi)) suspects.push(["<link>", m[1]]);
  for (const m of out.matchAll(/<script\s[^>]*src=["']([^"']+)["']/gi)) suspects.push(["<script src>", m[1]]);
  for (const m of out.matchAll(/<img\s[^>]*src=["']([^"']+)["']/gi)) if (!/^data:/i.test(m[1])) suspects.push(["<img src>", m[1]]);
  if (suspects.length) {
    suspects.forEach(([t, r]) => console.error(`  ${t}: ${r}`));
    throw new Error("外部ファイル参照が含まれています（index.html は自己完結の想定）");
  }

  // 組み込んだ部品が生きているかの軽い確認（黙って壊れた HTML を出さない）
  for (const needle of ["function squadMatch(", "function buildFromStock(", "KB.protagonists", "kabu/data/latest.json"]) {
    if (!out.includes(needle)) throw new Error(`組み立て結果に ${needle} が含まれていません`);
  }
  return { out, pin, from };
}

if (has("--update")) {
  showUpdate().catch((e) => { console.error("[build] " + e.message); process.exit(1); });
} else {
  build().then(({ out, pin, from }) => {
    if (has("--check")) {
      const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
      // ビルド日付だけは毎日変わるので、比較から外す
      const strip = (s) => s.replace(/ビルド \d{4}-\d{2}-\d{2}/, "ビルド ----");
      if (strip(cur) === strip(out)) { console.log("[build] index.html はソースと一致しています"); return; }
      console.error("[build] index.html がソースと一致しません。node scripts/build-kabu.mjs を回してください");
      process.exit(1);
    }
    writeFileSync(OUT, out, "utf8");
    console.log(`[build] 生成: index.html（${(out.length / 1024).toFixed(0)} KB・エンジン ${pin.commit.slice(0, 8)}・取得元 ${from}）`);
  }).catch((e) => { console.error("[build] " + e.message); process.exit(1); });
}
