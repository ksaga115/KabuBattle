// scripts/kabu/load.mjs
// 対戦エンジン（src/engine.js）と中核（src/kabu-core.js）を Node で一緒に評価する。
// ブラウザでは index.html に同じ 2 本を同じ順で埋め込むので、
// Node とブラウザで「同じソース・同じ並び」が動く（変換なし）。
//
// 以前は BarcodeTool の固定コミットから毎回取ってきていたが、エンジンごと
// 株バトルに取り込んだので通信は要らない（src/engine.js の冒頭に出どころと変更点がある）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, SRC } from "./paths.mjs";

export { ROOT };
export const ENGINE_PATH = resolve(SRC, "engine.js");
export const CORE_PATH = resolve(SRC, "kabu-core.js");

export function readEngine() { return readFileSync(ENGINE_PATH, "utf8"); }
export function readCore() { return readFileSync(CORE_PATH, "utf8"); }

/** エンジンの中身が生きているかの軽い確認（黙って壊れたものを埋め込まないため） */
export function checkEngine(src) {
  const needles = [
    "function beastOf(", "function battle(", "function squadBattle(", "function squadMatch(",
    "function affinity(", "function mkFighter(", "const STAT_KEYS =", "const ELEMENTS =", "const TRAITS =",
    "(beast.hpAdd || 0)"   // 株バトルのための追加枠（src/engine.js の冒頭に理由がある）
  ];
  for (const n of needles) if (!src.includes(n)) throw new Error(`src/engine.js に ${n} がありません`);
  // 画面に依存していないこと（エンジンは純粋な計算だけ）
  for (const bad of ["document.", "localStorage", "window."]) {
    if (src.includes(bad)) throw new Error(`src/engine.js に ${bad} が含まれています（エンジンは画面に依存しない想定）`);
  }
  return src;
}

/** @returns {Promise<{CB:object, KB:object, engineSource:string, coreSource:string}>} */
export async function loadCore() {
  const engineSource = checkEngine(readEngine());
  const coreSource = readCore();
  const fn = new Function(`"use strict";${engineSource};${coreSource};return { CB: CB, KB: KB };`);
  const { CB, KB } = fn();
  for (const k of ["buildFromStock", "stateMods", "applyMods", "sectorElem", "protagonists"]) {
    if (typeof KB[k] !== "function") throw new Error(`KB.${k} がありません`);
  }
  for (const k of ["beastOf", "battle", "match", "squadBattle", "squadMatch", "affinity", "rankOf"]) {
    if (typeof CB[k] !== "function") throw new Error(`CB.${k} がありません`);
  }
  return { CB, KB, engineSource, coreSource };
}
