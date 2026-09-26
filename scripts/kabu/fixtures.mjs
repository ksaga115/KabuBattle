// scripts/kabu/fixtures.mjs
// sim / validate が実データ無しで回せるようにする合成データ。
// 実データ（kabu/universe.json・kabu/data/latest.json）が無くても検証が動くことを優先する。
// 数字は「ありそうな形」であって実在企業の決算ではない。

/** 決定論的な擬似乱数（テストの再現性のため Math.random は使わない） */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15); t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

const OKU = 1e8, CHO = 1e12;

/** 33 業種を一巡しながら n 銘柄ぶんの universe / fin / state を作る */
export function synth(n, sectors, seed = 12345) {
  const r = rng(seed);
  const universe = { schemaVersion: 1, updatedAt: "2026-09-25", stocks: {} };
  const fin = {};
  const latest = {
    schemaVersion: 1, date: "2026-09-25", marketOpen: true,
    market: { nk225Chg: -0.004 }, stocks: {}
  };

  for (let i = 0; i < n; i++) {
    const code = String(1300 + i * 7);
    const sector33 = sectors[i % sectors.length];
    universe.stocks[code] = {
      name: `テスト${code}株式会社`, short: `テ${code}`, sector33: sector33,
      indices: ["nk225"], listed: true, addedAt: "2026-09-25", delistedAt: null, renamedFrom: []
    };

    const sales = (50 + r() * 20000) * OKU;
    const opm = -0.03 + r() * 0.40;
    const op = sales * opm;
    const ni = op * (0.5 + r() * 0.3);
    const turnover = 0.15 + r() * 1.9;
    const assets = sales / turnover;
    const eqRatio = 0.03 + r() * 0.80;
    const equity = assets * eqRatio;
    const shares = (0.5 + r() * 30) * 1e8;
    const close = Math.round(200 + r() * 9000);

    fin[code] = {
      fiscalId: "2026Q2", sales, op, ni, assets, equity, eqRatio,
      cash: assets * (0.03 + r() * 0.35),
      eps: ni / shares, bps: equity / shares,
      div: close * (r() * 0.05), shares,
      salesGrowth: -0.15 + r() * 0.45,
      opmStd: r() * 0.12
    };

    latest.stocks[code] = {
      close, prevClose: close, chg1: -0.06 + r() * 0.12,
      chgYtd: -0.35 + r() * 0.9, ytdPos: r(), ytdHigh: close * 1.3, ytdLow: close * 0.7,
      volRatio: 0.3 + r() * 3.2, range: r() * 0.08, dev25: -0.2 + r() * 0.4,
      volume: Math.round(1e5 + r() * 5e7), avgVolume20: Math.round(1e5 + r() * 5e7),
      per: 5 + r() * 40, pbr: 0.4 + r() * 4, sectorPer: 12, sectorPbr: 1.3,
      limitUp: false, limitDown: false, stale: 0, suspect: false,
      mcap: close * shares
    };
  }
  return { universe, fin, latest };
}

/**
 * 分割・併合が起きた日の latest.json を作る（`latest.splits` つき）。
 * 実データの splits はほとんどの日が空なので、これが無いと「Yahoo の分割イベントと
 * KB.detectSplit の推測を突き合わせる」経路が CI で一度も通らない。
 *
 * @param {object} latest synth() が返した latest（変更しない。複製を返す）
 * @returns {object} splits が 2 件入った latest の複製
 *   1 件目 … 未調整の系列（前日比が 1/5-1 に張り付き、出来高 4 倍）→ 推測が反応するべき
 *   2 件目 … 調整済みの系列（前日比は普通）→ 推測は黙るべき（それは矛盾ではない）
 */
export function synthSplits(latest) {
  const L = JSON.parse(JSON.stringify(latest));
  const codes = Object.keys(L.stocks);
  if (codes.length < 2) return L;
  const raw = codes[0], adj = codes[1];

  const a = L.stocks[raw];
  a.avgVolume20 = 1e6; a.volume = 4e6;
  a.prevClose = 5000; a.close = 1000; a.chg1 = 1 / 5 - 1;
  a.split = 5; a.range = 0;

  const b = L.stocks[adj];
  b.avgVolume20 = 1e6; b.volume = 1.1e6;
  b.prevClose = 1000; b.close = 1010; b.chg1 = 0.01;
  delete b.split;

  // `ratio` は**数値**（numerator / denominator）。sources/yahoo.mjs がそう作るので合成側も揃える。
  // 形が実データと違うと、ここを通るテストが本物の不具合を見逃す。
  L.splits = [
    { code: raw, date: L.date, ratio: 5 / 1, numerator: 5, denominator: 1 },
    { code: adj, date: L.date, ratio: 1 / 2, numerator: 1, denominator: 2 }
  ];
  return L;
}

/** 業種技だけの最小 moves.json（固有技が無い銘柄でも戦えることの確認に使う） */
export function synthMoves(sectors) {
  const sector = {};
  const kinds = ["multi", "stack", "shield", "strike", "pierce", "drain", "crit", "dot", "sure", "gamble"];
  sectors.forEach((s, i) => {
    sector[s] = { name: `${s}の型`, kind: kinds[i % kinds.length], pow: 0.6 + (i % 5) * 0.08, text: "業種共通の技" };
  });
  return { schemaVersion: 1, sector, stocks: {} };
}
