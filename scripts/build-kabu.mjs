// scripts/build-kabu.mjs
// index.html（ゲーム本体）を組み立てる。
//
//   src/engine.js      … 対戦エンジン（コードバトルの CB。出どころと変更点はファイル冒頭）
//   src/kabu-core.js   … 決算・株価・事業 → エンジンが食える個体に翻訳する中核
//   src/template.html  … 画面と進行
//
// 3 つを合成して、リポジトリ直下に単一ファイル index.html を書き出す。
// 以前は BarcodeTool の固定コミットからエンジンを取ってきていたが、取り込んだので通信は無い。
//
// 使い方:
//   node scripts/build-kabu.mjs           … index.html を書き出す
//   node scripts/build-kabu.mjs --check   … 書かずに、既存の index.html と一致するかだけ見る
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./kabu/paths.mjs";
import { readEngine, readCore, checkEngine, ENGINE_PATH, CORE_PATH } from "./kabu/load.mjs";

const TEMPLATE = resolve(ROOT, "src", "template.html");
const OUT = resolve(ROOT, "index.html");

const has = (n) => process.argv.includes(n);

/** エンジンの出どころ（src/engine.js の冒頭に書いてあるコミット）を拾って footer に出す */
function engineOrigin(src) {
  const m = src.match(/コミット\s+([0-9a-f]{40})/);
  return m ? m[1].slice(0, 8) : "同梱";
}

export function build() {
  for (const p of [TEMPLATE, ENGINE_PATH, CORE_PATH]) {
    if (!existsSync(p)) throw new Error(`見つかりません: ${p}`);
  }
  const engine = checkEngine(readEngine());
  const core = readCore();
  const tpl = readFileSync(TEMPLATE, "utf8");

  let out = tpl;
  const put = (marker, code) => {
    if (!out.includes(marker)) throw new Error(`テンプレートに目印がありません: ${marker}`);
    out = out.replace(marker, () => code);   // 置換文字列中の $ を特別扱いさせない
  };
  put("/*__CB_ENGINE__*/", engine);
  put("/*__KABU_CORE__*/", core);
  put("__ENGINE_COMMIT__", engineOrigin(engine));
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

  // 組み込んだ部品が生きているかの軽い確認
  for (const needle of ["function squadMatch(", "function buildFromStock(", "KB.protagonists", "kabu/data/latest.json"]) {
    if (!out.includes(needle)) throw new Error(`組み立て結果に ${needle} が含まれていません`);
  }
  return out;
}

const out = build();
if (has("--check")) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  // ビルド日付だけは毎日変わるので、比較から外す
  const strip = (s) => s.replace(/ビルド \d{4}-\d{2}-\d{2}/, "ビルド ----");
  if (strip(cur) === strip(out)) { console.log("[build] index.html はソースと一致しています"); }
  else {
    console.error("[build] index.html がソースと一致しません。node scripts/build-kabu.mjs を回してください");
    process.exit(1);
  }
} else {
  writeFileSync(OUT, out, "utf8");
  console.log(`[build] 生成: index.html（${(out.length / 1024).toFixed(0)} KB）`);
}
