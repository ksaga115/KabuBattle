// scripts/kabu/paths.mjs
// リポジトリの場所だけを持つ。どの道具からも同じ場所を指せるように。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Windows で日本語のフォルダ名が入っていると import.meta.url の pathname は
// percent エンコードされているので、必ず fileURLToPath を通す
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SRC = resolve(ROOT, "src");
export const KABU = resolve(ROOT, "kabu");
export const DATA = resolve(KABU, "data");
