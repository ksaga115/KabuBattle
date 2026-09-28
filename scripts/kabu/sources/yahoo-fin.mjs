// scripts/kabu/sources/yahoo-fin.mjs
// 決算の取得元。設計書 §2 は J-Quants を前提にしていたが、api.jquants.com は環境によって
// 全パス 403（API Gateway のリソースポリシー）で届かないことがある。Yahoo の
// fundamentals-timeseries は認証もキーも要らず、年次・四半期・TTM をまとめて返す。
//
//   GET https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/<sym>
//        ?symbol=<sym>&type=annualTotalRevenue,quarterlyTotalRevenue,trailingTotalRevenue,...
//
// 実測（東証プライムの大型株）:
//   ・annual    … ほぼ全社で 4 期ぶん揃う。もっとも当てになる
//   ・quarterly … 銘柄によって疎（1〜2 期しか無い会社がある）
//   ・trailing  … TTM が直接来る。ある会社では一番新しい
// そこで「TTM は trailing → 四半期 4 期の合計 → 直近年次」の順に、貸借は「四半期 → 年次」の順に
// 埋める。どれも無ければその銘柄は決算なし（暫定素体のまま）にして、他の銘柄は巻き込まない。
//
// J-Quants が使える環境なら sources/jquants.mjs を足して差し替えればよい（設計書 §8.5）。

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export const NAME = "yahoo-fundamentals";

// 損益・キャッシュフロー（TTM を作りたいので 3 系統とも頼む）。
// 金融業は営業利益が無いことがあるので税引前利益も取り、無いときの代用にする
// （設計書 §4.1「金融業は op := 経常利益」）。
//
// 10 銘柄（超大型〜新規上場）で総当たりした取得率:
//   10/10  売上・純利益・税引前・営業CF・投資CF・財務CF・FCF・減価償却・株数
//    9/10  営業利益・EBITDA・EBIT・販管費・配当支払・棚卸・流動資産・流動負債・運転資本・自己株
//    8/10  粗利・売上原価・有利子負債・設備投資・支払利息・少数株主
//    7/10  長期借入・販管費
//    6/10  自社株買い
//    3/10  研究開発費（開示する会社が限られる。取れた会社だけ効かせる）
const FLOW = [
  "TotalRevenue", "CostOfRevenue", "GrossProfit", "OperatingIncome", "PretaxIncome", "NetIncome",
  "EBITDA", "EBIT", "InterestExpense", "ResearchAndDevelopment", "SellingGeneralAndAdministration",
  "OperatingCashFlow", "InvestingCashFlow", "FreeCashFlow", "CapitalExpenditure",
  "DepreciationAndAmortization", "CashDividendsPaid", "RepurchaseOfCapitalStock"
];
// 貸借（ある時点の残高。TTM の概念が無いので annual と quarterly だけ）
const STOCKV = [
  "TotalAssets", "StockholdersEquity", "CashAndCashEquivalents", "OrdinarySharesNumber",
  "CurrentAssets", "CurrentLiabilities", "Inventory", "RetainedEarnings", "TotalDebt",
  "NetPPE", "GoodwillAndOtherIntangibleAssets", "InvestedCapital", "TreasurySharesNumber"
];

const TYPES = [
  ...FLOW.flatMap((k) => [`annual${k}`, `quarterly${k}`, `trailing${k}`]),
  ...STOCKV.flatMap((k) => [`annual${k}`, `quarterly${k}`])
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 四半期・年次・TTM の生系列をまとめて取る */
export async function fetchQuarterly(code, opt = {}) {
  const { retries = 3, timeoutMs = 25000 } = opt;
  const symbol = String(code).startsWith("^") ? String(code) : `${code}.T`;
  const now = Math.floor(Date.now() / 1000);
  // 年次 4 期を確実に拾うため 10 年ぶん頼む（短い窓だと空で返る銘柄がある）
  const qs = `symbol=${encodeURIComponent(symbol)}&type=${TYPES.join("%2C")}` +
    `&period1=${now - 10 * 365 * 24 * 3600}&period2=${now + 86400}`;

  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    const url = `${host}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?${qs}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const results = json && json.timeseries && json.timeseries.result;
      if (!Array.isArray(results)) throw new Error("timeseries.result が空");
      const series = {};
      for (const r of results) {
        const type = r.meta && r.meta.type && r.meta.type[0];
        if (!type || !Array.isArray(r[type])) continue;
        const pts = r[type]
          .filter((x) => x && x.reportedValue && isFinite(Number(x.reportedValue.raw)))
          .map((x) => ({ date: String(x.asOfDate), value: Number(x.reportedValue.raw) }))
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        if (pts.length) series[type] = pts;
      }
      if (!Object.keys(series).length) throw new Error("決算データがありません（Yahoo に収録なし）");
      return { code: String(code), symbol, series };
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${symbol}: ${lastErr ? lastErr.message : "取得できません"}`);
}

