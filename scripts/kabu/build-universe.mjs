// scripts/kabu/build-universe.mjs
// 銘柄マスタ kabu/universe.json を作る／更新する。設計書 §3・§8.2・§8.4。
//
//   出所 1: JPX「東証上場銘柄一覧」data_j.xlsx  … コード・社名・33 業種・市場区分・規模区分（月次）
//   出所 2: 日経公式の構成銘柄ページ            … 日経 225 のメンバーシップ（入替時）
//
// 既にある universe.json は上書きではなく「更新」する。ID（証券コード）は不変で、
// 社名変更は renamedFrom に積み、上場廃止は listed:false + delistedAt を立てるだけ（消さない）。
// 契約中の銘柄が消えると困るので、一度入った銘柄は指数から外れても残す。
//
// 使い方:
//   node scripts/kabu/build-universe.mjs            … 取得して kabu/universe.json を更新
//   node scripts/kabu/build-universe.mjs --dry      … 書き込まずに差分だけ表示
//   node scripts/kabu/build-universe.mjs --xlsx <p> … ローカルの data_j.xlsx を使う（通信しない）
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { ROOT } from "./vendor-cb.mjs";
import { loadCore } from "./load.mjs";
import { readXlsx } from "./xlsx.mjs";

const UNIVERSE = resolve(ROOT, "kabu", "universe.json");
const REQUESTS = resolve(ROOT, "kabu", "requests.txt");

const JPX_INDEX = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html";
const JPX_BASE = "https://www.jpx.co.jp";
const NIKKEI_COMPONENTS = "https://indexes.nikkei.co.jp/nkave/index/component?idx=nk225";
const UA = "KabuBattle/1.0 (+https://github.com/ksaga115/KabuBattle)";

// ロスター: 東証に上場している内国株式すべて（約 3,500 銘柄）。
// 日経 225 の名簿は日経公式ページからしか取れず、環境によっては 403 で届かないので、
// 指数のメンバーシップは「取れた時に indices へ足す」扱い（§8.2 の「半年に 1 回」運用と両立する）。
// 規模区分・市場区分は JPX の一覧そのものに入っている一次情報なので、そのまま indices に写す。
//
//   --large-only … TOPIX Core30 + Large70 だけに絞る（動作確認用）
const LARGE_ONLY = /TOPIX (Core30|Large70)/;

// 規模区分・市場区分 → indices のタグ
const SIZE_TAGS = [
  [/Core30/, "core30"], [/Large70/, "large70"], [/Mid400/, "mid400"],
  [/Small\s*1/, "small1"], [/Small\s*2/, "small2"]
];
const MARKET_TAGS = [
  [/プライム/, "prime"], [/スタンダード/, "standard"], [/グロース/, "growth"]
];

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(name);

