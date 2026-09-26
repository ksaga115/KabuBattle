// scripts/kabu/xlsx.mjs
// JPX「東証上場銘柄一覧」（data_j.xlsx）を読むための、依存ゼロの最小 xlsx リーダー。
// 設計書 §2 の「33 業種・社名・上場状態」の取得元。
//
// npm の xlsx パッケージを足さないのは、恒常的に回るワークフローの依存を増やしたくないから。
// .xlsx は ZIP なので、Node 標準の zlib.inflateRawSync だけで中の XML を取り出せる。
// 汎用の表計算リーダーではなく「この 1 ファイルの形」を読むための割り切った実装。
import { inflateRawSync } from "node:zlib";

// ══════════════ ZIP ══════════════
const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50;

/** ZIP の中身を {名前: Buffer} で返す（必要なエントリだけ展開する） */
export function unzip(buf, wanted) {
  // 末尾から EOCD（終端レコード）を探す。コメントは最大 65535 バイト。
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP の終端レコードが見つかりません（xlsx として読めません）");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);   // 中央ディレクトリの開始位置
  const out = Object.create(null);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error(`中央ディレクトリが壊れています（entry ${i}）`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (wanted && !wanted.includes(name)) continue;

    // ローカルヘッダ（30 バイト固定 + 名前 + 拡張）を飛ばして本体へ
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnLen + leLen;
    const raw = buf.subarray(start, start + compSize);
    out[name] = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
  }
  return out;
}

// ══════════════ SpreadsheetML ══════════════
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

function unescapeXml(s) {
  return s.replace(/&(?:amp|lt|gt|quot|apos);|&#x?[0-9a-fA-F]+;/g, (m) => {
    if (ENT[m]) return ENT[m];
    const hex = m[2] === "x" || m[2] === "X";
    const code = parseInt(m.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** sharedStrings.xml → 文字列の配列。<si> の中の <t> をすべて連ねる（書式で分割された文字列に対応） */
export function parseSharedStrings(xml) {
  const out = [];
  for (const si of xml.split("<si>").slice(1)) {
    const body = si.slice(0, si.indexOf("</si>"));
    let s = "";
    for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1];
    out.push(unescapeXml(s));
  }
  return out;
}

const colOf = (ref) => {
  let n = 0;
  for (const ch of ref) {
    if (ch < "A" || ch > "Z") break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
};

/** sheet1.xml → 行の配列（各行はセル文字列の配列。空セルは "" で埋める） */
export function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[3] || "";
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || "n";
      let v = "";
      if (type === "inlineStr") {
        for (const t of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) v += t[1];
        v = unescapeXml(v);
      } else {
        const vm = body.match(/<v>([\s\S]*?)<\/v>/);
        const raw = vm ? unescapeXml(vm[1]) : "";
        v = type === "s" ? (shared[Number(raw)] ?? "") : raw;
      }
      const ci = ref ? colOf(ref) : cells.length;
      while (cells.length < ci) cells.push("");
      cells[ci] = v;
    }
    rows.push(cells);
  }
  return rows;
}

/** xlsx の Buffer → 1 枚目のシートの行配列 */
export function readXlsx(buf) {
  const files = unzip(buf, ["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]);
  const sheet = files["xl/worksheets/sheet1.xml"];
  if (!sheet) throw new Error("xl/worksheets/sheet1.xml が見つかりません");
  const shared = files["xl/sharedStrings.xml"] ? parseSharedStrings(files["xl/sharedStrings.xml"].toString("utf8")) : [];
  return parseSheet(sheet.toString("utf8"), shared);
}