const last = (a) => (a && a.length ? a[a.length - 1] : null);
const sumLast = (a, n) => (a || []).slice(-n).reduce((s, x) => s + x.value, 0);
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};

/**
 * 生系列 → 設計書 §4.1 の TTM。どの系統から採ったかを sources に残す（後で監査できるように）。
 * @param {object} raw fetchQuarterly の戻り値
 * @param {{annualDividend?:number}} [extra] 年間配当（日足の events から作る）
 */
export function toTtm(raw, extra = {}) {
  const s = raw.series;
  const got = {};

  /** 損益: trailing → 四半期 4 期の合計 → 直近年次 の順に採る */
  const flow = (key) => {
    const tr = last(s[`trailing${key}`]);
    if (tr) { got[key] = "trailing"; return { value: tr.value, date: tr.date }; }
    const q = s[`quarterly${key}`];
    if (q && q.length >= 4) { got[key] = "quarterly×4"; return { value: sumLast(q, 4), date: last(q).date }; }
    const a = last(s[`annual${key}`]);
    if (a) { got[key] = "annual"; return { value: a.value, date: a.date }; }
    return null;
  };
  /** 貸借: 四半期 → 年次 の順（新しい残高を優先） */
  const level = (key) => {
    const q = last(s[`quarterly${key}`]);
    if (q) { got[key] = "quarterly"; return q; }
    const a = last(s[`annual${key}`]);
    if (a) { got[key] = "annual"; return a; }
    return null;
  };

  const rev = flow("TotalRevenue");
  if (!rev || !(rev.value > 0)) throw new Error("売上が取れません");

  let op = flow("OperatingIncome");
  let opIsPretax = false;
  if (!op) { op = flow("PretaxIncome"); opIsPretax = !!op; }
  const ni = flow("NetIncome");

  const assets = level("TotalAssets");
  const equity = level("StockholdersEquity");
  const cash = level("CashAndCashEquivalents");
  const shares = level("OrdinarySharesNumber");

  // 売上成長率: 四半期が 5 期あれば前年同期比、無ければ年次の前年比
  let salesGrowth = 0, growthFrom = "none";
  const q = s.quarterlyTotalRevenue, a = s.annualTotalRevenue;
  if (q && q.length >= 5 && q[q.length - 5].value > 0) {
    salesGrowth = q[q.length - 1].value / q[q.length - 5].value - 1; growthFrom = "前年同期比";
  } else if (a && a.length >= 2 && a[a.length - 2].value > 0) {
    salesGrowth = a[a.length - 1].value / a[a.length - 2].value - 1; growthFrom = "年次の前年比";
  }

  // 利益率のブレ: 四半期が 3 期以上あれば四半期、無ければ年次で
  const margins = [];
  const mq = s.quarterlyOperatingIncome || s.quarterlyPretaxIncome;
  let stdFrom = "none";
  if (q && mq && Math.min(q.length, mq.length) >= 3) {
    for (let i = 0; i < Math.min(4, q.length, mq.length); i++) {
      const r = q[q.length - 1 - i], o = mq[mq.length - 1 - i];
      if (r && o && r.value > 0) margins.push(o.value / r.value);
    }
    stdFrom = "四半期";
  } else {
    const ma = s.annualOperatingIncome || s.annualPretaxIncome;
    if (a && ma) {
      for (let i = 0; i < Math.min(4, a.length, ma.length); i++) {
        const r = a[a.length - 1 - i], o = ma[ma.length - 1 - i];
        if (r && o && r.value > 0) margins.push(o.value / r.value);
      }
      stdFrom = "年次";
    }
  }

  const assetsV = assets ? assets.value : 0;
  const equityV = equity ? equity.value : 0;
  const sharesV = shares ? shares.value : 0;
  const niV = ni ? ni.value : 0;
  const salesV = rev.value;

  // ── ここから先は「取れたら入れる」項目。取れない銘柄では欠けたまま（0 ではなく未定義）──
  const v = (x) => (x ? x.value : null);
  const gross = flow("GrossProfit"), cogs = flow("CostOfRevenue");
  const ebitda = flow("EBITDA"), ebit = flow("EBIT"), interest = flow("InterestExpense");
  const rnd = flow("ResearchAndDevelopment"), sga = flow("SellingGeneralAndAdministration");
  const ocf = flow("OperatingCashFlow"), icf = flow("InvestingCashFlow");
  const fcf = flow("FreeCashFlow"), capex = flow("CapitalExpenditure");
  const dep = flow("DepreciationAndAmortization");
  const divPaid = flow("CashDividendsPaid"), buyback = flow("RepurchaseOfCapitalStock");

  const curA = level("CurrentAssets"), curL = level("CurrentLiabilities");
  const inv = level("Inventory"), retained = level("RetainedEarnings");
  const debt = level("TotalDebt"), ppe = level("NetPPE");
  const goodwill = level("GoodwillAndOtherIntangibleAssets");
  const invested = level("InvestedCapital"), treasury = level("TreasurySharesNumber");

  const ratio = (a, b) => (a != null && b != null && b !== 0 ? a / b : null);
  const abs = (x) => (x == null ? null : Math.abs(x));

  const out = {
    fiscalId: rev.date,
    sales: salesV,
    op: op ? op.value : 0,
    ni: niV,
    opIsPretax,
    assets: assetsV,
    equity: equityV,
    eqRatio: assetsV > 0 ? equityV / assetsV : 0,
    cash: cash ? cash.value : 0,
    shares: sharesV,
    eps: sharesV > 0 ? niV / sharesV : 0,
    bps: sharesV > 0 ? equityV / sharesV : 0,
    div: Number(extra.annualDividend) || 0,
    salesGrowth,
    opmStd: std(margins),

    // 設計書 §18 で足した項目。実在の指標だけを載せる
    grossMargin: ratio(v(gross), salesV),                          // 粗利率（価格決定力）
    fcf: v(fcf),
    fcfMargin: ratio(v(fcf), salesV),                              // 現金を生む力
    ocf: v(ocf),
    accrual: ratio(niV - (v(ocf) || 0), assetsV || null),          // 利益と現金のズレ（会計上の質）
    debt: v(debt),
    netDebtEbitda: ratio((v(debt) || 0) - (cash ? cash.value : 0), v(ebitda)),  // 借金の重さ
    interestCover: ratio(v(ebit), abs(v(interest))),               // 利払い余力
    currentRatio: ratio(v(curA), v(curL)),                         // 短期の安全性
    invTurnover: ratio(salesV, v(inv)),                            // 在庫回転
    retainedRatio: ratio(v(retained), assetsV || null),            // 蓄積の厚み
    goodwillRatio: ratio(v(goodwill), assetsV || null),            // 買収への依存
    ppeRatio: ratio(v(ppe), assetsV || null),                      // 設備の重さ（装置産業か）
    capexToDep: ratio(abs(v(capex)), v(dep)),                      // 攻めの投資（1 超で拡大）
    rndRatio: ratio(v(rnd), salesV),                               // 研究開発の厚み
    sgaRatio: ratio(v(sga), salesV),                               // 販管費の重さ
    roic: ratio(v(ebit) != null ? v(ebit) * 0.7 : null, v(invested)),  // 投下資本利益率（税引後概算）
    payout: ratio(abs(v(divPaid)), niV > 0 ? niV : null),          // 配当性向
    buyback: ratio(abs(v(buyback)), salesV),                       // 自社株買いの規模
    treasuryRatio: ratio(v(treasury), sharesV || null),            // 自己株の比率

    // どこから採ったか（監査用。素体が急に変わったときに原因を追える）
    sources: Object.assign({ salesGrowth: growthFrom, opmStd: stdFrom }, got)
  };

  // 取れなかった項目は消す（キーが無い＝データが無い、を保つ）
  for (const k of Object.keys(out)) if (out[k] === null || (typeof out[k] === "number" && !isFinite(out[k]))) delete out[k];
  return out;
}