/** data_j.xlsx の URL は過去に .xls → .xlsx に変わっている。一覧ページから毎回引き直す。 */
async function resolveJpxUrl() {
  const res = await fetch(JPX_INDEX, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
  if (!res.ok) throw new Error(`JPX の一覧ページが読めません（${res.status}）`);
  const html = await res.text();
  const m = html.match(/href="([^"]*data_j\.xlsx?[^"]*)"/i);
  if (!m) throw new Error("JPX の一覧ページに data_j.xlsx へのリンクが見つかりません");
  return m[1].startsWith("http") ? m[1] : JPX_BASE + m[1];
}

async function loadJpxRows() {
  const local = arg("--xlsx");
  if (local) return readXlsx(readFileSync(local));
  const url = await resolveJpxUrl();
  console.log(`[universe] JPX: ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`data_j.xlsx が取得できません（${res.status}）`);
  return readXlsx(Buffer.from(await res.arrayBuffer()));
}

/** 日経公式から 225 構成銘柄のコードを取る。届かなければ null（失敗させない） */
async function fetchNk225() {
  try {
    const res = await fetch(NIKKEI_COMPONENTS, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
    if (!res.ok) { console.log(`[universe] 日経の構成銘柄ページは今回取れません（${res.status}）— indices は据え置き`); return null; }
    const html = await res.text();
    const codes = new Set();
    for (const m of html.matchAll(/component_code[^>]*>\s*(\d{4}[0-9A-Z]?)\s*</g)) codes.add(m[1]);
    if (codes.size < 200) {
      for (const m of html.matchAll(/>(\d{4})<\/div>/g)) codes.add(m[1]);
    }
    if (codes.size < 200) { console.log(`[universe] 構成銘柄の抽出が ${codes.size} 件しかない — 形が変わった可能性。indices は据え置き`); return null; }
    console.log(`[universe] 日経 225: ${codes.size} 銘柄`);
    return codes;
  } catch (e) {
    console.log(`[universe] 日経の構成銘柄ページに届きません（${e.message}）— indices は据え置き`);
    return null;
  }
}

function readRequests() {
  if (!existsSync(REQUESTS)) return [];
  return readFileSync(REQUESTS, "utf8").split(/\r?\n/)
    .map((s) => s.replace(/#.*$/, "").trim())
    .filter((s) => /^\d{4}[0-9A-Z]?$/.test(s));
}

const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  const { KB } = await loadCore();
  const rows = await loadJpxRows();
  const head = rows[0];
  const col = (name) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`data_j.xlsx に列「${name}」がありません（JPX の様式が変わった可能性）`);
    return i;
  };
  const cCode = col("コード"), cName = col("銘柄名"), cMkt = col("市場・商品区分"),
    cSec = col("33業種区分"), cSize = col("規模区分"), cDate = col("日付");

  const asOf = String(rows[1] ? rows[1][cDate] : "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");

  // JPX の一覧を「国内株式のみ」に絞る（ETF・REIT・優先出資証券などを落とす）
  const listedNow = new Map();
  const unknownSectors = new Map();
  let classShares = 0;
  for (const r of rows.slice(1)) {
    const code = String(r[cCode] || "").trim();
    // 普通株式の証券コードはちょうど 4 文字（数字、または 2024 年以降の新規上場の「130A」のような
    // 数字 3 桁＋英数字 1 桁）。5 文字は種類株式・優先株式（「ソフトバンク第１回社債型種類株式」
    // 「伊藤園第１種優先株式」など）で、実質は社債・優先出資に近く、キャラクターにする対象ではない。
    // 株価の配信も普通株と揃っておらず、時価総額が桁違いに出て体力・レア度・特性 serene を歪める
    // （実測で 2 件が時価総額 362 兆・182 兆円で上位 10 に居座り、ソニーグループを押し出していた）。
    if (!/内国株式/.test(String(r[cMkt] || ""))) continue;
    if (!/^\d{3}[0-9A-Z]$/.test(code)) { classShares++; continue; }
    const sector33 = KB.normSector(r[cSec]);
    // 木 = 0 なので、存在確認は == null で見る（0 を falsy と取り違えない）
    if (KB.SECTOR_ELEM[sector33] == null && sector33 && sector33 !== "-") {
      unknownSectors.set(sector33, (unknownSectors.get(sector33) || 0) + 1);
    }
    listedNow.set(code, {
      name: String(r[cName] || "").trim(),
      sector33: sector33,
      market: String(r[cMkt] || "").trim(),
      size: String(r[cSize] || "").trim()
    });
  }
  console.log(`[universe] JPX 内国株式 ${listedNow.size} 銘柄（${asOf} 時点）`);
  if (classShares) console.log(`[universe] 種類株式・優先株式（5 文字コード）${classShares} 件は普通株ではないので外しました`);
  if (unknownSectors.size) {
    console.log("[universe] 対応表に無い業種（水に寄せます。src/kabu-core.js の SECTOR_ELEM / SECTOR_ALIAS を直してください）:");
    for (const [s, n] of unknownSectors) console.log(`    ${s}  ${n} 銘柄`);
  }

  const nk225 = await fetchNk225();
  const requested = readRequests();
  if (requested.length) console.log(`[universe] requests.txt: ${requested.length} 銘柄`);

  const prev = existsSync(UNIVERSE) ? JSON.parse(readFileSync(UNIVERSE, "utf8")) : { schemaVersion: 1, stocks: {} };
  const out = { schemaVersion: 1, updatedAt: today(), jpxAsOf: asOf, stocks: {} };

  // 採用する銘柄: 東証の内国株式すべて（+ 既にマスタにいる分は上場廃止でも残す）
  const roster = new Set(Object.keys(prev.stocks || {}));
  const largeOnly = has("--large-only");
  for (const [code, r] of listedNow) if (!largeOnly || LARGE_ONLY.test(r.size)) roster.add(code);
  for (const code of requested) roster.add(code);
  if (nk225) for (const code of nk225) if (listedNow.has(code)) roster.add(code);
  if (largeOnly) console.log("[universe] --large-only: TOPIX Core30 + Large70 だけに絞ります");

  const added = [], delisted = [], renamed = [], sectorMoved = [];

  for (const code of [...roster].sort()) {
    const now = listedNow.get(code);
    const was = (prev.stocks || {})[code];

    if (!now) {
      // 普通株のコードの形をしていないものは、そもそも入れてはいけなかったもの（種類株式など）。
      // 「上場廃止」として残すと図鑑の旅立ちに紛れ込むので、ここで消す。
      if (!/^\d{3}[0-9A-Z]$/.test(code)) {
        if (was) console.log(`[universe] ${code} ${was.name} は普通株ではないのでマスタから外します`);
        continue;
      }
      // JPX の一覧から消えた = 上場廃止。消さずに listed:false を立てる（§8.4「旅立ち」）
      if (was) {
        out.stocks[code] = Object.assign({}, was, {
          listed: false,
          delistedAt: was.delistedAt || today()
        });
        if (!was.delistedAt) delisted.push(`${code} ${was.name}`);
      } else {
        console.log(`[universe] requests.txt の ${code} は JPX の内国株式一覧にありません — 見送り`);
      }
      continue;
    }

    const indices = [];
    if (nk225) { if (nk225.has(code)) indices.push("nk225"); }
    else if (was && Array.isArray(was.indices) && was.indices.includes("nk225")) indices.push("nk225");
    for (const [re, tag] of MARKET_TAGS) if (re.test(now.market)) indices.push(tag);
    for (const [re, tag] of SIZE_TAGS) if (re.test(now.size)) indices.push(tag);

    const renamedFrom = was && Array.isArray(was.renamedFrom) ? was.renamedFrom.slice() : [];
    if (was && was.name && was.name !== now.name && !renamedFrom.includes(was.name)) {
      renamedFrom.push(was.name);
      renamed.push(`${code} ${was.name} → ${now.name}`);
    }
    if (was && was.sector33 && was.sector33 !== now.sector33) sectorMoved.push(`${code} ${was.sector33} → ${now.sector33}`);
    if (!was) added.push(`${code} ${now.name}`);

    out.stocks[code] = {
      name: now.name,
      short: (was && was.short) || shortName(now.name),
      sector33: now.sector33,
      // elem は §3 のとおり対応表から機械的に決める（手で書き換えない）
      elem: KB.sectorElem(now.sector33),
      indices: indices,
      listed: true,
      addedAt: (was && was.addedAt) || today(),
      delistedAt: null,
      renamedFrom: renamedFrom
    };
  }

  const report = (label, list) => { if (list.length) console.log(`[universe] ${label} ${list.length} 件\n    ` + list.slice(0, 20).join("\n    ") + (list.length > 20 ? `\n    …他 ${list.length - 20} 件` : "")); };
  report("新規", added); report("上場廃止", delisted); report("社名変更", renamed); report("業種変更", sectorMoved);

  const total = Object.keys(out.stocks).length;
  const live = Object.values(out.stocks).filter((s) => s.listed).length;
  console.log(`[universe] 合計 ${total} 銘柄（上場中 ${live}）`);

  if (has("--dry")) { console.log("[universe] --dry なので書き込みません"); return; }
  mkdirSync(dirname(UNIVERSE), { recursive: true });
  writeFileSync(UNIVERSE, serialize(out), "utf8");
  const kb = (statSync(UNIVERSE).size / 1024).toFixed(0);
  console.log(`[universe] 書き出し: kabu/universe.json（${kb} KB）`);
}

/**
 * 1 銘柄 1 行で書き出す。3,500 銘柄を JSON.stringify(…, null, 1) で整形すると 3MB を超え、
 * 差分も読めなくなる。1 行 1 銘柄なら「どの銘柄の何が変わったか」が git の差分でそのまま見え、
 * 大きさも 1/4 以下に収まる（ゲームは毎回これを読むので小さいほどよい）。
 */
function serialize(out) {
  const codes = Object.keys(out.stocks).sort();
  const head = { schemaVersion: out.schemaVersion, updatedAt: out.updatedAt, jpxAsOf: out.jpxAsOf };
  const lines = [];
  lines.push("{");
  for (const [k, v] of Object.entries(head)) lines.push(` ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  lines.push(' "stocks": {');
  codes.forEach((c, i) => {
    lines.push(`  ${JSON.stringify(c)}: ${JSON.stringify(out.stocks[c])}${i === codes.length - 1 ? "" : ","}`);
  });
  lines.push(" }");
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** 図鑑の狭い枠用の短い名前。持株会社の接尾辞を落とすだけの素朴な処理（手で直せる） */
function shortName(name) {
  let s = String(name)
    .replace(/[（(].*?[）)]/g, "")
    .replace(/(ホールディングス|ホールディングス株式会社|グループ本社|フィナンシャル・?グループ|フィナンシャルグループ|グループ|株式会社)$/g, "")
    .trim();
  if (!s) s = String(name);
  return s.length > 8 ? s.slice(0, 8) : s;
}

main().catch((e) => { console.error("[universe] " + e.message); process.exit(1); });
