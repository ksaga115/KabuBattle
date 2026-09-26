// scripts/kabu/load.mjs
// CB（BarcodeTool から借りたエンジン）と KB（src/kabu-core.js）を Node で一緒に評価する。
// ブラウザでは index.html に同じ 2 本を同じ順で並べて埋め込むので、
// Node とブラウザで「同じソース・同じ並び」が動く（変換なし）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, fetchVendorHtml, extractCB } from "./vendor-cb.mjs";

export const CORE_PATH = resolve(ROOT, "src", "kabu-core.js");

export function readCore() { return readFileSync(CORE_PATH, "utf8"); }

/** @returns {Promise<{CB:object, KB:object, cbSource:string, coreSource:string, pin:object}>} */
export async function loadCore(opt) {
  const { html, pin } = await fetchVendorHtml(opt);
  const cbSource = extractCB(html);
  const coreSource = readCore();
  const fn = new Function(`"use strict";${cbSource};${coreSource};return { CB: CB, KB: KB };`);
  const { CB, KB } = fn();
  for (const k of ["buildFromStock", "stateMods", "applyMods", "sectorElem", "protagonists"]) {
    if (typeof KB[k] !== "function") throw new Error(`KB.${k} がありません`);
  }
  return { CB, KB, cbSource, coreSource, pin };
}
