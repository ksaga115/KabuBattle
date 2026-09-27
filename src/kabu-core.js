// src/kabu-core.js
// 株バトルの中核。設計書 §4（素体）・§5（状態）・§6（技）・§7.4（日替わり相手）。
//
// CB（対戦エンジン）と同じ書き方の自己完結 IIFE にしてある。ビルドでは index.html の中で
// CB の直後に並べて埋め込み、Node（sim / validate）では CB と一緒に評価する。つまり
// ブラウザと Node で同一のソースが動く（変換なし・一つの真実）。
//
// ここは「決算・株価・事業 → CB が食える個体」に翻訳するだけの純粋な計算に保つ。
// 通信・DOM・localStorage には触らない。
const KB = (function () {

  // ══════════════ 33 業種 → 五行 ══════════════
  // 設計書 §4.3 の覚え文「製造は素材に強く、素材は生活に強く、生活は情報に強く、
  // 情報は金融に強く、金融は製造に強い」を CB の affinity に写すと、"強い" は相克（d=2・×1.13）。
  // 連鎖が 2 つ飛びになるよう五行を割り当てると、本物の相克（木剋土・土剋水・水剋火・
  // 火剋金・金剋木）とちょうど一致する。語義も 土=素材 / 水=物流 / 火=半導体 / 金=金融 で噛み合う。
  const WOOD = 0, FIRE = 1, EARTH = 2, METAL = 3, WATER = 4;

  const SECTOR_ELEM = {
    // 木 — 製造・景気敏感
    "輸送用機器": WOOD, "機械": WOOD, "鉄鋼": WOOD, "非鉄金属": WOOD,
    "金属製品": WOOD, "精密機器": WOOD, "建設業": WOOD, "ゴム製品": WOOD,
    // 土 — 素材・エネルギー
    "化学": EARTH, "石油・石炭製品": EARTH, "鉱業": EARTH, "ガラス・土石製品": EARTH,
    "パルプ・紙": EARTH, "電気・ガス業": EARTH, "繊維製品": EARTH,
    // 水 — 生活・物流
    "食料品": WATER, "水産・農林業": WATER, "医薬品": WATER, "小売業": WATER,
    "卸売業": WATER, "サービス業": WATER, "陸運業": WATER, "海運業": WATER,
    "空運業": WATER, "倉庫・運輸関連業": WATER,
    // 火 — 情報・半導体
    "電気機器": FIRE, "情報・通信業": FIRE, "その他製品": FIRE,
    // 金 — 金融・不動産
    "銀行業": METAL, "証券、商品先物取引業": METAL, "保険業": METAL,
    "その他金融業": METAL, "不動産業": METAL
  };

  // 表記ゆれ（JPX の月次一覧・J-Quants・日経のページで中黒や「業」の有無が揺れる）
  const SECTOR_ALIAS = {
    "石油石炭製品": "石油・石炭製品", "石油・石炭": "石油・石炭製品", "石油石炭": "石油・石炭製品",
    "ガラス土石製品": "ガラス・土石製品", "ガラス・土石": "ガラス・土石製品",
    "パルプ紙": "パルプ・紙", "パルプ・紙製品": "パルプ・紙",
    "電気ガス業": "電気・ガス業", "電気・ガス": "電気・ガス業", "電気ガス": "電気・ガス業",
    "水産農林業": "水産・農林業", "水産・農林": "水産・農林業", "水産農林": "水産・農林業",
    "情報通信業": "情報・通信業", "情報・通信": "情報・通信業", "情報通信": "情報・通信業",
    "倉庫運輸関連業": "倉庫・運輸関連業", "倉庫・運輸関連": "倉庫・運輸関連業", "倉庫業": "倉庫・運輸関連業",
    "証券商品先物取引業": "証券、商品先物取引業", "証券・商品先物取引業": "証券、商品先物取引業",
    "証券業": "証券、商品先物取引業", "証券": "証券、商品先物取引業",
    "陸運": "陸運業", "海運": "海運業", "空運": "空運業",
    "銀行": "銀行業", "保険": "保険業", "その他金融": "その他金融業",
    "不動産": "不動産業", "建設": "建設業", "小売": "小売業", "卸売": "卸売業",
    "サービス": "サービス業", "鉱業業": "鉱業"
  };

  /** 業種名を JPX の 33 業種の正式名に寄せる */
  function normSector(s) {
    const t = String(s == null ? "" : s).trim();
    if (SECTOR_ELEM[t] != null) return t;
    if (SECTOR_ALIAS[t]) return SECTOR_ALIAS[t];
    return t;
  }

  /**
   * 業種 → 属性（0..4 = 木火土金水）。対応表に無い業種は水（生活・物流）に寄せる。
   * 設計書 §3 のとおり elem は機械的に決める（手で個別に変えない）。
   */
  function sectorElem(sector33) {
    const n = normSector(sector33);
    const e = SECTOR_ELEM[n];
    return e == null ? WATER : e;
  }

  /** 対応表に載っている 33 業種の一覧（validate / moves.json の網羅チェック用） */
  function sectors() { return Object.keys(SECTOR_ELEM); }

  // ══════════════ 数値のならし ══════════════
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** 対数で 0..1 に正規化。x が 0 以下・数でないときは 0 に落とす（赤字や欠損で壊れない） */
  function lognorm(x, lo, hi) {
    const v = Number(x);
    if (!isFinite(v) || v <= 0) return 0;
    return clamp((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)), 0, 1);
  }

  /** 0..1 → 24..100 の整数（CB のステータスと同じレンジ） */
  function S(v) { return Math.round(24 + 76 * clamp(v, 0, 1)); }

  const num = (x, d) => { const v = Number(x); return isFinite(v) ? v : (d === undefined ? 0 : d); };

  // ══════════════ 素体（決算 → ステータス）設計書 §4.2 ══════════════
  const OKU = 1e8, CHO = 1e12;   // 億・兆

  /**
   * 決算（TTM）と時価総額から 5 ステータスを作る。
   * 業種別の下駄は履かせない（設計書 §4.2: 金融は「守が低く見えるが体力が大きい」キャラになる）。
   * @param {object} fin  fin/<code>.json の TTM 部分
   * @param {number} mcap 時価総額（円）= 終値 × 発行済株式数
   */
  function baseStats(fin, mcap) {
    const f = fin || {};
    const sales = num(f.sales), op = num(f.op), ni = num(f.ni);
    const assets = num(f.assets), equity = num(f.equity), cash = num(f.cash);
    const eqRatio = num(f.eqRatio, assets > 0 ? equity / assets : 0);
    const liabilities = Math.max(1, assets - equity);
    const salesGrowth = num(f.salesGrowth);
    const opmStd = num(f.opmStd);
    const roe = equity > 0 ? ni / equity : 0;
    const opm = sales > 0 ? op / sales : 0;
    const turnover = assets > 0 ? sales / assets : 0;

    return {
      ATK: S(0.65 * lognorm(op, 10 * OKU, 5 * CHO) + 0.35 * clamp((salesGrowth + 0.10) / 0.40, 0, 1)),
      DEF: S(0.70 * clamp((eqRatio - 0.10) / 0.70, 0, 1) + 0.30 * lognorm(cash / liabilities, 0.02, 2.0)),
      SPD: S(clamp((turnover - 0.2) / 1.8, 0, 1)),
      TEC: S(clamp(opm / 0.45, 0, 1)),
      LUK: S(0.5 * clamp(roe / 0.30, 0, 1) + 0.5 * (1 - clamp(opmStd / 0.08, 0, 1)))
    };
  }

  /**
   * 体力（時価総額）。CB の maxHp は DEF/SPD/total から決まるので、時価総額ぶんは
   * `hpAdd` として個体に載せる。CB 側が hpAdd を見るようになるまでは無視されるだけで壊れない
   * （設計書 §0.1 の「エンジン改修は BarcodeTool 側に後方互換で入れる」に沿った拡張点）。
   * 体力そのものの表示値は hp（24..100）で図鑑に出す。
   */
  function bodyHp(mcap) {
    const v = lognorm(mcap, 200 * OKU, 40 * CHO);
    return { hp: S(v), hpAdd: Math.round(v * 320) };   // 大型株は +最大 320（素の maxHp ≒ 250..600 に対して効く量）
  }

  /**
   * 決算が無い間の暫定素体（設計書 §12 の最終行）。株価と出来高だけで埋める。
   * 決算が入った時点で baseStats に置き換わる。セーブには影響しない（素体は毎回計算）。
   */
  function provisionalStats(state) {
    const s = state || {};
    const close = num(s.close), vol = num(s.volume);
    const dev25 = num(s.dev25), ytdPos = num(s.ytdPos, 0.5), chgYtd = num(s.chgYtd);
    const volRatio = num(s.volRatio, 1);
    return {
      ATK: S(0.6 * clamp((chgYtd + 0.3) / 0.9, 0, 1) + 0.4 * lognorm(vol * close, 1 * OKU, 2000 * OKU)),
      DEF: S(0.6 * (1 - clamp(Math.abs(dev25) / 0.25, 0, 1)) + 0.4 * (1 - clamp(volRatio / 4, 0, 1))),
      SPD: S(clamp(volRatio / 3, 0, 1)),
      TEC: S(0.5 * clamp(ytdPos, 0, 1) + 0.5 * (1 - clamp(num(s.range) / 0.1, 0, 1))),
      LUK: S(clamp(num(s.range) / 0.08, 0, 1))
    };
  }

  // ══════════════ レア度（設計書 §4.4）══════════════
  // 閾値と売上の下限は、東証の内国株式 3,526 銘柄の実データで測り直した値（2026-09-26）。
  //
  // もとの式は下限 100 億円・閾値 0.85/0.72/0.58/0.44/0.30 だったが、実際の上場企業は
  // 売上の中央値が 339 億円・下位 25% が 99 億円以下で、**下位 4 分の 1 が全員 scale = 0** に
  // 潰れていた。結果、図鑑の 69% が D・S 以上は 20 銘柄しかいない、という分布になっていた。
  //
  // 下限を 10 億円に下げて小型株にも差を付け、閾値を実測の分位に合わせ直した結果:
  //   SS 1.0% / S 3.7% / A 8.5% / B 20.8% / C 31.5% / D 34.4%
  // 利益率に 0.4 を振る配分は変えていない（設計書 §4.4 の「小さくても利益率が異常に高い企業が
  // 食い込むように」という意図をそのまま残す）。実際キーエンス・信越化学・ディスコは SS、
  // 利益率 7% のトヨタは S になる。
  const RARE_STEPS = [[0.72, "SS"], [0.60, "S"], [0.50, "A"], [0.38, "B"], [0.26, "C"], [0, "D"]];
  const RARE_SALES_LO = 10 * OKU, RARE_SALES_HI = 30 * CHO;

  function rarityOf(fin) {
    const f = fin || {};
    const sales = num(f.sales), op = num(f.op);
    const scale = lognorm(sales, RARE_SALES_LO, RARE_SALES_HI);
    const quality = clamp((sales > 0 ? op / sales : 0) / 0.30, 0, 1);
    const rare = 0.6 * scale + 0.4 * quality;
    let label = "D";
    for (const [th, l] of RARE_STEPS) { if (rare >= th) { label = l; break; } }
    return { rare: rare, rareRank: label };
  }

  // ══════════════ 特性（設計書 §4.5）══════════════
  // 決算の事実から決定論的に付ける。1 体 1〜2 個。CB の個体は trait ひとつなので、
  // 1 個目を trait（前衛で本発動）、2 個目を traitKeys の 2 番目（隊のオーラ計算で使う）に置く。
  const TRAIT_RULES = [
    { key: "calc", test: (f) => f.opm >= 0.25, why: "営業利益率 25% 以上（高付加価値）" },
    { key: "wall", test: (f) => f.eqRatio >= 0.60, why: "自己資本比率 60% 以上（無借金体質）" },
    { key: "fang", test: (f) => f.salesGrowth >= 0.15, why: "売上成長率 15% 以上（成長企業）" },
    { key: "curse", test: (f) => f.ni < 0, why: "純利益が赤字（追い詰められた者の逆襲）" },
    { key: "regen", test: (f) => f.divYield >= 0.035, why: "配当利回り 3.5% 以上（株主還元）" },
    { key: "luck", test: (f) => f.opmStd >= 0.06, why: "直近 4 期の利益のブレが大きい（業績が読めない）" },
    { key: "focus", test: (f) => f.turnover >= 1.5, why: "総資産回転率 1.5 以上（身軽）" },
    { key: "serene", test: (f) => f.mcapTop10, why: "時価総額 上位 10（大御所）" },
    // 気質（§15）から。3 割以上の下落を経験して、なお高値圏の 9 割まで戻している銘柄。
    // 「一度沈んだが立て直した」という事実がそのまま不屈になる。
    { key: "endure", test: (f) => f.mdd <= -0.30 && f.recovery >= 0.90, why: "3 割超の下落から高値圏まで戻した（不屈）" }
  ];

  // どの条件にも当たらなかった銘柄の予備。いつも同じ特性になると図鑑が単調になるので、
  // その銘柄が一番得意なステータスに沿った特性を付ける（これも決算から決まる＝決定論）。
  const FALLBACK_BY_STAT = {
    ATK: { key: "fang", why: "攻めが持ち味（利益の絶対額が大きい）" },
    DEF: { key: "wall", why: "守りが持ち味（財務が厚い）" },
    SPD: { key: "swift", why: "速さが持ち味（資産を素早く回す）" },
    TEC: { key: "focus", why: "技が持ち味（利益率で稼ぐ）" },
    LUK: { key: "luck", why: "運が持ち味（安定した収益）" }
  };

  /** @returns {{keys:string[], notes:Array<{key:string,why:string}>}} */
  function traitsOf(fin, state, opt) {
    const f = fin || {}, s = state || {}, o = opt || {};
    const sales = num(f.sales);
    const facts = {
      opm: sales > 0 ? num(f.op) / sales : 0,
      eqRatio: num(f.eqRatio, num(f.assets) > 0 ? num(f.equity) / num(f.assets) : 0),
      salesGrowth: num(f.salesGrowth),
      ni: num(f.ni),
      divYield: num(s.close) > 0 ? num(f.div) / num(s.close) : 0,
      opmStd: num(f.opmStd),
      turnover: num(f.assets) > 0 ? sales / num(f.assets) : 0,
      mcapTop10: !!o.mcapTop10,
      // 気質（§15）。日足 1 年から計算した事実
      mdd: num((s.tech || {}).mdd),
      recovery: num((s.tech || {}).recovery, 1)
    };
    const notes = [];
    for (const r of TRAIT_RULES) {
      if (r.test(facts)) notes.push({ key: r.key, why: r.why });
      if (notes.length >= 2) break;
    }
    if (!notes.length) {
      const st = o.stats;
      let best = "ATK";
      if (st) for (const k of CB.STAT_KEYS) if (st[k] > st[best]) best = k;
      notes.push(FALLBACK_BY_STAT[best]);
    }
    return { keys: notes.map((n) => n.key), notes: notes };
  }

  // ══════════════ 技（設計書 §6）══════════════
  // 設計書 §6.2 は 18 種の kind を並べているが、CB の現行エンジンが実際に効かせるのは
  // strike / crit / pierce / drain / finisher の 5 種だけ。そこで moves.json には設計どおりの
  // 豊かな kind を書いておき、ここで「今のエンジンで一番近い挙動」に落とす。
  // CB 側に kind を足したらこの表から順に外していけばよい（moves.json は書き換えなくて済む）。
  const ENGINE_KINDS = { strike: 1, crit: 1, pierce: 1, drain: 1, finisher: 1 };
  const KIND_FALLBACK = {
    multi: "strike",    // 連撃 → 素直な一撃（回数は未実装）
    sure: "strike",     // 必中
    first: "strike",    // 次ターン先手
    stack: "strike",    // 使うたび攻 +N
    gamble: "crit",     // 威力 0〜N 倍 → 会心寄り
    delay: "finisher",  // 溜めて大ダメージ → 瀕死時の大技
    shield: "strike",   // 被ダメ −N%
    reflect: "strike",  // 反射
    swap: "pierce",     // 攻守入れ替え → 守り無視で近似
    dot: "drain",       // 継続ダメージ → 吸収で近似
    debuff: "pierce",   // 守/速/攻 −N% → 守り無視で近似
    heal: "drain",      // 回復
    counter: "strike"   // 回避専念して反撃
  };

  /** moves.json の kind を、今のエンジンが実際に効かせる kind に落とす */
  function engineKind(kind) {
    const k = String(kind || "strike");
    if (ENGINE_KINDS[k]) return k;
    return KIND_FALLBACK[k] || "strike";
  }

  /**
   * 技の属性。moves.json が elem を持っていればそれ、無ければコードから決定論的に散らす。
   * 1 本目（業種技）は必ず自分の属性（十八番）、2 本目以降はカバー技になり得る。
   * CB の chooseMove は「相手の属性に一番有利な技」を自動で選ぶので、これが相性の受け皿になる。
   */
  function moveElem(spec, ownElem, code, i) {
    if (spec && spec.elem != null) {
      const e = typeof spec.elem === "number" ? spec.elem : sectorElem(spec.elem);
      return ((e % 5) + 5) % 5;
    }
    // 1 本目（業種技）と 2 本目は自分の属性、3 本目以降がカバー技。
    //
    // 3 本を別々の属性にすると **五行が完全に死ぬ**。不利な位置は 5 つのうち 2 つしかないので、
    // 3 属性を持つと「どの相手にも ×1.00 以上を出せる」ことが原理的に保証されてしまう
    // （実測: 相手がどの属性でも 60% は相克 ×1.13 を出せ、不利 ×0.89 は一度も出ない。
    // 守り側から見た被相性も属性によって 1.071〜1.108 の差しかなかった）。
    // 属性を 2 つに絞ると不利を踏みうるようになり、五行が意味を持つ。
    // プレイヤー側の手は「パーティ 3 体で輪を覆う」編成であって、1 体で全部カバーすることではない。
    if (i <= 1) return ownElem;
    return (ownElem + 1 + (hashStr(code + ":mv" + i) % 4)) % 5;
  }

  /**
   * 1 銘柄の技 4 枠（業種技・固有技 1・固有技 2・必殺技）を組む。設計書 §6.1。
   * 必殺技は解放条件を満たした日だけ混ぜる（§6.4）。固有技が無い銘柄は業種技だけで戦える。
   */
  function movesFor(movesJson, u, ownElem, code, unlocked) {
    const mj = movesJson || {};
    const out = [];
    const sectorMove = (mj.sector || {})[normSector(u && u.sector33)];
    if (sectorMove) out.push(toMove(sectorMove, ownElem, code, 0));

    const entry = (mj.stocks || {})[code] || {};
    const own = Array.isArray(entry.moves) ? entry.moves : [];
    own.slice(0, 2).forEach((m, i) => out.push(toMove(m, ownElem, code, i + 1)));

    // 固有技が無い銘柄は業種技で代用する（設計書 §6.3）。ここで**技を 3 本に揃える**のが大事で、
    // エンジンの chooseMove は「相手の属性に一番有利な技」を選ぶので、技が 2 本だと 5 属性のうち
    // 2 つしかカバーできず、相手の属性しだいで勝敗が決まりすぎる（実測で相克側の勝率 66.5%＝
    // 有利・不利の差 33 ポイント）。BarcodeTool 側も v3 で「カバー技を持たせると属性差が
    // 45 → 15 ポイントに縮む」と記録している。moveElem が本数ごとに別の属性を割り当てるので、
    // 同じ業種技を足すだけでカバー範囲が広がる。
    if (!own.length && sectorMove) {
      out.push(toMove(sectorMove, ownElem, code, 1));
      out.push(toMove(sectorMove, ownElem, code, 2));
    } else if (own.length === 1 && sectorMove) {
      out.push(toMove(sectorMove, ownElem, code, 2));
    }

    const ult = entry.ultimate;
    if (ult && isUnlocked(ult, unlocked)) out.push(toMove(ult, ownElem, code, 3, true));

    if (!out.length) out.push({ elem: ownElem, element: elementOf(ownElem), kind: "strike", name: "様子見", text: "手をこまねいて一撃", origin: "", designKind: "strike" });
    return out;
  }

  function toMove(spec, ownElem, code, i, isUlt) {
    const elem = moveElem(spec, ownElem, code, i);
    const designKind = String(spec.kind || "strike");
    // 必殺技は「瀕死のときだけ出る大技」としてエンジンに見せたい枠なので finisher に寄せる
    const kind = isUlt ? (ENGINE_KINDS[designKind] === 1 && designKind !== "strike" ? designKind : "finisher") : engineKind(designKind);
    return {
      elem: elem, element: elementOf(elem), kind: kind,
      name: String(spec.name || "一撃"),
      text: String(spec.text || ""), origin: String(spec.origin || ""),
      designKind: designKind, ultimate: !!isUlt
    };
  }

  /** 必殺技の解放（設計書 §6.4）。unlock のどれか 1 つでも当日成立していれば解放 */
  function isUnlocked(ult, unlocked) {
    const need = Array.isArray(ult.unlock) ? ult.unlock : [];
    if (!need.length) return true;
    const u = unlocked || {};
    return need.some((k) => !!u[k]);
  }

  function elementOf(i) { return CB.ELEMENTS[((i % 5) + 5) % 5]; }

  // ══════════════ 決算発表日の推定（設計書 §2・§9.3）══════════════
  // 決算発表予定日は J-Quants の /fins/announcement から取る前提だったが、そこへは届かない（§14.2）。
  // 設計書 §2 自身が「取れない銘柄は前回発表日 + 3 か月で推定し estimated:true」と定めているので、
  // 決算期末（fin.fiscalId = "2026-06-30" のような四半期末）からの経過日数で推定する。
  //
  // 日本の上場企業は四半期末からおおむね 30〜45 日で開示する。中央あたりの 40 日を採る。
  // これが無いと、必殺技の解放条件 `earnings` が一度も成立せず（実測で 136 本中 110 本が
  // earnings を条件に挙げている）、決算日ボス（§9.3）も永久に出ない。
  // 決算短信の開示は法令上「四半期末から 45 日以内」で、実際は 35〜45 日に集中する。
  // その帯をそのまま「決算日（推定）」とする。
  const EARNINGS_FROM = 35, EARNINGS_TO = 45;

  // 肝心なのは **fiscalId を「直近の四半期末」ではなく「ある期末」として読む**こと。
  // 取得元は銘柄によって四半期を配信しておらず、実測では 3,693 銘柄中 2,288 銘柄（62%）の
  // fiscalId が年度末（2026-03-31）で止まっていた。「fiscalId + 40 日」だけで見ると、
  // この 62% は年 1 回しか決算日が立たない。
  //
  // どちらの場合も fiscalId は四半期の格子の上に乗っているので、そこから 3 か月刻みで
  // 前後に伸ばせば、四半期末しか取れない銘柄でも年 4 回の発表日が出る。
  // 3 月期末の会社なら 3/31・6/30・9/30・12/31 → 5 月上旬・8 月上旬・11 月上旬・2 月上旬。
  // 5 月期末の会社ならその会社の暦で 4 回。判定は (日付, fiscalId) だけで決まるので、
  // 焼き込み（latest.json）と再計算（validate）は必ず一致する（§14.4.2）。

  const dayMs = 86400000;
  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

  /** ある期末から 3 か月刻みで伸ばした四半期末のうち、date の直前にくるもの */
  function quarterEndBefore(date, fiscalId) {
    const f = parseDate(fiscalId), d = parseDate(date);
    if (!isFinite(f) || !isFinite(d)) return NaN;
    const fd = new Date(f), dd = new Date(d);
    // fiscalId は月末なので「その月の月末」として 3 か月刻みで動かす
    const fy = fd.getUTCFullYear(), fm = fd.getUTCMonth();
    const monthsApart = (dd.getUTCFullYear() - fy) * 12 + (dd.getUTCMonth() - fm);
    // date 以前で一番近い四半期末を探す（境目で取りこぼさないよう 1 つ手前から見る）
    let best = NaN;
    for (let k = Math.floor(monthsApart / 3) + 1; k >= Math.floor(monthsApart / 3) - 2; k--) {
      const m = fm + k * 3;
      const end = Date.UTC(fy + Math.floor(m / 12), (m % 12 + 12) % 12 + 1, 0);  // その月の末日
      if (end <= d && (!isFinite(best) || end > best)) best = end;
    }
    return best;
  }

  /**
   * 決算期末 → 発表日（推定）の帯。取れないときは null。
   * @returns {{from:string, to:string}|null}
   */
  function estimatedEarningsDate(fiscalId, onDate) {
    const q = quarterEndBefore(onDate || fiscalId, fiscalId);
    if (!isFinite(q)) return null;
    return { from: fmtDate(q + EARNINGS_FROM * dayMs), to: fmtDate(q + EARNINGS_TO * dayMs) };
  }

  /**
   * その日が「決算日」か（推定）。四半期ごとに 1 回、35〜45 日目の帯で立つ。
   * @param {string} date     latest.json の日付
   * @param {string} fiscalId その銘柄の決算期末（fin.fiscalId）
   */
  function isEarningsDay(date, fiscalId) {
    const q = quarterEndBefore(date, fiscalId);
    if (!isFinite(q)) return false;
    const d = parseDate(date);
    return d >= q + EARNINGS_FROM * dayMs && d <= q + EARNINGS_TO * dayMs;
  }

  // ══════════════ ハッシュ（決定論の種）══════════════
  // 日次処理の乱数シードは hash(date, code)（設計書 §7.1）。いつ開いても同じ結果になる。
  function hashStr(s) {
    let h = 0x811c9dc5;
    const str = String(s == null ? "" : s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function dayHash(code, date) { return hashStr(String(date) + "|" + String(code)); }

  // ══════════════ 個体（CB が食える形）══════════════
  /**
   * 銘柄 → CB の個体。戻り値の形は CB.beastOf() の戻り値と互換にして、
   * battle / squadBattle / squadAura に無改造で渡せるようにする（設計書 §10）。
   *
   * @param {object} a
   * @param {string} a.code    証券コード（ID。社名や業種が変わっても不変）
   * @param {object} a.u       universe.json の 1 銘柄
   * @param {object} a.fin     決算（TTM）。無ければ暫定素体になる
   * @param {object} a.state   latest.json の 1 銘柄（今日の状態）
   * @param {object} a.moves   moves.json 全体
   * @param {string} a.date    latest.json の日付（決定論の種）
   * @param {object} [a.unlocked] 必殺技の解放状況 {awaken,limitUp,earnings,streak}
   * @param {boolean} [a.mcapTop10]
   */
  function buildFromStock(a) {
    const code = String(a.code);
    const u = a.u || {};
    const state = a.state || {};
    const fin = a.fin || null;
    const date = String(a.date || "");

    const elem = u.elem != null && typeof u.elem === "number" ? u.elem : sectorElem(u.sector33);
    const shares = num(fin && fin.shares);
    const mcap = shares > 0 ? num(state.close) * shares : num(state.mcap);

    const stats = fin ? baseStats(fin, mcap) : provisionalStats(state);
    const body = bodyHp(mcap > 0 ? mcap : num(state.close) * 1e8);
    const { rare, rareRank } = fin ? rarityOf(fin) : { rare: 0.35, rareRank: "C" };
    const tr = traitsOf(fin, state, { mcapTop10: !!a.mcapTop10, stats: stats });
    const traitObj = CB.TRAITS.find((t) => t.key === tr.keys[0]) || CB.TRAITS[0];

    let sum = 0;
    for (const k of CB.STAT_KEYS) sum += stats[k];
    const total = Math.round(sum / 5);

    const name = String(u.name || code);
    const hash = dayHash(code, date);

    return {
      // ── CB が読むフィールド（形は CB.beastOf の戻り値と同じ）──
      code: code, name: name, sid: code,
      prefixWord: "", suffixWord: name,
      stats: stats, sum: sum, total: total, rank: CB.rankOf(total),
      elem: elem, element: elementOf(elem),
      temper: "", trait: traitObj, hash: hash,
      moves: movesFor(a.moves, u, elem, code, a.unlocked),
      // ── 株バトル固有（CB は無視する。図鑑と精算で使う）──
      hpAdd: body.hpAdd,          // CB 側が対応したら maxHp に足される（未対応なら無視されるだけ）
      kabu: {
        hp: body.hp, mcap: mcap, rare: rare, rareRank: rareRank,
        sector33: normSector(u.sector33), short: String(u.short || name),
        traitKeys: tr.keys, traitNotes: tr.notes,
        provisional: !fin, date: date,
        stale: num(state.stale), suspect: !!state.suspect,
        // 気質（§15）。図鑑に出すほか、隊のベータ・相関の計算に使う
        tech: state.tech || null
      }
    };
  }

  // ══════════════ 状態（株価 → 今日のコンディション）設計書 §5.1 ══════════════
  // すべて「素体に対する係数」。素体は書き換えない。係数の積は 0.75〜1.35 に clamp する
  // （状態が素体を覆い尽くさない＝「学べば読める」を守る）。
  const MOD_LO = 0.75, MOD_HI = 1.35;

  /**
   * @param {object} state  latest.json の 1 銘柄
   * @param {object} market {nk225Chg, marketOpen}
   * @param {object} [extra] {predict:"up"|"down"|"flat"|null, hit:boolean|null, streak:number, earnings:boolean, exDiv:boolean, divYield:number}
   */
  function stateMods(state, market, extra) {
    const s = state || {}, m = market || {}, x = extra || {};
    const mods = {
      ATK: 1, DEF: 1, SPD: 1, TEC: 1, LUK: 1,
      hpMul: 1, order: 0, critAdd: 0, spreadAdd: 0, takenMul: 1,
      stunFirst: false, unlocked: {}, tags: []
    };
    const tag = (t) => mods.tags.push(t);

    // 消息不明（stale ≥ 3）は状態係数をすべて 1.0（素体のまま）
    if (num(s.stale) >= 3) { tag("消息不明"); return mods; }

    const chg1 = num(s.chg1), ytdPos = num(s.ytdPos, 0.5), chgYtd = num(s.chgYtd);
    const volRatio = num(s.volRatio, 1), range = num(s.range), dev25 = num(s.dev25);

    // ══ 気質（テクニカル・設計書 §15）══
    // 日足 1 年から計算した、その銘柄の性格。決算より速く、株価より遅く変わる。
    // すべて公開データだけで決まる（セーブを書き換えても動かない）。
    const tech = s.tech || null;
    if (tech) {
      // ボラティリティ: 高いほど「一発はあるが外す」＝運寄り、低いほど「淡々と当てる」＝技寄り。
      // CB は振れ幅を運と技から決める（spread = 0.17 × (1 + 運/100×0.95 − 技/100×0.70)）ので、
      // 運と技を傾けることが、そのまま実在のボラティリティの再現になる。
      const volTilt = clamp((num(tech.vol, 0.30) - 0.30) / 0.60, -0.5, 1.0);
      mods.LUK *= 1 + volTilt * 0.25;
      mods.TEC *= 1 - volTilt * 0.20;
      if (volTilt >= 0.5) tag("荒い値動き"); else if (volTilt <= -0.3) tag("穏やかな値動き");

      // 自己相関: 正＝勢いが続く（モメンタム）、負＝行き過ぎたら戻る（平均回帰）。
      // 前日の動きに対して、その銘柄の性格どおりの向きへ効く。
      const follow = clamp(num(tech.autocorr) * 4, -1, 1);
      mods.ATK *= 1 + clamp(chg1, -0.08, 0.08) * follow * 2;
      if (follow <= -0.4) {
        if (chg1 <= -0.02) { mods.critAdd += 0.05 * -follow; tag("押し目からの反発"); }
      } else if (follow >= 0.4 && chg1 >= 0.02) tag("勢いが続く");

      // 売買代金（流動性）: 厚い銘柄ほど動き出しが速い。0.04 億〜31 億で ±9 ほど振れる
      mods.order += clamp(Math.log10(Math.max(1, num(tech.turnover)) / 1e8) * 6, -12, 12);
    }

    // テンション: 上げた日は攻寄り、下げた日は守寄り（合計は概ね保存＝強弱ではなく配分）
    const t = clamp(chg1, -0.08, 0.08);
    mods.ATK *= (1 + t * 1.5);
    mods.DEF *= (1 - t * 1.0);
    if (Math.abs(chg1) >= 0.02) tag(chg1 > 0 ? "テンション（攻寄り）" : "テンション（守寄り）");

    if (ytdPos >= 0.9) {                       // 覚醒
      for (const k of CB.STAT_KEYS) mods[k] *= 1.06;
      mods.unlocked.awaken = true; tag("覚醒");
    }
    if (ytdPos <= 0.1) {                       // 逆境
      mods.hpMul *= 0.90; mods.critAdd += 0.08; tag("逆境");
    }
    mods.order += clamp(chgYtd, -0.3, 0.3) * 20;                       // 勢い
    mods.ATK *= clamp(0.9 + 0.1 * volRatio, 0.9, 1.25);                // 注目
    if (volRatio >= 2) tag("注目");
    mods.spreadAdd += clamp(range * 2, 0, 0.12);                       // 荒れ
    if (range >= 0.05) tag("荒れ");

    if (dev25 >= 0.12) { mods.ATK *= 1.12; mods.DEF *= 0.85; tag("暴走"); }
    if (dev25 <= -0.12) { mods.SPD *= 0.85; mods.DEF *= 1.12; tag("冬眠"); }

    const per = num(s.per), pbr = num(s.pbr), sPer = num(s.sectorPer);
    if (sPer > 0 && per > 0 && per < sPer * 0.7 && pbr > 0 && pbr < 1) { mods.takenMul *= 0.92; tag("粘り"); }
    if (sPer > 0 && per > sPer * 1.5) { mods.order += 10; mods.takenMul *= 1.08; tag("期待"); }

    if (s.limitUp) { mods.unlocked.limitUp = true; mods.critAdd += 0.10; tag("ストップ高"); }
    if (s.limitDown) { mods.stunFirst = true; tag("ストップ安"); }

    // 市場全体のイベントは **ベータ（日経への感応度）倍**で効く。設計書 §5.1 は全員一律 ×0.9 /
    // ×1.05 としていたが、実際には銘柄ごとに市場への付き合い方がまったく違う
    // （実測で -0.23 〜 1.34。市場と逆に動く銘柄すらある）。ここが「今日の相場に合わせて
    // 誰を出すか」という毎日の判断の土台になる（§15 のポートフォリオ層）。
    const beta = tech ? clamp(num(tech.beta, 1), -0.5, 2) : 1;
    const nk = num(m.nk225Chg);
    if (nk <= -0.03) {
      mods.DEF *= 1 - 0.10 * beta;
      tag(beta >= 0.8 ? "暴落の日（まともに食らう）" : beta <= 0.2 ? "暴落の日（我関せず）" : "暴落の日");
    }
    if (nk >= 0.03) {
      mods.ATK *= 1 + 0.05 * beta;
      tag(beta >= 0.8 ? "祭りの日（波に乗る）" : beta <= 0.2 ? "祭りの日（乗り遅れ）" : "祭りの日");
    }

    if (x.earnings) { mods.unlocked.earnings = true; tag("決算日"); }
    if (x.exDiv) { mods.hpMul *= (1 - clamp(num(x.divYield) * 2, 0, 0.10)); tag("配当落ち"); }
    if (num(x.streak) >= 3) { mods.unlocked.streak = true; tag("予想 3 連勝"); }

    // 予想（設計書 §7.3）
    if (x.hit === true) { mods.critAdd += 0.06; tag("予想的中"); }
    if (x.hit === false) { mods.order -= 15; tag("予想外れ"); }

    // ポートフォリオ（設計書 §7.2・§15）。値動きが連動しない 3 体は被ダメが減り、
    // 連動する 3 体は攻めが立つ代わりに一緒に沈む。現実の分散投資と集中投資そのまま。
    if (x.portfolio) {
      if (x.portfolio.diversified) { mods.takenMul *= 0.95; tag("分散（値動きが連動しない）"); }
      if (x.portfolio.concentrated) { mods.ATK *= 1.06; mods.takenMul *= 1.05; tag("集中投資"); }
    }

    for (const k of CB.STAT_KEYS) mods[k] = clamp(mods[k], MOD_LO, MOD_HI);
    mods.hpMul = clamp(mods.hpMul, MOD_LO, MOD_HI);
    mods.takenMul = clamp(mods.takenMul, MOD_LO, MOD_HI);
    return mods;
  }

  /**
   * 状態係数を個体に乗せて「今日のその銘柄」を作る。素体（引数）は変更しない。
   * 返り値も CB 互換なので、そのまま squadBattle に渡せる。
   */
  function applyMods(beast, mods) {
    const stats = {};
    for (const k of CB.STAT_KEYS) stats[k] = clamp(Math.round(beast.stats[k] * mods[k]), 1, 130);
    let sum = 0; for (const k of CB.STAT_KEYS) sum += stats[k];
    const total = Math.round(sum / 5);
    // 行動順・会心・振れ・被ダメはエンジンが個体から読まないので、SPD/LUK に寄せて表現する。
    // （CB に mods をそのまま渡せるようになったらこの寄せは外せる）
    if (mods.order) stats.SPD = clamp(Math.round(stats.SPD + mods.order * 0.3), 1, 130);
    if (mods.critAdd) stats.LUK = clamp(Math.round(stats.LUK + mods.critAdd * 100 * 0.6), 1, 130);
    return Object.assign({}, beast, {
      stats: stats, sum: sum, total: total, rank: CB.rankOf(total),
      hpAdd: Math.round(num(beast.hpAdd) * mods.hpMul),
      kabu: Object.assign({}, beast.kabu, { mods: mods, tags: mods.tags })
    });
  }

  // ══════════════ 日替わり相手（設計書 §7.4）══════════════
  // 収録が東証の内国株式すべて（約 3,500 銘柄）になったので、素の「値上がり率 1 位」は
  // ほぼ毎日、数百円の超小型株がストップ高を付けたもので埋まる。それでは「その日の相場そのもの」
  // という趣旨から外れる（誰も知らない会社ばかりが毎日ボスになる）ので、時価総額の下限だけ置く。
  // 下限で候補が 3 体に足りなくなったら下限を外す＝主役が出せない日を作らない。
  const MIN_MCAP = 100 * OKU;

  /**
   * 「その日の相場そのもの」を相手にする。値上がり率 1 位・値下がり率 1 位・出来高比 1 位。
   * 同一銘柄が複数枠に来たら次点に送る。並べ替えは決定論（同値はコード順）。
   * @param {object} latest
   * @param {{minMcap?:number}} [opt] minMcap に 0 を渡すと設計書どおりの素の挙動になる
   */
  function protagonists(latest, opt) {
    const minMcap = opt && opt.minMcap != null ? num(opt.minMcap) : MIN_MCAP;
    const all = Object.entries((latest && latest.stocks) || {})
      .filter(([, s]) => num(s.stale) < 3 && !s.suspect);
    // 時価総額が入っていない銘柄（決算未取得）は下限の判定ができないので落とさない
    const liquid = all.filter(([, s]) => !(num(s.mcap) > 0) || num(s.mcap) >= minMcap);
    const rows = (liquid.length >= 3 ? liquid : all)
      .map(([code, s]) => ({ code: code, chg1: num(s.chg1), volRatio: num(s.volRatio, 1) }));
    const pick = (sortFn) => rows.slice().sort(sortFn).map((r) => r.code);
    const up = pick((a, b) => b.chg1 - a.chg1 || (a.code < b.code ? -1 : 1));
    const down = pick((a, b) => a.chg1 - b.chg1 || (a.code < b.code ? -1 : 1));
    const hot = pick((a, b) => b.volRatio - a.volRatio || (a.code < b.code ? -1 : 1));

    const used = Object.create(null);
    const take = (list) => { for (const c of list) { if (!used[c]) { used[c] = 1; return c; } } return null; };
    return { up: take(up), down: take(down), hot: take(hot) };
  }

  /** 相手の強さを自パーティに合わせて素体を ±10% でスケール（設計書 §7.4 の梯子方式） */
  function scaleToParty(beast, myAvgRare, theirRare) {
    const d = clamp((num(myAvgRare) - num(theirRare)) * 0.5, -0.10, 0.10);
    const stats = {};
    for (const k of CB.STAT_KEYS) stats[k] = clamp(Math.round(beast.stats[k] * (1 + d)), 1, 130);
    let sum = 0; for (const k of CB.STAT_KEYS) sum += stats[k];
    const total = Math.round(sum / 5);
    return Object.assign({}, beast, { stats: stats, sum: sum, total: total, rank: CB.rankOf(total) });
  }

  // ══════════════ 株式分割・併合の検出（設計書 §8.3）══════════════
  // 日足の提供元は分割調整済みの系列を出すが、当日〜翌日は未調整で来ることがある。
  // 未調整の日は前日比が 1/n-1（分割）か n-1（併合）に張り付くので、出来高の跳ねと
  // 併せて検出する。検出した日は「テンション」「荒れ」の判定を無効化し、契約中の口数を調整する。
  const SPLIT_RATIOS = [2, 3, 4, 5, 10];

  /**
   * @param {number} chg1     前日比（close/prevClose - 1）
   * @param {number} volume   当日の出来高
   * @param {number} avgVolume 平時（20 日平均）の出来高
   * @param {number} [tol]    許容誤差（既定 ±2%）
   * @returns {{kind:"split"|"merge", n:number}|null}
   */
  function detectSplit(chg1, volume, avgVolume, tol) {
    const c = num(chg1), v = num(volume), av = num(avgVolume);
    const eps = num(tol, 0.02) || 0.02;
    if (!(av > 0) || !(v >= av * 3)) return null;   // 出来高が平時の 3 倍以上でなければ見送る
    for (const n of SPLIT_RATIOS) {
      if (Math.abs(c - (1 / n - 1)) <= eps) return { kind: "split", n: n };
      if (Math.abs(c - (n - 1)) <= eps) return { kind: "merge", n: n };
    }
    return null;
  }

  /**
   * 契約中の口数と取得単価を分割・併合で調整する（設計書 §8.3。資金価値は保存される）。
   * @param {{units:number, cost:number}} holding
   */
  function adjustHolding(holding, ev) {
    const h = holding || { units: 0, cost: 0 };
    if (!ev) return { units: num(h.units), cost: num(h.cost) };
    const r = ev.kind === "split" ? ev.n : 1 / ev.n;
    return { units: num(h.units) * r, cost: num(h.cost) / r };
  }

  // ══════════════ ポートフォリオ（設計書 §15）══════════════
  // 現実の分散投資は「業種が違う」ことではなく「値動きが連動しない」こと。
  // 3 体ぶんの日次リターンをゲームに持たせるのは重すぎる（3,700 銘柄 × 250 日）ので、
  // 実在の一ファクターモデルで見積もる: 2 銘柄の相関 ≒（それぞれの市場との相関の積）。
  // 同じ業種どうしはそれに加えて連動するので、その分を足す。
  // 使うのは latest.json に焼いた corr と業種だけなので、セーブとは無関係に決まる。
  const SAME_SECTOR_RHO = 0.30, SAME_ELEM_RHO = 0.10;

  function pairCorr(a, b) {
    const ta = (a.kabu && a.kabu.tech) || null, tb = (b.kabu && b.kabu.tech) || null;
    // 気質が無い銘柄（上場直後など）は市場並みに連動するものとして扱う
    let rho = num(ta ? ta.corr : 0.35, 0.35) * num(tb ? tb.corr : 0.35, 0.35);
    if (a.kabu.sector33 && a.kabu.sector33 === b.kabu.sector33) rho += SAME_SECTOR_RHO;
    else if (a.elem === b.elem) rho += SAME_ELEM_RHO;
    return clamp(rho, -1, 1);
  }

  /**
   * 隊の性質。設計書 §7.2 の共鳴を、属性の散らばり（相性の話）と
   * 値動きの相関（分散の話）の 2 本立てにする。
   * @returns {{beta:number, corr:number, diversified:boolean, concentrated:boolean, elems:number}}
   */
  function portfolio(beasts) {
    const list = (beasts || []).filter(Boolean);
    if (list.length < 2) return { beta: 1, corr: 0.35, diversified: false, concentrated: false, elems: list.length };
    let bs = 0;
    for (const b of list) bs += num((b.kabu && b.kabu.tech) ? b.kabu.tech.beta : 1, 1);
    let sum = 0, n = 0;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { sum += pairCorr(list[i], list[j]); n++; }
    const corr = n ? sum / n : 0.35;
    const elems = new Set(list.map((b) => b.elem)).size;
    return {
      beta: bs / list.length,
      corr: corr,
      diversified: corr <= 0.15,      // 値動きが連動していない＝本当の分散
      concentrated: corr >= 0.45,     // 連動している＝集中投資
      elems: elems
    };
  }

  // ══════════════ 今日のお題（設計書 §16）══════════════
  // 毎日ひとつ、実在の投資スタイルがお題として出る。条件を満たす 3 体で勝つと報酬。
  // 「全銘柄そろえたらやることが無い」への答えで、**持っている中からどう選ぶか**が毎日変わる。
  // 条件はすべて公開データ（決算・株価・気質）から判定できるものだけにする。
  //
  // 日付だけで決まる（hash(date)）ので、いつ開いても同じお題。誰が遊んでも同じお題。
  const CHALLENGES = [
    {
      key: "value", name: "バリュー投資", need: "PER 15 倍以下 かつ PBR 1 倍以下",
      why: "割安に放置された会社を買う。グレアム以来の王道",
      test: (s) => num(s.per) > 0 && num(s.per) <= 15 && num(s.pbr) > 0 && num(s.pbr) <= 1
    },
    {
      key: "growth", name: "グロース投資", need: "売上成長率 15% 以上",
      why: "伸びている会社に乗る。高くても買う",
      test: (s) => s.fund && num(s.fund.g) >= 0.15
    },
    {
      key: "income", name: "高配当", need: "配当利回り 3% 以上",
      why: "値上がりではなく配当で受け取る",
      test: (s) => num(s.close) > 0 && num(s.div) / num(s.close) >= 0.03
    },
    {
      key: "defensive", name: "ディフェンシブ", need: "ベータ 0.5 以下",
      why: "相場が荒れても動じない銘柄で固める",
      test: (s) => s.tech && num(s.tech.beta, 1) <= 0.5
    },
    {
      key: "small", name: "小型株", need: "時価総額 500 億円以下",
      why: "まだ見つけられていない小さな会社を探す",
      test: (s) => num(s.mcap) > 0 && num(s.mcap) <= 500 * OKU
    },
    {
      key: "quality", name: "高収益", need: "営業利益率 20% 以上",
      why: "安いものではなく、良いものを買う",
      test: (s) => s.fund && num(s.fund.opm) >= 0.20
    },
    {
      key: "fortress", name: "無借金経営", need: "自己資本比率 60% 以上",
      why: "借金に頼らない会社だけで組む",
      test: (s) => s.fund && num(s.fund.eq) >= 0.60
    },
    {
      key: "momentum", name: "順張り", need: "年初来レンジの上位 20%",
      why: "上がっているものはさらに上がる、に賭ける",
      test: (s) => num(s.ytdPos) >= 0.80
    },
    {
      key: "contrarian", name: "逆張り", need: "年初来レンジの下位 20%",
      why: "落ちているものを拾う。いちばん勇気が要る",
      test: (s) => num(s.ytdPos) <= 0.20
    },
    {
      key: "liquid", name: "大型・高流動", need: "売買代金 10 億円/日 以上",
      why: "いつでも売れる銘柄だけで戦う",
      test: (s) => s.tech && num(s.tech.turnover) >= 10 * OKU
    },
    {
      key: "calm", name: "低ボラティリティ", need: "値動きの荒さ 20% 以下",
      why: "退屈なほど穏やかな銘柄を集める",
      test: (s) => s.tech && num(s.tech.vol, 1) <= 0.20
    },
    {
      key: "turnaround", name: "再生", need: "3 割超下げて高値圏の 9 割まで戻した",
      why: "一度沈んで立て直した会社に賭ける",
      test: (s) => s.tech && num(s.tech.mdd) <= -0.30 && num(s.tech.recovery) >= 0.90
    }
  ];

  /** その日のお題。日付だけで決まる（いつ開いても同じ） */
  function challengeOf(date) {
    return CHALLENGES[hashStr("challenge|" + String(date)) % CHALLENGES.length];
  }

  /**
   * ある銘柄がお題を満たすか。判定は latest.json に焼き込んだ値だけで完結する
   * （ゲームは銘柄ごとの決算ファイルを一括では読まないため）。
   * @param {object} ch お題（challengeOf の戻り値）
   * @param {object} st latest.json の 1 銘柄
   */
  function meetsChallenge(ch, st) {
    if (!ch || !st) return false;
    try { return !!ch.test(st); } catch (e) { return false; }
  }

  // ══════════════ 練度（保有の履歴・設計書 §15）══════════════
  // 現実の「長く持つほど成績のブレが縮む（時間分散）」を、そのまま持ち込む。
  // CB には熟練度（mastery 0〜5）があり、効果は「その個体のダメージの振れを 2%/段、
  // 最大 −10% 縮める。素のステータスは上げない」。まさに時間分散そのものなので、
  // 保有した営業日数をここに繋ぐ。エンジンの改修は要らない。
  //
  // 素のステータスを上げないので、いくら持ち続けても弱い銘柄が強い銘柄を追い越すことはない
  // （設計書 §0 の「Pay-to-win なし」と同じ考え方）。伸びるのは「安定して戦えること」だけ。
  const MASTERY_MAX = 5;

  /**
   * 保有営業日数 → 練度。BarcodeTool の熟練度と同じ刻み（log2）。
   * @param {number} heldDays  その銘柄を保有した営業日数
   * @param {number} playedDays これまでに精算した営業日数（これを超える保有はあり得ない）
   */
  function masteryOf(heldDays, playedDays) {
    const d = Math.max(0, Math.min(num(heldDays), num(playedDays, heldDays)));
    return clamp(Math.floor(Math.log2(d + 1)), 0, MASTERY_MAX);
  }

  // ══════════════ パーティ（CB の squad 形）══════════════
  /**
   * 属性がばらけると相性の共鳴（設計書 §7.2）。CB.squadAura の reso に渡す形に寄せる。
   * @param {Array} beasts
   * @param {number[]} [mastery] 3 体それぞれの練度（0〜5）。省略すると 0
   */
  function squadOf(beasts, mastery) {
    const elems = beasts.map((b) => b.elem);
    const uniq = new Set(elems).size;
    return {
      beasts: beasts,
      mastery: beasts.map((_, i) => clamp(num(mastery && mastery[i]), 0, MASTERY_MAX)),
      reso: { family: uniq === 1, session: false },
      spread: uniq >= 3,
      portfolio: portfolio(beasts)
    };
  }

  return {
    // 業種・属性
    WOOD: WOOD, FIRE: FIRE, EARTH: EARTH, METAL: METAL, WATER: WATER,
    SECTOR_ELEM: SECTOR_ELEM, sectors: sectors, sectorElem: sectorElem, normSector: normSector,
    // 素体
    lognorm: lognorm, S: S, baseStats: baseStats, bodyHp: bodyHp, provisionalStats: provisionalStats,
    rarityOf: rarityOf, traitsOf: traitsOf, TRAIT_RULES: TRAIT_RULES, FALLBACK_BY_STAT: FALLBACK_BY_STAT,
    // 技
    engineKind: engineKind, KIND_FALLBACK: KIND_FALLBACK, movesFor: movesFor, isUnlocked: isUnlocked,
    // 決算発表日（推定）
    estimatedEarningsDate: estimatedEarningsDate, isEarningsDay: isEarningsDay,
    EARNINGS_FROM: EARNINGS_FROM, EARNINGS_TO: EARNINGS_TO, quarterEndBefore: quarterEndBefore,
    // 個体
    buildFromStock: buildFromStock, hashStr: hashStr, dayHash: dayHash,
    // 状態
    stateMods: stateMods, applyMods: applyMods, MOD_LO: MOD_LO, MOD_HI: MOD_HI,
    // 分割・併合
    SPLIT_RATIOS: SPLIT_RATIOS, detectSplit: detectSplit, adjustHolding: adjustHolding,
    // 対戦
    protagonists: protagonists, MIN_MCAP: MIN_MCAP, scaleToParty: scaleToParty, squadOf: squadOf,
    // ポートフォリオ・練度（§15）
    portfolio: portfolio, pairCorr: pairCorr, masteryOf: masteryOf, MASTERY_MAX: MASTERY_MAX,
    // 今日のお題（§16）
    CHALLENGES: CHALLENGES, challengeOf: challengeOf, meetsChallenge: meetsChallenge
  };
})();
