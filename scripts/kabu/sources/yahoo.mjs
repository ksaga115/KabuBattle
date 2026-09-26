// scripts/kabu/sources/yahoo.mjs
// 日足の取得元（既定）。設計書 §2 は stooq を前提にしていたが、stooq の CSV は
// JavaScript のプルーフオブワーク型ボット検査を返すようになり、サーバーからは取れない
// （stooq.com / stooq.pl とも、ブラウザ相当の User-Agent でも同じ）。検査の突破はしない。
// 設計書 §8.5 が代替として挙げている Yahoo Finance のチャート API に差し替える。
//
//   GET https://query1.finance.yahoo.com/v8/finance/chart/<sym>?range=1y&interval=1d&events=split,div
//
// 返ってくるのは始値・高値・安値・終値・出来高の日足（分割調整済み）と、分割・配当の履歴。
// 分割イベントが直接取れるので、設計書 §8.3 の前日比からの推測より確実に分割を扱える。
//
// 差し替え口: fetchDaily(code, opt) だけを合わせれば他のソースに替えられる。

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export const NAME = "yahoo";

/** 証券コード → Yahoo のシンボル。指数は先頭 ^ をそのまま使う */
export function symbolOf(code) {
  const c = String(code);
  return c.startsWith("^") ? c : `${c}.T`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 日足を取る。
 * @param {string} code 証券コード（"7203"）または指数（"^N225"）
 * @param {{range?:string, retries?:number, timeoutMs?:number}} [opt]
 * @returns {Promise<{code:string, symbol:string, rows:Array, splits:Array, meta:object}>}
 */
export async function fetchDaily(code, opt = {}) {
  const { range = "1y", retries = 3, timeoutMs = 20000 } = opt;
  const symbol = symbolOf(code);
  const qs = `range=${encodeURIComponent(range)}&interval=1d&events=split%2Cdiv&includeAdjustedClose=true`;

  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ac.signal });
      if (res.status === 404) throw new Error(`該当なし（${symbol}）`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const err = json && json.chart && json.chart.error;
      if (err) throw new Error(`${err.code}: ${err.description}`);
      const result = json && json.chart && json.chart.result && json.chart.result[0];
      if (!result) throw new Error("result が空");
      return parseChart(code, symbol, result);
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${symbol}: ${lastErr ? lastErr.message : "取得できません"}`);
}

/** JST の暦日に落とす（東証の営業日で並べるため。UTC 日付では 1 日ずれる） */
function jstDate(unixSec) {
  return new Date((unixSec + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

function parseChart(code, symbol, result) {
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close ? q.close[i] : null;
    // 欠損（祝日や配信漏れ）の行は落とす。終値が無い行は使えない
    if (close == null || !isFinite(close)) continue;
    rows.push({
      date: jstDate(ts[i]),
      open: numOr(q.open && q.open[i], close),
      high: numOr(q.high && q.high[i], close),
      low: numOr(q.low && q.low[i], close),
      close: Number(close),
      volume: Math.max(0, Math.round(numOr(q.volume && q.volume[i], 0)))
    });
  }
  // 同じ日付が二重に来ることがある（配信の都合）。後の行を採る
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, r);
  const uniq = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  const splitsRaw = (result.events && result.events.splits) || {};
  const splits = Object.values(splitsRaw).map((s) => ({
    date: jstDate(s.date),
    numerator: Number(s.numerator),
    denominator: Number(s.denominator),
    ratio: Number(s.numerator) / Number(s.denominator)
  })).sort((a, b) => (a.date < b.date ? -1 : 1));

  // 配当（1 株あたり）。直近 4 回の合計が年間配当になる（§4.1 の div・§5.1 の配当落ち）
  const divRaw = (result.events && result.events.dividends) || {};
  const dividends = Object.values(divRaw).map((d) => ({
    date: jstDate(d.date), amount: Number(d.amount)
  })).filter((d) => isFinite(d.amount) && d.amount > 0).sort((a, b) => (a.date < b.date ? -1 : 1));

  const m = result.meta || {};
  return {
    code: String(code), symbol,
    rows: uniq, splits, dividends,
    meta: {
      currency: m.currency || "JPY",
      timezone: m.exchangeTimezoneName || "Asia/Tokyo",
      regularMarketPrice: numOr(m.regularMarketPrice, null),
      chartPreviousClose: numOr(m.chartPreviousClose, null)
    }
  };
}

function numOr(v, d) {
  const n = Number(v);
  return isFinite(n) ? n : d;
}
