// scripts/kabu/vendor-cb.mjs
// 対戦エンジン CB を BarcodeTool から借りてくる係。設計書 §0.1。
//
//   vendor/BarcodeTool.commit に固定したコミットから BarcodeTool.html を取得し、
//   `const CB = (function () { ... })();` の区間だけを切り出す。
//   ・ブラウザ向け（scripts/build-kabu.mjs）は切り出した文字列を index.html に埋め込む。
//   ・Node 向け（sim.mjs / validate.mjs）は evalCB() でその場で評価して CB オブジェクトを得る。
//
// BarcodeTool.html には一切手を加えない（原本不変）。取得物は sha256 で照合するので、
// 原本が動いても気づかずに違うエンジンでビルドすることはない。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PIN = resolve(ROOT, "vendor", "BarcodeTool.commit");
const CACHE_DIR = resolve(ROOT, "vendor", "cache");

/** vendor/BarcodeTool.commit を読む（`key=value` の羅列。`#` 以降は注釈） */
export function readPin() {
  if (!existsSync(PIN)) throw new Error(`固定ファイルがありません: ${PIN}`);
  const pin = {};
  for (const line of readFileSync(PIN, "utf8").split(/\r?\n/)) {
    const s = line.replace(/#.*$/, "").trim();
    if (!s) continue;
    const i = s.indexOf("=");
    if (i > 0) pin[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  for (const k of ["repo", "commit", "file", "sha256"]) {
    if (!pin[k]) throw new Error(`vendor/BarcodeTool.commit に ${k} がありません`);
  }
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error(`commit が 40 桁の SHA ではありません: ${pin.commit}`);
  if (!/^[0-9a-f]{64}$/.test(pin.sha256)) throw new Error(`sha256 が 64 桁ではありません: ${pin.sha256}`);
  return pin;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * 固定コミットの BarcodeTool.html を返す。一度取ったら vendor/cache/ に置いて使い回すので、
 * 2 回目以降は通信しない（Actions でも毎日 534KB を落とさない）。
 * @param {{allowFetch?: boolean, expectSha?: boolean}} opt
 */
export async function fetchVendorHtml(opt = {}) {
  const { allowFetch = true, expectSha = true } = opt;
  const pin = readPin();
  const cached = resolve(CACHE_DIR, `BarcodeTool-${pin.commit}.html`);

  if (existsSync(cached)) {
    const buf = readFileSync(cached);
    const got = sha256(buf);
    if (!expectSha || got === pin.sha256) return { html: buf.toString("utf8"), pin, from: "cache" };
    throw new Error(
      `キャッシュの sha256 が固定値と合いません。壊れている可能性があるので消してやり直してください。\n` +
      `  ${cached}\n  期待 ${pin.sha256}\n  実際 ${got}`
    );
  }
  if (!allowFetch) throw new Error(`キャッシュがなく、取得も許可されていません: ${cached}`);

  const url = `https://raw.githubusercontent.com/${pin.repo}/${pin.commit}/${pin.file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`取得に失敗しました（${res.status}）: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (expectSha && got !== pin.sha256) {
    throw new Error(
      `取得した ${pin.file} の sha256 が固定値と合いません。\n` +
      `  ${url}\n  期待 ${pin.sha256}\n  実際 ${got}\n` +
      `エンジンを更新したいなら vendor/BarcodeTool.commit の commit と sha256 を両方進めてください。`
    );
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cached, buf);
  return { html: buf.toString("utf8"), pin, from: "fetch", sha256: got };
}

// CB は「行頭の `const CB = (function () {`」から「行頭の `})();`」までの自己完結した IIFE。
// 行頭 `})();` は BarcodeTool.html 全体で CB の閉じ括弧 1 か所だけ（他はすべて字下げされている）。
const CB_START = /^const CB = \(function \(\) \{$/m;
const CB_END = /^\}\)\(\);$/m;

/** BarcodeTool.html から CB の定義（文字列）を切り出す */
export function extractCB(html) {
  const s = html.match(CB_START);
  if (!s) throw new Error("CB の開始が見つかりません（BarcodeTool.html の構造が変わった可能性）");
  const rest = html.slice(s.index);
  const e = rest.match(CB_END);
  if (!e) throw new Error("CB の終了（行頭の `})();`）が見つかりません");
  const code = rest.slice(0, e.index + e[0].length);

  // 抜き出しが成功していることを、中身の目印で確かめる（黙って壊れたエンジンを埋め込まないため）
  const needles = [
    "function beastOf(", "function battle(", "function squadBattle(", "function squadMatch(",
    "function affinity(", "function mkFighter(", "const STAT_KEYS =", "const ELEMENTS =", "const TRAITS ="
  ];
  for (const n of needles) {
    if (!code.includes(n)) throw new Error(`CB の抜き出し結果に ${n} が含まれていません`);
  }
  // 外の世界に触っていないこと（純粋な計算だけであること）の軽い確認
  for (const bad of ["document.", "localStorage", "window."]) {
    if (code.includes(bad)) throw new Error(`CB に ${bad} が含まれています（CB は画面に依存しない想定）`);
  }
  return code;
}

/** 切り出した CB を Node で評価して CB オブジェクトを返す（sim / validate 用） */
export function evalCB(cbSource) {
  // CB は self-contained なので、素の関数スコープで評価すれば足りる。
  const fn = new Function(`"use strict";${cbSource};return CB;`);
  const CB = fn();
  for (const k of ["beastOf", "battle", "match", "squadBattle", "squadMatch", "affinity", "rankOf", "ELEMENTS", "TRAITS", "STAT_KEYS"]) {
    if (CB[k] == null) throw new Error(`CB.${k} がありません`);
  }
  return CB;
}

/** 取得 → 切り出し → 評価 をまとめた入口 */
export async function loadCB(opt) {
  const { html, pin, from } = await fetchVendorHtml(opt);
  const source = extractCB(html);
  return { CB: evalCB(source), source, pin, from };
}
