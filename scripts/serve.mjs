// scripts/serve.mjs
// 手元で遊ぶための簡易サーバー。ゲームは kabu/*.json を fetch するので、
// file:// で index.html を直接開くとブラウザの制限で読み込めない。
//
//   node scripts/serve.mjs         → http://127.0.0.1:8787/
//   node scripts/serve.mjs 9000    → ポートを変える
//
// 公開は GitHub Pages（main の / を配信）なので、これは開発中だけのもの。
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { resolve, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// URL から素の道に戻す。Windows で日本語のフォルダ名が入っていると
// pathname は percent エンコードされているので fileURLToPath を通す必要がある。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2]) || 8787;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8"
};

createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = resolve(root, "." + normalize(p));
  if (!file.startsWith(root)) { res.writeHead(403).end("403"); return; }
  try { statSync(file); } catch { res.writeHead(404).end("404 " + p); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}/ で株バトルが開きます（Ctrl+C で終了）`);
});
