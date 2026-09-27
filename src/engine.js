// src/engine.js
// 対戦エンジン（コードバトルの CB）。**株バトルの一部として持っている**。
//
// 出どころ: ksaga115/BarcodeTool の BarcodeTool.html
//   コミット 79da6202d2c11b2ce808b011795a066df15b5c62
//   sha256   5403bb1fce0da07f1dc1977f76b7df91ae905b61cfe4a3db4b457db0dbf9566c
//   取り込み 2026-09-28
//
// もともとは「ビルドのたびに BarcodeTool の固定コミットから抜き出す」形にしていた（設計書 §0.1）。
// やめた理由は 3 つ:
//   ・別リポジトリなので、エンジンを直したいときに向こうへ push できないと前に進めない
//   ・ビルドのたびに通信が要る（Actions でも、手元でも）
//   ・株バトルに要る改修（体力の追加枠、設計書 §6.2 の技の種類）を入れられない
// 借り物ではなく自分のものにして、株バトルの都合で直せるようにした。
//
// ── 株バトルのために変えたところ（ここに全部書く。増えたら必ず足すこと）──
//
// 1. mkFighter の maxHp に `+ (beast.hpAdd || 0)` を足した
//    株バトルは決算から攻守速技運を、時価総額から体力を作る。CB は maxHp を守・速・TOTAL から
//    しか決めないので、時価総額のぶんを渡す口が無かった。結果、40 兆円の会社も 200 億円の会社も
//    同じ体力で戦っていた（実測: 予算 160 万の隊が予算 30 万の隊に 64.5% → 体力を効かせると 90.0%）。
//    コードバトルの個体は hpAdd を持たないので、向こうでは常に +0（＝挙動は完全に同じ）。
//    取り込み時に、個体 460 体・1v1 690 試合・スカッド 304 試合が 1 ビットも変わらないことを
//    確認済み。BarcodeTool 側の npm run domcheck（89/0）と npm run sim（84 PASS / 0 FAIL）も通る。
//
// ── 触るときの約束 ──
//
// `build()`（個体の生成）に手を入れると、同じ銘柄が別の個体になる。株バトルの個体は
// buildFromStock（src/kabu-core.js）が作るので build() は実は使っていないが、
// affinity / TRAITS / ELEMENTS / STAT_KEYS の並びを変えると素体の意味が変わる。
// 数式を触ったら必ず scripts/kabu/sim.mjs を回して、決定論・A/B 対称・停止性・勝率曲線を確かめること。

const CB = (function () {

  // ── 文字列 → UTF-8 バイト列 ──
  function utf8Bytes(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.codePointAt(i);
      if (c > 0xFFFF) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  // ── 性質の異なる4系統のハッシュ ──
  function fnv1a(b) { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function djb2(b) { let h = 5381; for (let i = 0; i < b.length; i++) { h = (Math.imul(h, 33) + b[i]) >>> 0; } return h >>> 0; }
  function sdbm(b) { let h = 0; for (let i = 0; i < b.length; i++) { h = (b[i] + (h << 6) + (h << 16) - h) >>> 0; } return h >>> 0; }
  function murmur3(b, seed) {
    let h = seed >>> 0, k = 0, i = 0;
    const len = b.length, c1 = 0xcc9e2d51, c2 = 0x1b873593;
    for (; i + 4 <= len; i += 4) {
      k = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
      k = Math.imul(k, c1) >>> 0; k = ((k << 15) | (k >>> 17)) >>> 0; k = Math.imul(k, c2) >>> 0;
      h = (h ^ k) >>> 0; h = ((h << 13) | (h >>> 19)) >>> 0; h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
    }
    k = 0;
    switch (len & 3) {
      case 3: k ^= b[i + 2] << 16;
      case 2: k ^= b[i + 1] << 8;
      case 1: k ^= b[i];
        k = Math.imul(k, c1) >>> 0; k = ((k << 15) | (k >>> 17)) >>> 0; k = Math.imul(k, c2) >>> 0;
        h = (h ^ k) >>> 0;
    }
    h = (h ^ len) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
    return h >>> 0;
  }

  // ── 決定論的な擬似乱数。種は必ずコード内容から作る（乱数だけでは生成しない）──
  function sm32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x9e3779b9) | 0;
      let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15); t = Math.imul(t, 0x735a2d97);
      return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
    };
  }

  /** その1ゲームだけの「調子」（0.8〜1.2）。個体の hash と gameSeed だけから決まるので、
   *  A/B どちらの引数で渡しても同じ値になる（ターン内の乱数と違い、ターン数が多くても薄まらない）。
   *  TOTAL の差がわずかでも試合ごとの展開差が大きくなりすぎる問題を、ここで直接抑える。 */
  function conditionRoll(beastHash, gameSeed) {
    const r = sm32(((beastHash >>> 0) ^ Math.imul((gameSeed >>> 0) || 0, 0x2545F491) ^ 0x9E3779B9) >>> 0)();
    return 0.73 + r * 0.54;
  }
  /** 調子（cond）を全ステータスにまとめてかける。攻守速技運のどれか一つではなく全体が
   *  ぶれるようにすることで、TOTAL差で見えている「地力の差」を試合ごとに実際に揺らす。 */
  function applyCondition(f, cond) {
    f.cond = cond;
    f.atk *= cond; f.def *= cond; f.spd *= cond; f.tec *= cond; f.luk *= cond;
  }

  // ── 正規化：同じコードとみなすべき入力を同じ個体にまとめる ──
  function normalize(text) {
    let s = String(text == null ? "" : text);
    s = s.replace(/\r\n?/g, "\n");
    try { s = s.normalize("NFKC"); } catch (e) { /* 未対応環境ではそのまま */ }
    s = s.replace(/^[\s\u0000]+/, "").replace(/[\s\u0000]+$/, "");
    // UPC-A を EAN-13 として読んだ場合（先頭0付き13桁）は12桁に揃える
    if (/^\d{13}$/.test(s) && s.charAt(0) === "0") s = s.slice(1);
    return s;
  }

  // ── コード内容そのものから取り出す構造的な特徴 ──
  function features(s) {
    const cps = [];
    for (let i = 0; i < s.length; i++) { const c = s.codePointAt(i); cps.push(c); if (c > 0xFFFF) i++; }
    const n = cps.length || 1;

    let digits = 0, upper = 0, lower = 0, sym = 0, wide = 0;
    let runMax = 1, run = 1, rises = 0, falls = 0, equals = 0;
    let posw = 0, alt = 0, sqw = 0;
    const seen = Object.create(null);
    const buckets = new Array(16).fill(0);

    for (let i = 0; i < cps.length; i++) {
      const c = cps[i];
      if (c >= 48 && c <= 57) digits++;
      else if (c >= 65 && c <= 90) upper++;
      else if (c >= 97 && c <= 122) lower++;
      else if (c < 128) sym++;
      else wide++;
      seen[c] = (seen[c] || 0) + 1;
      // 位置による重み。周期の違う数を掛けて単調増加にならないようにする
      posw = (posw + Math.imul(c + 1, ((i * i) % 61) + 7)) >>> 0;
      sqw = (sqw + Math.imul((c ^ (i * 31)) >>> 0, (i % 17) + 3)) >>> 0;
      alt = (alt + ((i & 1) ? -c : c) * ((i % 5) + 1)) | 0;
      if (i > 0) {
        const p = cps[i - 1];
        if (c > p) rises++; else if (c < p) falls++; else equals++;
        if (c === p) { run++; if (run > runMax) runMax = run; } else run = 1;
        // 隣り合う文字の関係を16個のバケットに畳み込む
        const bi = (Math.imul(p + 1, 0x9E3779B1) ^ Math.imul(c + 131, 0x85EBCA77)) >>> 0;
        buckets[bi & 15] = (buckets[bi & 15] + (bi >>> 8)) >>> 0;
      }
    }
    let distinct = 0; for (const k in seen) distinct++;

    // 対称性（回文らしさ）
    let symm = 0;
    for (let i = 0, j = cps.length - 1; i < j; i++, j--) if (cps[i] === cps[j]) symm++;

    // チェックディジット的な性質（コード内容だけから判定できるもの）
    const allDigit = /^[0-9]+$/.test(s);
    let eanOk = 0, luhnOk = 0, mod43 = 0;
    if (allDigit && (n === 8 || n === 12 || n === 13 || n === 14)) {
      let sum = 0;
      for (let i = 0; i < n - 1; i++) {
        const d = cps[n - 2 - i] - 48;
        sum += (i % 2 === 0) ? d * 3 : d;
      }
      eanOk = (((10 - (sum % 10)) % 10) === (cps[n - 1] - 48)) ? 1 : 0;
    }
    if (allDigit && n >= 2) {
      let sum = 0, dbl = false;
      for (let i = n - 1; i >= 0; i--) {
        let d = cps[i] - 48;
        if (dbl) { d *= 2; if (d > 9) d -= 9; }
        sum += d; dbl = !dbl;
      }
      luhnOk = (sum % 10 === 0) ? 1 : 0;
    }
    const C39 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";
    let m43 = 0, c39 = 1;
    for (let i = 0; i < s.length; i++) { const p = C39.indexOf(s.charAt(i)); if (p < 0) { c39 = 0; break; } m43 += p; }
    if (c39 && s.length > 1) mod43 = ((m43 % 43) === C39.indexOf(s.charAt(s.length - 1))) ? 1 : 0;

    const foldB = buckets.reduce(function (a, x, i) { return (a ^ Math.imul(x, (0x27220A95 + i * 2654435761) >>> 0)) >>> 0; }, 0x9E3779B9);
    const comp = Math.imul(digits * 37 + upper * 53 + lower * 61 + sym * 71 + wide * 83 + 1, (n % 13) + 1) >>> 0;
    const shape = Math.imul(runMax * 151 + rises * 23 + falls * 29 + equals * 41 + 1, (distinct % 11) + 3) >>> 0;
    const flags = (eanOk * 5 + luhnOk * 3 + mod43 * 7 + (allDigit ? 2 : 0) + (wide ? 11 : 0)) >>> 0;

    return {
      n: n, distinct: distinct, runMax: runMax, symm: symm,
      posw: posw, sqw: sqw, alt: (alt >>> 0), foldB: foldB, comp: comp, shape: shape, flags: flags,
      buckets: buckets
    };
  }

  // ── 属性（陰陽五行・木火土金水）──
  // 相生の順（木→火→土→金→水→木）に並べる。この並び順そのものが相生/相克の計算根拠になる。
  const ELEMENTS = [
    { key: "WOOD", name: "木", mark: "木", color: "#a6e3a1" },
    { key: "FIRE", name: "火", mark: "火", color: "#fab387" },
    { key: "EARTH", name: "土", mark: "土", color: "#f9e2af" },
    { key: "METAL", name: "金", mark: "金", color: "#a6adc8" },
    { key: "WATER", name: "水", mark: "水", color: "#89dceb" }
  ];
  // 相生の並び順に対して、d=1（自分が生む相手）/ d=2（自分が克す相手）/
  // d=3（自分を克す相手）/ d=4（自分を生んだ相手）。克は生より強く効く（倍率は控えめに、
  // 同TOTAL帯で属性だけで決まらない程度）。
  function affinity(a, b) {
    const d = ((b - a) % 5 + 5) % 5;
    if (d === 1) return 1.05;   // 相生（生む）
    if (d === 2) return 1.13;   // 相克（克す）
    if (d === 3) return 0.89;   // 被克（克される）
    if (d === 4) return 0.95;   // 被生（生まれ元）
    return 1.00;
  }

  /** コード内容から読み取れる「系統」→ 属性の傾向（0..4 = 木火土金水）。手がかりが弱ければ -1 */
  function familyElem(s) {
    const d = String(s || "").replace(/[-\s]/g, "");
    if (/^97[89]\d{10}$/.test(d)) return 4;                 // ISBN 書籍 → 水
    if (/^https?:\/\//i.test(s)) return 3;                  // URL → 金
    if (/^(WIFI|MECARD|MATMSG|BEGIN:VCARD|GEO:|TEL:|MAILTO:|SMSTO):/i.test(s)) return 3; // 構造化 → 金
    if (/^\d{8}$/.test(d) || /^\d{12,14}$/.test(d)) {       // JAN/EAN/UPC/ITF: 先頭2桁の帯
      const p = +d.slice(0, 2);
      if (p >= 45 && p <= 49) return 0;                     // 日本 → 木
      if (p <= 13) return 1;                                // 北米 → 火
      if (p >= 30 && p <= 37) return 3;                     // 仏 → 金
      if (p >= 40 && p <= 44) return 0;                     // 独 → 木
      return 2;                                             // その他 → 土
    }
    if (/^\d+$/.test(d) && d.length >= 4) return 2;         // 純数字 → 土
    if (s.length <= 18 && /^[A-Z0-9\-. $/+%*]+$/.test(s) && /[A-Z]/.test(s)) return 0; // Code39系 → 木
    return -1;                                              // 一般テキスト等
  }

  // ── 気質（ステータスの偏り。合計はほぼ0でTOTALを歪ませない）──
  const TEMPERS = [
    { name: "猛攻", off: [14, -10, 3, -4, -3] },
    { name: "堅牢", off: [-9, 15, -6, 2, -2] },
    { name: "疾風", off: [2, -8, 15, -6, -3] },
    { name: "精密", off: [-7, -2, -3, 15, -3] },
    { name: "強運", off: [-5, -4, -3, -4, 16] },
    { name: "均衡", off: [2, 1, 0, 1, -4] },
    { name: "狂戦", off: [18, -13, 6, -8, -3] },
    { name: "要塞", off: [-12, 18, -9, 4, -1] },
    { name: "閃光", off: [5, -9, 18, -9, -5] },
    { name: "策謀", off: [-9, 3, -5, 17, -6] },
    { name: "混沌", off: [8, -6, -8, -6, 12] },
    { name: "老練", off: [-3, 8, -7, 9, -7] },
    { name: "野性", off: [11, -4, 9, -12, -4] },
    { name: "静寂", off: [-8, 10, -8, 8, -2] },
    { name: "苛烈", off: [13, -5, -8, 4, -4] },
    { name: "遊撃", off: [-4, -7, 13, -3, 1] }
  ];

  // ── 特性（TOTALだけで勝敗が決まらない主因）──
  const TRAITS = [
    { key: "fang", name: "猛牙", desc: "与えるダメージが12%上がる" },
    { key: "wall", name: "城壁", desc: "受けるダメージを12%減らす" },
    { key: "swift", name: "韋駄天", desc: "初手を取りやすく、行動順が上がる" },
    { key: "calc", name: "演算", desc: "相手の防御を大きく無視する" },
    { key: "luck", name: "天佑", desc: "会心の発生率が大きく上がる" },
    { key: "wrath", name: "逆鱗", desc: "HPが減るほど攻撃が鋭くなる" },
    { key: "twin", name: "連撃", desc: "ときどき2回続けて攻撃する" },
    { key: "curse", name: "呪詛", desc: "ターン経過で相手の防御を削る" },
    { key: "regen", name: "再生", desc: "毎ターン少しHPが回復する" },
    { key: "crush", name: "重撃", desc: "威力が上がるが行動が遅くなる" },
    { key: "reflect", name: "反射", desc: "受けたダメージの一部を返す" },
    { key: "serene", name: "明鏡", desc: "相手の会心を抑え、回避が上がる" },
    { key: "endure", name: "不屈", desc: "一度だけHP1で持ちこたえる" },
    { key: "venom", name: "蝕毒", desc: "毎ターン相手の最大HPを削る" },
    { key: "focus", name: "集中", desc: "TECぶん命中と威力が上がる" },
    { key: "gale", name: "疾撃", desc: "SPDが高いほど威力が上がる" }
  ];

  // ── 技（攻撃手段）: 1体につき3つ。属性は技ごとに別（十八番＋カバー技2つ）で、
  //     戦況に応じて自動で選ばれる。これが「相性」と「一発逆転」の主な受け皿。
  const MOVE_KINDS = ["strike", "crit", "pierce", "drain", "finisher"];
  // 技の種類名も陰陽五行の雰囲気に合わせる。克撃＝相手の守りを「克す」、生撃＝奪った命で自分を「生む」。
  const MOVE_KIND_NAME = { strike: "正撃", crit: "会心撃", pierce: "克撃", drain: "生撃", finisher: "捨身の一撃" };
  const MOVE_KIND_DESC = {
    strike: "素直な一撃",
    crit: "会心が出やすい",
    pierce: "相手の守りを多めに無視する",
    drain: "与えたダメージの一部を回復する",
    finisher: "自分が瀕死のときだけ選ばれる、大威力の一発逆転技"
  };
  // 技の威力。moves.json が pow を持っていればそちらが優先で、ここは既定値。
  // 後半は株バトルで足した種類（設計書 §6.2）。1v1 の battle() は build() が作る
  // 5 種しか使わないので、増やしても向こうの挙動は変わらない。
  const MOVE_POWER = {
    strike: 1.00, crit: 0.90, pierce: 0.95, drain: 0.88, finisher: 1.75,
    multi: 0.58,    // 1 発ぶん（2〜3 回当たる）
    sure: 0.85,     // 必中のぶん低め
    first: 0.90,
    stack: 0.80,
    gamble: 1.00,   // これに 0〜maxMult 倍が乗る
    counter: 1.00
  };
  // 技の種類を選ぶときの重み付きプール。捨身の一撃は「持っている個体の方が少ない」珍しさにする。
  const MOVE_KIND_POOL = ["strike", "strike", "strike", "strike", "crit", "crit", "crit", "pierce", "pierce", "pierce", "drain", "drain", "drain", "finisher"];

  // ── 名前（形容詞＋名詞。内容ハッシュで決定論的に選ぶ）──
  // NAME_PREFIX: よくある形容詞・形容動詞（そのまま名詞の前に直接付けられる形で保持）
  // NAME_SUFFIX: 日常のありふれた名詞（都道府県・食べ物・身の回りの物）。
  // 壮大なファンタジー風の言葉ではなく、あえて普通すぎる名詞に形容詞を付けることで
  // 「おざなりなフランスパン」のような、ちぐはぐで気の抜けた面白さを狙っている。
  const NAME_PREFIX = [
    "大きい", "小さい", "重い", "軽い", "固い", "柔らかい", "甘い", "辛い", "酸っぱい", "苦い",
    "熱い", "冷たい", "温かい", "涼しい", "眩しい", "暗い", "明るい", "高い", "低い", "長い",
    "短い", "太い", "細い", "広い", "狭い", "深い", "浅い", "速い", "遅い", "強い",
    "弱い", "美しい", "醜い", "新しい", "古い", "若い", "賢い", "鈍い", "多い", "少ない",
    "良い", "悪い", "美味しい", "不味い", "汚い", "騒がしい", "慌ただしい", "図々しい", "あざとい", "憎たらしい",
    "かわいい", "嬉しい", "悲しい", "楽しい", "寂しい", "恥ずかしい", "懐かしい", "眠い", "忙しい", "怪しい",
    "危ない", "優しい", "厳しい", "うるさい", "面倒くさい", "だらしない", "しつこい", "ややこしい", "えらい", "のろい",
    "素早い", "力強い", "可笑しい", "情けない", "もったいない", "ありがたい", "恐ろしい", "望ましい", "疑わしい", "頼もしい",
    "たくましい", "みすぼらしい", "華々しい", "目まぐるしい", "けたたましい", "そっけない", "あっけない", "はしたない", "いやらしい", "ばかばかしい",
    "みっともない", "とんでもない", "くだらない", "つまらない", "あぶなっかしい", "なれなれしい", "いかがわしい", "うっとうしい", "おこがましい", "かたじけない",
    "きまり悪い", "すばしっこい", "せわしない", "たどたどしい", "なさけない", "ひもじい", "まぎらわしい", "みずみずしい", "ものたりない", "やかましい",
    "よそよそしい", "わずらわしい", "あさましい", "いさぎよい", "おびただしい", "たわいない", "ふてぶてしい", "まちどおしい", "ものものしい", "やましい",
    "ゆるぎない", "うやうやしい", "かがやかしい", "すがすがしい", "つつましい", "なやましい", "はげしい", "ふさわしい", "めざましい", "ゆゆしい",
    "おざなりな", "適当な", "几帳面な", "生真面目な", "陽気な", "陰気な", "呑気な", "頑固な", "素直な", "派手な",
    "地味な", "贅沢な", "質素な", "立派な", "幸せな", "不幸な", "平凡な", "特別な", "純粋な", "複雑な",
    "単純な", "曖昧な", "明確な", "冷静な", "大胆な", "臆病な", "律儀な", "気まぐれな", "神経質な", "大雑把な",
    "生意気な", "優雅な", "下品な", "強引な", "控えめな", "きよらかな", "しとやかな", "いたいけな", "清潔な", "不潔な",
    "不思議な", "元気な", "健康な", "自然な", "人工的な", "伝統的な", "現代的な", "古風な", "円満な", "愉快な",
    "盛大な", "壮大な", "地道な", "温厚な", "冷淡な", "親切な", "不親切な", "無邪気な", "狡猾な", "勇敢な"
  ];
  const NAME_SUFFIX = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
    "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
    "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
    "フランスパン", "食パン", "納豆", "味噌汁", "豆腐", "餃子", "カレー", "ラーメン", "うどん", "そば",
    "天ぷら", "おにぎり", "漬物", "ちくわ", "かまぼこ", "大福", "羊羹", "プリン", "ゼリー", "ヨーグルト",
    "寿司", "刺身", "焼き鳥", "すき焼き", "しゃぶしゃぶ", "お好み焼き", "たこ焼き", "もんじゃ焼き", "茶碗蒸し", "肉じゃが",
    "筑前煮", "きんぴらごぼう", "ひじき", "冷奴", "湯豆腐", "麻婆豆腐", "肉まん", "あんまん", "シュークリーム", "ショートケーキ",
    "モンブラン", "ティラミス", "チーズケーキ", "どら焼き", "たい焼き", "今川焼き", "大学芋", "栗きんとん", "みたらし団子", "きな粉餅",
    "桜餅", "柏餅", "ちまき", "おしるこ", "ぜんざい", "水羊羹", "わらび餅", "カステラ", "せんべい", "あられ",
    "おかき", "かりんとう", "金平糖", "飴玉", "ラムネ", "麦茶", "緑茶", "ほうじ茶", "紅茶", "コーヒー",
    "牛乳", "味噌", "醤油", "砂糖", "塩", "胡椒", "唐辛子", "わさび", "生姜", "にんにく",
    "ねぎ", "大根", "人参", "じゃがいも", "玉ねぎ", "キャベツ", "白菜", "ほうれん草", "小松菜", "きゅうり",
    "トマト", "なす", "ピーマン", "かぼちゃ", "さつまいも", "れんこん", "ごぼう", "里芋", "山芋", "しいたけ",
    "えのき", "しめじ", "まいたけ", "りんご", "みかん", "バナナ", "ぶどう", "いちご", "メロン", "すいか",
    "桃", "梨", "柿", "栗", "梅干し", "昆布", "わかめ", "のり", "かつお節", "煮干し",
    "干物", "塩鮭", "コロッケ", "とんかつ", "唐揚げ", "ハンバーグ", "オムライス", "チャーハン", "焼きそば", "ナポリタン",
    "グラタン", "シチュー", "豚汁", "雑煮", "おでん", "天丼", "かつ丼", "親子丼", "牛丼", "海鮮丼",
    "いなり寿司", "巻き寿司", "茶漬け", "雑炊",
    "狼", "熊", "虎", "豹", "象", "兎", "鹿", "猫", "犬", "馬",
    "牛", "羊", "狐", "猿", "栗鼠", "鯨", "海豚", "麒麟", "獅子", "大蛇",
    "鷲", "鷹", "隼", "鴉", "燕", "梟", "鳩", "雀", "鶴", "白鳥",
    "孔雀", "鮫", "亀", "蝶", "蜂", "蜘蛛", "蛍", "蟬", "蟹", "貝",
    "烏賊", "蛸", "海月", "竜", "人魚", "豚", "鶏", "アヒル", "ヤギ", "ラクダ",
    "パンダ", "コアラ", "カンガルー", "キリン", "シマウマ", "サイ", "カバ", "ワニ", "ペンギン", "カメレオン",
    "イグアナ", "ハムスター", "モルモット", "フェレット", "ハリネズミ", "タヌキ", "アナグマ", "イタチ", "カワウソ", "ビーバー",
    "リス", "モグラ", "コウモリ", "フクロウ", "カッコウ", "ウグイス", "ヒバリ", "カワセミ", "トキ", "コウノトリ",
    "ダチョウ", "フラミンゴ", "ペリカン", "アホウドリ", "カモメ", "サメ", "エイ", "タツノオトシゴ", "クラゲ", "ヒトデ",
    "ウニ", "ナマコ", "エビ", "ザリガニ",
    "桜", "楓", "松", "竹", "梅", "椿", "藤", "菊", "蓮", "百合",
    "薔薇", "向日葵", "柳", "苔", "蔦", "林檎", "銀杏", "楠", "欅", "樫",
    "杉", "檜", "筍", "朝顔", "紫陽花", "水仙", "蒲公英", "すすき", "萩", "桔梗",
    "牡丹", "芍薬", "カーネーション", "チューリップ", "パンジー", "コスモス", "彼岸花", "クローバー", "シダ", "ワラビ",
    "タンポポ", "レンゲ", "ナズナ", "ヨモギ", "ドクダミ", "オオバコ", "スギナ", "オミナエシ", "キキョウ", "フジバカマ",
    "ハギ", "ナデシコ", "クズ", "リンドウ", "ノギク",
    "刃", "盾", "杖", "鏡", "鈴", "玉", "環", "塔", "橋", "灯",
    "扇", "傘", "舟", "車輪", "鐘", "糸", "瞳", "翼", "爪", "牙",
    "角", "尾", "羽", "鱗", "心臓", "骨", "血", "種", "芽", "根",
    "殻", "卵", "巣", "城", "庭", "扉", "窓", "机", "電子レンジ", "掃除機",
    "洗濯機", "冷蔵庫", "座布団", "湯たんぽ", "歯ブラシ", "靴下", "傘立て", "三輪車", "自転車", "信号機",
    "郵便ポスト", "自動販売機", "交番", "公民館", "商店街", "電柱", "横断歩道", "踏切", "炊飯器", "トースター",
    "電気ケトル", "ドライヤー", "アイロン", "ミシン", "扇風機", "ストーブ", "こたつ", "布団", "枕", "毛布",
    "カーテン", "絨毯", "ソファ", "本棚", "タンス", "下駄箱", "箒", "雑巾", "バケツ", "ちりとり",
    "ハンガー", "洗濯バサミ", "物干し竿", "鍋", "フライパン", "包丁", "まな板", "茶碗", "皿", "コップ",
    "エプロン",
    "頭", "顔", "目", "鼻", "口", "耳", "首", "肩", "腕", "手",
    "指", "胸", "背中", "腰", "お腹", "脚", "膝", "足", "かかと", "髪",
    "眉", "まつげ", "唇", "舌", "喉", "肺", "胃", "腸", "肝臓",
    "シャツ", "ズボン", "スカート", "ワンピース", "セーター", "コート", "ジャケット", "帽子", "手袋", "マフラー",
    "靴", "ブーツ", "サンダル", "スリッパ", "ネクタイ", "ベルト", "眼鏡", "腕時計", "指輪", "ネックレス",
    "イヤリング", "かばん", "リュック", "財布", "ハンカチ", "タオル", "パジャマ", "浴衣", "着物",
    "電車", "バス", "タクシー", "飛行機", "船", "ヘリコプター", "新幹線", "モノレール", "トラック", "バイク",
    "スクーター", "ゴンドラ", "ロープウェイ", "潜水艦", "ヨット", "カヌー", "いかだ", "馬車", "人力車", "リヤカー",
    "医者", "看護師", "教師", "警察官", "消防士", "大工", "料理人", "美容師", "弁護士", "会計士",
    "パイロット", "船長", "漁師", "農家", "画家", "音楽家", "作家", "俳優", "歌手", "ダンサー",
    "建築家", "デザイナー", "写真家", "獣医", "薬剤師", "郵便配達員", "運転手", "店員", "職人", "芸人",
    "野球", "サッカー", "テニス", "卓球", "バドミントン", "バレーボール", "バスケットボール", "水泳", "柔道", "剣道",
    "空手", "相撲", "ゴルフ", "ボウリング", "スキー", "スケート", "釣り", "登山", "キャンプ", "園芸",
    "読書", "将棋", "囲碁", "麻雀", "折り紙",
    "火山", "温泉", "鍾乳洞", "渓谷", "盆地", "平野", "半島", "岬", "入江", "湾",
    "砂丘", "湿原", "氷河", "間欠泉", "断崖", "絶壁", "滝壺", "渓流", "河口", "三角州",
    "干潟", "珊瑚礁", "砂浜", "岩礁", "離島", "火口", "地層", "鉱山"
  ];
  // 融合コード（"FUSION:長さ:親A:親B"）を検出して親2体のコードを取り出す。長さプレフィックスで区切りの偶然一致を避ける。
  const FUSION_CODE_PREFIX = "FUSION:";
  function parseFusionCode(code) {
    if (typeof code !== "string" || code.indexOf(FUSION_CODE_PREFIX) !== 0) return null;
    const rest = code.slice(FUSION_CODE_PREFIX.length);
    const m = /^(\d+):/.exec(rest);
    if (!m) return null;
    const len = parseInt(m[1], 10);
    const after = rest.slice(m[0].length);
    if (!(len >= 0) || after.length < len + 1 || after.charAt(len) !== ":") return null;
    const a = after.slice(0, len), b = after.slice(len + 1);
    if (!a || !b) return null;
    return [a, b];
  }
  /** 融合個体の名前は親2体の形容詞・名詞を組み替えて作る（片方の形容詞＋もう片方の名詞、など）。 */
  function composeFusionName(a, b, hash) {
    const style = hash % 3;
    if (style === 0) return { name: a.prefixWord + b.suffixWord, prefixWord: a.prefixWord, suffixWord: b.suffixWord };
    if (style === 1) return { name: b.prefixWord + a.suffixWord, prefixWord: b.prefixWord, suffixWord: a.suffixWord };
    return { name: a.prefixWord + b.prefixWord + a.suffixWord, prefixWord: a.prefixWord, suffixWord: a.suffixWord };
  }

  const RANKS = [[68, "SS"], [62, "S"], [57, "A"], [51, "B"], [45, "C"], [38, "D"], [0, "E"]];
  function rankOf(total) { for (let i = 0; i < RANKS.length; i++) if (total >= RANKS[i][0]) return RANKS[i][1]; return "E"; }

  const SEEDS = [0x9E3779B9, 0x85EBCA6B, 0xC2B2AE35, 0x27D4EB2F, 0x165667B1, 0xD3A2646C, 0xFD7046C5, 0xB55A4F09];
  const PRIMES = [1009, 1013, 1019, 1021, 1031, 1033, 1039, 1049];
  const STAT_KEYS = ["ATK", "DEF", "SPD", "TEC", "LUK"];

  // 5要素の順列120通り（どの計算結果がどのステータスになるかも内容で入れ替える）
  function permutation(idx) {
    const pool = [0, 1, 2, 3, 4], out = [];
    let x = (idx >>> 0) % 120;
    const F = [1, 1, 2, 6, 24];
    for (let k = 5; k >= 1; k--) {
      const f = F[k - 1];
      const i = Math.floor(x / f) % k;
      out.push(pool.splice(i, 1)[0]);
      x = x % f;
    }
    return out;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** 正規化済みコード文字列から個体を決定論的に生成する */
  function build(normalized) {
    const b = utf8Bytes(normalized);
    const f = features(normalized);

    // 8本の独立した種。ハッシュと構造特徴を掛け合わせる
    const mixIn = [f.posw, f.sqw, f.alt, f.foldB, f.comp, f.shape,
      (f.symm * 7919 + f.flags * 104729) >>> 0, (f.distinct * 65537 + f.runMax * 257) >>> 0];
    const S = [];
    for (let k = 0; k < 8; k++) {
      const hk = murmur3(b, SEEDS[k]);
      S.push((hk ^ Math.imul(mixIn[k] >>> 0, PRIMES[k]) ^ Math.imul((f.buckets[k * 2] ^ f.buckets[k * 2 + 1]) >>> 0, 0x45D9F3B)) >>> 0);
    }
    const hAll = (fnv1a(b) ^ djb2(b) ^ sdbm(b) ^ S[0] ^ S[3] ^ S[6]) >>> 0;
    const seed = S.reduce(function (a, x) { return (a ^ Math.imul(x, 0x9E3779B1)) >>> 0; },
      (Math.imul(b.length + 1, 2654435761) ^ hAll) >>> 0);
    const rnd = sm32(seed);

    // 素質：全体を底上げ／底下げ。v2 で幅を圧縮し、TOTAL より「型」で差がつくようにした。
    const grade = ((rnd() + rnd() + rnd()) / 3 - 0.5) * 22;

    const temper = TEMPERS[(S[4] >>> 7) % TEMPERS.length];
    // 属性: コード系統から読める傾向を主に、ハッシュで時々 ±1 ずらす（完全には読めない）
    const hashElem = ((S[5] >>> 3) ^ (f.foldB >>> 11)) % 5;
    const famElem = familyElem(normalized);
    let elemIdx;
    if (famElem >= 0) {
      const g = S[6] & 7;
      const nudge = (g === 0) ? 1 : (g === 1) ? -1 : (g === 2) ? 2 : 0; // 5/8 は系統どおり
      elemIdx = ((famElem + nudge) % 5 + 5) % 5;
    } else {
      elemIdx = hashElem;
    }
    const trait = TRAITS[((S[6] >>> 5) ^ f.shape) % TRAITS.length];

    // 5つの素の値を、それぞれ別々の材料から作る
    const terms = [
      (Math.imul((f.posw ^ S[0]) >>> 0, 0x2545F491) >>> 0) % 1021,
      (Math.imul((f.foldB + f.comp) >>> 0, 0x9E3779B1) >>> 0) % 1019,
      (Math.imul((f.sqw ^ (S[2] >>> 6)) >>> 0, 0x85EBCA77) >>> 0) % 1013,
      (Math.imul((f.shape + f.symm * 131 + f.flags * 1777) >>> 0, 0xC2B2AE3D) >>> 0) % 1009,
      (Math.imul((f.alt ^ (f.distinct * 40503) ^ S[7]) >>> 0, 0x27D4EB2D) >>> 0) % 1031
    ];

    const raw = [];
    for (let i = 0; i < 5; i++) {
      const d1 = rnd(), d2 = rnd();
      const ft = terms[i] / 1030;
      const ht = ((S[i] >>> (i * 3 + 5)) & 0xFFFF) / 65535;
      raw.push((0.42 * ((d1 + d2) / 2) + 0.30 * ft + 0.28 * ht) * 99 + 1);
    }

    // どの値がどのステータスになるかも内容で決める
    const perm = permutation((S[1] >>> 9) ^ (f.comp & 0x7F));
    const stats = {};
    for (let i = 0; i < 5; i++) {
      // 下限を上げて「1ステータスが死んでいる個体」をなくす（1v1で機能不全になるのを防ぐ）
      stats[STAT_KEYS[i]] = clamp(Math.round(raw[perm[i]] + grade + temper.off[i]), 24, 100);
    }

    let sum = 0; for (let i = 0; i < 5; i++) sum += stats[STAT_KEYS[i]];
    const total = Math.round(sum / 5);

    // 名前: 実在する日本語の単語2つを組み合わせる。融合コード（"FUSION:..."）なら
    // 親2体の単語から新しい組み合わせを作る（新しい生成ロジックではなく、既存の beastOf を再帰的に使うだけ）。
    let name, prefixWord, suffixWord;
    const fusionParts = parseFusionCode(normalized);
    if (fusionParts) {
      const pa = beastOf(fusionParts[0]), pb = beastOf(fusionParts[1]);
      const fn = composeFusionName(pa, pb, hAll);
      name = fn.name; prefixWord = fn.prefixWord; suffixWord = fn.suffixWord;
    } else {
      prefixWord = NAME_PREFIX[(S[0] >>> 11) % NAME_PREFIX.length];
      suffixWord = NAME_SUFFIX[(S[2] >>> 13) % NAME_SUFFIX.length];
      name = prefixWord + suffixWord;
    }
    const sid = ("0000" + ((hAll >>> 16) & 0xFFFF).toString(16).toUpperCase()).slice(-4);

    // 技（攻撃手段）: 既存の値を消費するだけで乱数の並びには触れない（他の項目に影響しない追加要素）。
    // 1本目は自分の属性（十八番）、2・3本目はハッシュで別に決まる（他属性のカバー技になり得る）。
    const moveElems = [
      elemIdx,
      ((S[6] >>> 7) ^ (hAll >>> 3) ^ (f.shape >>> 4)) % 5,
      ((S[7] >>> 11) ^ (hAll >>> 15) ^ (f.foldB >>> 6)) % 5
    ];
    const usedKinds = Object.create(null);
    const moves = moveElems.map(function (me, i) {
      let kb = ((S[(i + 2) % 8] >>> (3 + i * 5)) ^ (hAll >>> (i * 3 + 1)) ^ (f.comp >>> i)) >>> 0;
      let kind = MOVE_KIND_POOL[kb % MOVE_KIND_POOL.length];
      let tries = 0;
      while (usedKinds[kind] && tries < MOVE_KIND_POOL.length) { kb = (kb + 0x9E3779B9) >>> 0; kind = MOVE_KIND_POOL[kb % MOVE_KIND_POOL.length]; tries++; }
      usedKinds[kind] = true;
      return { elem: me, element: ELEMENTS[me], kind: kind, name: ELEMENTS[me].name + "・" + MOVE_KIND_NAME[kind] };
    });

    return {
      code: normalized, name: name, sid: sid,
      prefixWord: prefixWord, suffixWord: suffixWord,
      stats: stats, sum: sum, total: total, rank: rankOf(total),
      elem: elemIdx, element: ELEMENTS[elemIdx],
      temper: temper.name, trait: trait, hash: hAll >>> 0,
      moves: moves
    };
  }

  const cache = Object.create(null);
  function beastOf(text) {
    const key = normalize(text);
    const hit = cache[key];
    if (hit) return hit;
    const v = build(key);
    cache[key] = v;
    return v;
  }

  // ══════════════ 自動対戦 ══════════════

  function mkFighter(beast, side, mastery) {
    const st = beast.stats;
    return {
      beast: beast, side: side, name: beast.name,
      atk: st.ATK, def: st.DEF, spd: st.SPD, tec: st.TEC, luk: st.LUK,
      trait: beast.trait.key, elem: beast.elem, moves: beast.moves || [],
      mastery: Math.max(0, Math.min(5, (mastery | 0))),
      // DEF が主だが SPD も少し体力に効く。total 依存は弱め（強個体が過度にタンクにならないよう）
      maxHp: Math.round(250 + st.DEF * 2.7 + st.SPD * 0.9 + beast.total * 0.7) + (beast.hpAdd || 0),
      hp: 0, defDrop: 0, endured: false, desperate: false,
      crits: 0, hits: 0, dodges: 0, extra: 0, dealt: 0, favHits: 0, finisherHits: 0
    };
  }

  /** 2体の自動対戦。順番を入れ替えても同じ結果になるよう種は対称に作る。
   *  gameSeed を渡すと展開が変わる（個体は不変・種だけ差し替え）。同じ gameSeed なら再現する。 */
  function battle(beastA, beastB, gameSeed, mstA, mstB, despSide) {
    const A = mkFighter(beastA, "A", mstA), B = mkFighter(beastB, "B", mstB);
    A.hp = A.maxHp; B.hp = B.maxHp;
    // 背水の陣: マッチで負けている側は、そのゲームだけ少し粘り強くなる（一発逆転の後押し）
    A.desperate = despSide === "A"; B.desperate = despSide === "B";
    // その日・その一戦の「調子」。TOTAL差がわずかでも大差になりすぎないよう、全ステータスを試合単位でまとめてぶらす
    // （ターン内の乱数と違い、ターン数が多くても打ち消し合って薄まらない）。
    applyCondition(A, conditionRoll(beastA.hash, gameSeed));
    applyCondition(B, conditionRoll(beastB.hash, gameSeed));

    const lo = Math.min(beastA.hash, beastB.hash), hi = Math.max(beastA.hash, beastB.hash);
    const baseSeed = (Math.imul(lo, 0x85EBCA6B) ^ Math.imul(hi, 0xC2B2AE35) ^ 0x5BF03635) >>> 0;
    const rnd = sm32((baseSeed ^ Math.imul((gameSeed >>> 0) || 0, 0x9E3779B1)) >>> 0);

    const log = [];
    // 演出用に、その時点のHPを各ログへ添える
    function push(o) { o.ha = Math.max(0, A.hp); o.hb = Math.max(0, B.hp); log.push(o); }
    if (A.desperate) push({ t: "note", s: "A", r: 0, m: A.name + " は背水の陣（このゲームは粘る）" });
    if (B.desperate) push({ t: "note", s: "B", r: 0, m: B.name + " は背水の陣（このゲームは粘る）" });

    /** 技（攻撃手段）を自動で選ぶ。瀕死なら捨身の一撃、それ以外は相手への相性が良い技を優先。 */
    function chooseMove(at, df) {
      const list = at.moves;
      if (!list || !list.length) return { elem: at.elem, element: ELEMENTS[at.elem], kind: "strike", name: "一撃" };
      const finisher = list.find(function (m) { return m.kind === "finisher"; });
      const finThresh = at.desperate ? 0.28 : 0.18;
      if (finisher && at.hp / at.maxHp <= finThresh) return finisher;
      let best = null, bestScore = -1;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.kind === "finisher") continue;
        const score = affinity(m.elem, df.elem) * (MOVE_POWER[m.kind] || 1) + rnd() * 0.06;
        if (score > bestScore) { bestScore = score; best = m; }
      }
      return best || list[0];
    }

    // 行動順は 速 のみ（＋特性）。運は関与しない。
    function orderScore(x, round) {
      let s = x.spd;
      if (x.trait === "swift") s *= 1.16;
      if (x.trait === "crush") s *= 0.85;
      if (round === 1 && x.trait === "swift") s += 45;
      return s;
    }

    function strike(at, df) {
      const move = chooseMove(at, df);

      // 回避 = 速の差（＋守勢の特性）。技が命中を底上げして回避を相殺する。
      let ev = 0.035 + (df.spd - at.spd) * 0.0050 - at.tec * 0.0018;
      if (df.trait === "serene") ev += 0.05;
      if (df.trait === "swift") ev += 0.03;
      if (at.trait === "focus") ev -= at.tec * 0.0012;
      ev = clamp(ev, 0.01, 0.38);
      if (rnd() < ev) { df.dodges++; return { dodge: true, dmg: 0, aff: 1, move: move }; }

      // 基礎ダメージは 攻 × 技の威力係数。
      let base = at.atk * 0.92 * (MOVE_POWER[move.kind] || 1);
      if (at.trait === "fang") base *= 1.12;
      if (at.trait === "crush") base *= 1.25;
      if (at.trait === "gale") base *= (1 + at.spd * 0.0035);
      if (at.trait === "focus") base *= (1 + at.tec * 0.0026);
      if (at.trait === "wrath" && at.hp / at.maxHp < 0.35) base *= 1.35;
      if (at.desperate) base *= 1.05;

      // 技は 守 を少し貫通。calc・克撃はさらに上乗せ。
      let defEff = df.def * (1 - df.defDrop) * (1 - Math.min(0.22, at.tec / 100 * 0.22));
      if (move.kind === "pierce") defEff *= 0.78;
      if (at.trait === "calc") defEff *= 0.68;
      if (df.trait === "wall") base *= 0.88;
      if (df.trait === "serene") base *= 0.96;

      // 相性は「使った技の属性」対「相手の属性」で決まる（同じ個体でも技によって有利不利が変わる）
      const aff = affinity(move.elem, df.elem);
      let dmg = base * (150 / (150 + defEff * 1.35));
      // 技(TEC) = 防御を無視する確定ダメージ（精密打撃）。技型のアイデンティティ。
      dmg += at.tec * 0.55;
      dmg *= aff;

      // 振れ幅: 運が広げ、技が狭める（安定 ⇔ 一発）。熟練度でさらに少し狭まる。
      let spread = clamp(0.17 * (1 + at.luk / 100 * 0.95 - at.tec / 100 * 0.70), 0.05, 0.32);
      spread *= (1 - Math.min(0.10, at.mastery * 0.02));
      dmg *= (1 - spread) + rnd() * 2 * spread;

      // 運 = 会心（一発型のアイデンティティ）。会心撃・背水の陣はさらに上がる。
      let crit = clamp(0.025 + at.luk * 0.0050 + (move.kind === "crit" ? 0.09 : 0) + (at.desperate ? 0.03 : 0), 0, 0.5);
      if (at.trait === "luck") crit *= 1.9;
      if (df.trait === "serene") crit *= 0.45;
      const isCrit = rnd() < crit;
      if (isCrit) { dmg *= (1.65 + at.luk / 100 * 1.0); at.crits++; }
      if (aff >= 1.08) at.favHits++;
      if (move.kind === "finisher") at.finisherHits++;

      dmg = Math.max(1, Math.round(dmg));
      df.hp -= dmg; at.dealt += dmg; at.hits++;

      if (move.kind === "drain") { const heal = Math.round(dmg * 0.35); at.hp = Math.min(at.maxHp, at.hp + heal); }

      let reflected = 0;
      if (df.trait === "reflect") {
        reflected = Math.max(1, Math.round(dmg * 0.18));
        at.hp -= reflected;
      }
      if (df.hp <= 0 && df.trait === "endure" && !df.endured) { df.endured = true; df.hp = 1; }
      return { dodge: false, dmg: dmg, crit: isCrit, reflected: reflected, aff: aff, move: move };
    }

    let round = 0;
    const MAXR = 24;
    while (round < MAXR && A.hp > 0 && B.hp > 0) {
      round++;
      const sa = orderScore(A, round), sb = orderScore(B, round);
      const first = (sa > sb) ? A : (sb > sa) ? B : (beastA.hash >= beastB.hash ? A : B);
      const seq = [first, (first === A) ? B : A];

      for (let q = 0; q < 2; q++) {
        const at = seq[q];
        if (at.hp <= 0) continue;
        const df = (at === A) ? B : A;
        if (df.hp <= 0) break;
        let times = 1;
        if (at.trait === "twin" && rnd() < 0.18) { times = 2; at.extra++; }
        for (let t = 0; t < times && df.hp > 0 && at.hp > 0; t++) {
          const r = strike(at, df);
          if (r.dodge) {
            push({ t: "miss", s: at.side, r: round, m: df.name + " が攻撃をかわした" });
          } else {
            push({
              t: r.move.kind === "finisher" ? "finisher" : (r.crit ? "crit" : "hit"), s: at.side, r: round,
              m: at.name + " の「" + r.move.name + "」" + (r.move.kind === "finisher" ? "！！ " : "") +
                " → " + r.dmg + " ダメージ" + (r.crit ? "（会心）" : "") +
                (r.aff >= 1.08 ? "（有利）" : (r.aff <= 0.92 ? "（不利）" : "")) +
                (r.move.kind === "drain" ? "（吸収）" : "") +
                (t > 0 ? "（連撃）" : "") + (r.reflected ? " ／ 反射 " + r.reflected : "")
            });
          }
        }
      }

      // 処理順をスロットではなく個体で決める（AとBを入れ替えても同じ結果にするため）
      const pair = (beastA.hash >= beastB.hash) ? [A, B] : [B, A];
      for (let q = 0; q < 2; q++) {
        const x = pair[q], y = (x === A) ? B : A;
        if (x.hp <= 0) continue;
        if (x.trait === "regen" && x.hp < x.maxHp) {
          const h = Math.round(x.maxHp * 0.025);
          x.hp = Math.min(x.maxHp, x.hp + h);
          push({ t: "buff", s: x.side, r: round, m: x.name + " が " + h + " 回復" });
        }
        if (x.trait === "curse") y.defDrop = Math.min(0.40, y.defDrop + 0.06);
        if (x.trait === "venom" && y.hp > 0) {
          const d = Math.max(1, Math.round(y.maxHp * 0.02));
          y.hp -= d;
          push({ t: "dot", s: x.side, r: round, m: y.name + " は蝕毒で " + d + " ダメージ" });
        }
      }
    }

    let winner, loser, decision;
    if (A.hp <= 0 && B.hp <= 0) {
      winner = (A.luk !== B.luk) ? (A.luk > B.luk ? A : B) : (beastA.hash >= beastB.hash ? A : B);
      decision = "相打ち";
    } else if (A.hp <= 0 || B.hp <= 0) {
      winner = (A.hp > 0) ? A : B; decision = "撃破";
    } else {
      const ra = A.hp / A.maxHp, rb = B.hp / B.maxHp;
      winner = (ra !== rb) ? (ra > rb ? A : B) : (beastA.hash >= beastB.hash ? A : B);
      decision = "判定";
    }
    loser = (winner === A) ? B : A;

    const wb = winner.beast, lb = loser.beast;
    let reason;
    if (winner.desperate && loser.hp <= 0) reason = "背水の陣からの大逆転";
    else if (winner.finisherHits >= 1 && loser.hp <= 0) reason = "捨身の一撃が決め手になった一発逆転";
    else if (wb.total < lb.total - 3) reason = "格上を相性と特性で崩した番狂わせ";
    else if (winner.favHits >= 2) reason = "技の相性で押し切った";
    else if (winner.crits >= 3) reason = "会心の一撃を重ねて決着";
    else if (round <= 4) reason = "圧倒的な速攻で沈めた";
    else if (winner.hp / winner.maxHp > 0.6) reason = "堅い守りを崩されず完勝";
    else if (winner.dodges >= 4) reason = "速さで攻撃をかわし続けた";
    else if (winner.extra >= 2) reason = "特性「" + wb.trait.name + "」がかみ合った";
    else if (decision === "判定") reason = "決着つかず、残りHPの差で判定勝ち";
    else reason = "地力の差で押し切った";

    return {
      winner: wb, loser: lb, winnerSide: winner.side,
      turns: round, decision: decision, reason: reason, log: log,
      hpA: Math.max(0, A.hp), maxHpA: A.maxHp, hpB: Math.max(0, B.hp), maxHpB: B.maxHp,
      statsA: { crits: A.crits, dodges: A.dodges, dealt: A.dealt },
      statsB: { crits: B.crits, dodges: B.dodges, dealt: B.dealt }
    };
  }

  /** 2本先取（最大3ゲーム）のマッチ。salt に日付や再戦回数を混ぜると毎回展開が変わる。
   *  A/B を入れ替えても結果は同じ（各ゲームの種を対称に作る）。 */
  function match(beastA, beastB, salt, mstA, mstB) {
    salt = (salt >>> 0) || 0;
    const games = [];
    let wa = 0, wb = 0;
    for (let k = 0; k < 3; k++) {
      const gs = (Math.imul(salt + 0x9E3779B9, 0x27D4EB2F) ^ Math.imul(k + 1, 0x85EBCA6B)) >>> 0;
      // 背水の陣: 直前までのスコアで負けている側に、そのゲームだけ後押しを与える
      const desp = wa > wb ? "B" : (wb > wa ? "A" : null);
      const g = battle(beastA, beastB, gs, mstA, mstB, desp);
      g.gameSeed = gs;
      games.push(g);
      if (g.winnerSide === "A") wa++; else wb++;
      if (wa === 2 || wb === 2) break;
    }
    const winnerSide = (wa > wb) ? "A" : "B";
    return {
      games: games, count: games.length,
      scoreA: wa, scoreB: wb, winnerSide: winnerSide,
      winner: (winnerSide === "A") ? beastA : beastB,
      loser: (winnerSide === "A") ? beastB : beastA
    };
  }

  // ══════════════ スカッド（3体編成）対戦 ══════════════

  /** コード内容から読める「系統」ラベル（共鳴の判定に使う） */
  function familyTag(s) {
    s = String(s == null ? "" : s);
    const d = s.replace(/[-\s]/g, "");
    if (/^97[89]\d{10}$/.test(d)) return "BOOK";
    if (/^https?:\/\//i.test(s)) {
      const m = s.match(/^https?:\/\/[^/]*?\.([a-z]{2,})(?=[:/]|$)/i);
      return "URL:" + (m ? m[1].toLowerCase() : "x");
    }
    if (/^(WIFI|MECARD|MATMSG|BEGIN:VCARD|GEO:|TEL:|MAILTO:|SMSTO):/i.test(s)) return "QR:" + s.split(/[:;]/)[0].toUpperCase();
    if (/^\d{8}$/.test(d) || /^\d{12,14}$/.test(d)) return "JAN:" + d.slice(0, 2);
    if (/^\d+$/.test(d) && d.length >= 4) return "NUM:" + (d.length <= 6 ? "S" : d.length <= 12 ? "M" : "L");
    if (s.length <= 24 && /^[A-Z0-9\-. $/+%*]+$/.test(s)) return "TEXT";
    return "MISC";
  }

  const SYNERGY_DEFS = [
    { key: "fortress", name: "要塞陣" },
    { key: "collapse", name: "崩壊" },
    { key: "pierce", name: "貫通陣" },
    { key: "firststrike", name: "先制必中会心" },
    { key: "rest", name: "静養" }
  ];

  /** 3体（前衛/中衛/後衛）のトレイトから、隊のオーラ・シナジー・共鳴をまとめる */
  function squadAura(traits, reso) {
    const a = { dmgMul: 1, takenMul: 1, critAdd: 0, pierce: 0, regen: 0, curseTick: 0, venomTick: 0, firstStrike: 0, enemyCritAdd: 0, synergies: [] };
    const bench = [traits[1], traits[2]];
    const has = function (t) { return traits.indexOf(t) >= 0; };
    const benchHas = function (t) { return bench.indexOf(t) >= 0; };
    bench.forEach(function (t) {
      if (t === "fang") a.dmgMul *= 1.05;
      else if (t === "wall") a.takenMul *= 0.95;
      else if (t === "calc") a.pierce += 0.10;
      else if (t === "luck") a.critAdd += 0.015;
      else if (t === "curse") a.curseTick += 0.025;
      else if (t === "venom") a.venomTick += 0.009;
      else if (t === "regen") a.regen += 0.014;
      else if (t === "focus") a.dmgMul *= 1.02;
      else if (t === "serene") a.enemyCritAdd -= 0.01;
    });
    const auraBench = ["fang", "wall", "calc", "luck", "curse", "venom", "regen", "serene"];
    if (traits[0] === "wall" && auraBench.some(benchHas)) { a.takenMul *= 0.97; a.synergies.push("要塞陣"); }
    if (has("curse") && has("venom")) { a.curseTick *= 1.5; a.venomTick *= 1.5; a.synergies.push("崩壊"); }
    if (traits[0] === "fang" && benchHas("calc")) { a.dmgMul *= 1.08; a.synergies.push("貫通陣"); }
    if (traits[0] === "swift" && benchHas("luck")) { a.critAdd += 0.05; a.firstStrike = 1; a.synergies.push("先制必中会心"); }
    if (benchHas("regen") && benchHas("serene")) { a.regen *= 1.5; a.synergies.push("静養"); }
    if (reso && reso.family) { a.dmgMul *= 1.04; a.takenMul *= 0.97; a.synergies.push("同族共鳴"); }
    if (reso && reso.session) { a.dmgMul *= 1.03; a.firstStrike = 1; a.synergies.push("同刻共鳴"); }
    return a;
  }

  /** スカッド1ゲーム。sq = { beasts:[b,b,b], mastery:[m,m,m], reso:{family,session} }。前衛が受け、倒れると繰り上がる。 */
  function squadBattle(sqA, sqB, gameSeed, despSide) {
    const hashesA = sqA.beasts.map(function (b) { return b.hash; });
    const hashesB = sqB.beasts.map(function (b) { return b.hash; });
    // 両隊とも同じ畳み方（側に依存しない＝A/B を入れ替えても同じ結果）
    const foldSquad = function (hs) {
      return hs.reduce(function (x, h) { return (x ^ Math.imul(h >>> 0, 0x85EBCA6B)) >>> 0; }, 0x9E3779B9);
    };
    const foldA = foldSquad(hashesA), foldB = foldSquad(hashesB);
    const lo = Math.min(foldA, foldB), hi = Math.max(foldA, foldB);
    const rnd = sm32(((Math.imul(lo, 0x85EBCA6B) ^ Math.imul(hi, 0xC2B2AE35)) ^ Math.imul((gameSeed >>> 0) || 0, 0x9E3779B1)) >>> 0);

    function mkLine(sq) {
      return sq.beasts.map(function (b, i) {
        const fx = mkFighter(b, null, sq.mastery ? sq.mastery[i] : 0);
        applyCondition(fx, conditionRoll(b.hash, gameSeed));
        fx.hp = fx.maxHp;
        return fx;
      });
    }
    const LA = mkLine(sqA), LB = mkLine(sqB);
    // 背水の陣: マッチで負けている隊は、そのゲームだけ全員が少し粘り強くなる
    if (despSide === "A") LA.forEach(function (f) { f.desperate = true; });
    if (despSide === "B") LB.forEach(function (f) { f.desperate = true; });
    const traitsA = LA.map(function (f) { return f.trait; });
    const traitsB = LB.map(function (f) { return f.trait; });
    const auA = squadAura(traitsA, sqA.reso), auB = squadAura(traitsB, sqB.reso);
    auA.critAdd += auB.enemyCritAdd;
    auB.critAdd += auA.enemyCritAdd;

    let iA = 0, iB = 0; // 現・前衛のインデックス
    const log = [];
    const push = function (o) {
      o.ha = Math.max(0, LA[iA] ? LA[iA].hp : 0);
      o.hb = Math.max(0, LB[iB] ? LB[iB].hp : 0);
      o.fa = iA; o.fb = iB;
      log.push(o);
    };
    if (auA.synergies.length) push({ t: "note", s: "A", r: 0, m: "A隊: " + auA.synergies.join("・") });
    if (auB.synergies.length) push({ t: "note", s: "B", r: 0, m: "B隊: " + auB.synergies.join("・") });
    if (despSide) push({ t: "note", s: despSide, r: 0, m: (despSide === "A" ? "A隊" : "B隊") + " は背水の陣（このゲームは粘る）" });

    // ══════════════ 技の効果（株バトル §6.2 の 18 種）══════════════
    // もとの CB は strike / crit / pierce / drain / finisher の 5 種しか効かせず、
    // 株バトル側は残りを近いものに丸めていた（技名だけ違って中身が同じ）。
    // エンジンを取り込んだので、設計書 §6.2 の語彙をそのまま実装する。
    //
    // 数値は moves.json が持つ（pow / min / max / add / cap / maxMult / turns / cut /
    // ratio / rate / stat / mult / critAdd / pierce / drain）。ここは既定値だけ持つ。

    const num = function (v, d) { const n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); };

    /** 継続効果を置く場所。個体そのものは触らない（素体は不変） */
    function initEffects(f) {
      f.stack = 0;          // stack で積んだ攻の加算
      f.shieldCut = 0;      // 被ダメ軽減
      f.shieldT = 0;
      f.reflect = 0;        // 次の被弾の反射率
      f.dots = [];          // [{rate, turns, by}]
      f.debuffs = [];       // [{stat, cut, turns}]
      f.delayed = [];       // [{pow, turns, elem, name}]
      f.goFirst = false;    // 次のターン必ず先手
      f.guard = false;      // counter: このターン回避に専念
      f.regenRate = 0;      // 毎ターンの自己回復
    }
    LA.forEach(initEffects); LB.forEach(initEffects);

    /** debuff と stack を乗せた実効値。素の atk/def/spd は書き換えない */
    function eff(f, key) {
      let v = f[key] + (key === "atk" ? f.stack : 0);
      for (let i = 0; i < f.debuffs.length; i++) if (f.debuffs[i].stat === key) v *= (1 - f.debuffs[i].cut);
      return Math.max(1, v);
    }

    const DAMAGING = { strike: 1, crit: 1, pierce: 1, drain: 1, multi: 1, sure: 1, first: 1, stack: 1, gamble: 1, counter: 1, finisher: 1 };

    /**
     * その技がいまどれだけ「打ちたい」か。攻撃技は相性 × 威力、
     * 補助技は効く場面でだけ高くなる（回復を満タンで撃たない、盾を二重に張らない）。
     */
    function moveScore(m, at, df) {
      const k = m.kind;
      if (DAMAGING[k]) {
        const pow = num(m.pow, MOVE_POWER[k] != null ? MOVE_POWER[k] : 1);
        // 1 手で何発ぶん入るかを見込む。連撃は 1 発が軽くても合計は重い、
        // 博打は当たり外れの真ん中で見る（見込まないと連撃と博打が永久に選ばれない）
        let expected = pow;
        if (k === "multi") expected *= (Math.max(1, num(m.min, 2)) + Math.max(1, num(m.max, 3))) / 2;
        else if (k === "gamble") expected *= num(m.maxMult, 2.4) / 2;
        else if (k === "finisher") expected *= num(m.mult, 1);
        else if (k === "stack") expected += at.stack * 0.004;   // 積み上がっているほど価値が出る
        return affinity(m.elem, df.elem) * expected;
      }
      if (k === "heal") return at.hp / at.maxHp < 0.55 ? 1.25 * (1 - at.hp / at.maxHp) * 2 : -1;
      if (k === "shield") return at.shieldT > 0 ? -1 : 0.95;
      if (k === "regen") return at.regenRate > 0 ? -1 : 0.9;
      if (k === "reflect") return at.reflect > 0 ? -1 : 0.9;
      if (k === "dot") return df.dots.length ? -1 : 1.05;
      if (k === "debuff") return df.debuffs.length >= 2 ? -1 : 1.0;
      if (k === "delay") return at.delayed.length ? -1 : 1.15;
      // 相手が守り寄りのときだけ入れ替える意味がある
      if (k === "swap") return eff(df, "def") > eff(df, "atk") * 1.15 ? 1.2 : -1;
      return 0.9;
    }

    /** 技を自動で選ぶ。瀕死なら捨身の一撃、それ以外は場面に合う技を優先。 */
    function chooseMove(at, df) {
      const list = at.moves;
      if (!list || !list.length) return { elem: at.elem, element: ELEMENTS[at.elem], kind: "strike", name: "一撃" };
      const finisher = list.find(function (m) { return m.kind === "finisher"; });
      const finThresh = at.desperate ? 0.28 : 0.18;
      if (finisher && at.hp / at.maxHp <= finThresh) return finisher;
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.kind === "finisher") continue;
        const score = moveScore(m, at, df) + rnd() * 0.06;
        if (score > bestScore) { bestScore = score; best = m; }
      }
      // どれも場面に合わないなら、素直に殴れる技を選ぶ
      if (!best || bestScore < 0) {
        for (let i = 0; i < list.length; i++) if (DAMAGING[list[i].kind]) return list[i];
      }
      return best || list[0];
    }

    /** ダメージの本体。1 発ぶん。 */
    function strike(at, df, move, myAura, foeAura, powMul) {
      let base = eff(at, "atk") * 0.92 * num(move.pow, MOVE_POWER[move.kind] != null ? MOVE_POWER[move.kind] : 1) * myAura.dmgMul * (powMul || 1);
      if (at.trait === "fang") base *= 1.12;
      if (at.trait === "crush") base *= 1.25;
      if (at.trait === "gale") base *= (1 + eff(at, "spd") * 0.0035);
      if (at.trait === "focus") base *= (1 + at.tec * 0.0026);
      if (at.trait === "wrath" && at.hp / at.maxHp < 0.35) base *= 1.35;
      if (at.desperate) base *= 1.05;
      if (move.kind === "finisher") base *= num(move.mult, 1);

      // sure（必中）は守りもバフも抜けない代わりに威力が低い。§6.2 の「必中・バフデバフ無視」
      const ignoreDef = move.kind === "sure";
      const extraPierce = move.kind === "pierce" ? num(move.pierce, 0.14) : 0;
      let defEff = ignoreDef ? 0
        : eff(df, "def") * (1 - df.defDrop) * (1 - Math.min(0.55, at.tec / 100 * 0.22 + myAura.pierce + extraPierce));
      if (at.trait === "calc") defEff *= 0.68;
      if (df.trait === "wall") base *= 0.88;
      if (df.trait === "serene") base *= 0.96;

      const aff = move.kind === "sure" ? 1 : affinity(move.elem, df.elem);
      let dmg = base * (150 / (150 + defEff * 1.35));
      dmg += at.tec * 0.55;                 // 確定ダメージ（技）
      dmg *= aff * (move.kind === "sure" ? 1 : foeAura.takenMul);
      let spread = clamp(0.17 * (1 + at.luk / 100 * 0.95 - at.tec / 100 * 0.70), 0.05, 0.32);
      spread *= (1 - Math.min(0.10, at.mastery * 0.02));
      if (move.kind === "sure") spread *= 0.35;            // 必中は振れも小さい
      dmg *= (1 - spread) + rnd() * 2 * spread;

      let crit = clamp(0.025 + at.luk * 0.0050 + myAura.critAdd +
        (move.kind === "crit" ? num(move.critAdd, 0.09) : 0) + (at.desperate ? 0.03 : 0), 0, 0.5);
      if (at.trait === "luck") crit *= 1.9;
      if (df.trait === "serene") crit *= 0.45;
      const isCrit = move.kind === "sure" ? false : rnd() < crit;
      if (isCrit) { dmg *= (1.65 + at.luk / 100 * 1.0); at.crits++; }

      // 盾（shield）は被ダメを減らす
      if (df.shieldT > 0) dmg *= (1 - df.shieldCut);

      dmg = Math.max(1, Math.round(dmg));
      df.hp -= dmg; at.dealt += dmg; at.hits++;
      if (move.kind === "drain") { const h = Math.round(dmg * num(move.drain, 0.35)); at.hp = Math.min(at.maxHp, at.hp + h); }
      // 反射（reflect）は受けた側が張っていたぶんを返す。1 回で消える
      if (df.reflect > 0) {
        const back = Math.max(1, Math.round(dmg * df.reflect));
        at.hp -= back; df.reflect = 0;
        at.reflectedBy = back;
      }
      if (df.hp <= 0 && df.trait === "endure" && !df.endured) { df.endured = true; df.hp = 1; }
      return { dmg: dmg, crit: isCrit, aff: aff };
    }

    /**
     * 1 手ぶん。技の種類ごとに何が起きるかを決めて、ログの文面まで作って返す。
     * @returns {{t:string, m:string}} ログ 1 行ぶん
     */
    function act(at, df, myAura, foeAura) {
      const move = chooseMove(at, df);
      const name = at.name + " の「" + move.name + "」";

      // ── 攻撃しない技 ──
      if (move.kind === "heal") {
        const h = Math.max(1, Math.round(at.maxHp * num(move.rate, 0.16)));
        at.hp = Math.min(at.maxHp, at.hp + h);
        return { t: "buff", m: name + " +" + h + " 回復" };
      }
      if (move.kind === "shield") {
        at.shieldCut = clamp(num(move.cut, 0.12), 0, 0.5);
        at.shieldT = Math.max(1, Math.round(num(move.turns, 2)));
        return { t: "buff", m: name + " 守りを固めた（被ダメ −" + Math.round(at.shieldCut * 100) + "%・" + at.shieldT + "ターン）" };
      }
      if (move.kind === "regen") {
        at.regenRate = clamp(num(move.rate, 0.05), 0, 0.15);
        return { t: "buff", m: name + " 毎ターン回復するようになった" };
      }
      if (move.kind === "reflect") {
        at.reflect = clamp(num(move.ratio, 0.30), 0, 0.8);
        return { t: "buff", m: name + " 次の一撃を " + Math.round(at.reflect * 100) + "% 返す構え" };
      }
      if (move.kind === "dot") {
        df.dots.push({ rate: clamp(num(move.rate, 0.05), 0, 0.12), turns: Math.max(1, Math.round(num(move.turns, 3))) });
        return { t: "dot", m: name + " " + df.name + " がじわじわ効いてきた" };
      }
      if (move.kind === "debuff") {
        const raw = String(move.stat || "DEF").toUpperCase();
        const stat = raw === "ATK" ? "atk" : raw === "SPD" ? "spd" : "def";
        const label = stat === "atk" ? "攻" : stat === "spd" ? "速" : "守";
        df.debuffs.push({ stat: stat, cut: clamp(num(move.cut, 0.18), 0, 0.5), turns: Math.max(1, Math.round(num(move.turns, 2))) });
        return { t: "buff", m: name + " " + df.name + " の" + label + "が下がった" };
      }
      if (move.kind === "delay") {
        at.delayed.push({
          pow: num(move.pow, 2.4), turns: Math.max(1, Math.round(num(move.turns, 1))),
          elem: move.elem, name: move.name
        });
        return { t: "note", m: name + " 力を溜めている" };
      }
      if (move.kind === "swap") {
        const a = df.atk; df.atk = df.def; df.def = a;
        return { t: "buff", m: name + " " + df.name + " の攻と守が入れ替わった" };
      }
      if (move.kind === "counter") {
        at.guard = true;
        return { t: "note", m: name + " 構えて相手の出方を待つ" };
      }

      // ── 攻撃する技 ──
      // 回避。必中（sure）は絶対に外さない。守り（counter）の相手には当たりにくい
      if (move.kind !== "sure") {
        let ev = 0.035 + (eff(df, "spd") - eff(at, "spd")) * 0.0050 - at.tec * 0.0018;
        if (df.trait === "serene") ev += 0.05;
        if (df.trait === "swift") ev += 0.03;
        if (df.guard) ev += 0.35;
        ev = clamp(ev, 0.01, 0.75);
        if (rnd() < ev) {
          df.dodges++;
          if (df.guard) {
            // counter: かわせたら反撃
            df.guard = false;
            const cm = { elem: df.elem, element: ELEMENTS[df.elem], kind: "strike", name: "反撃", pow: 1.0 };
            const r = strike(df, at, cm, foeAura, myAura);
            return { t: "crit", m: df.name + " がかわして反撃 → " + r.dmg };
          }
          return { t: "miss", m: df.name + " が回避" };
        }
      }
      df.guard = false;

      // multi（連撃）は回数が乱数。gamble は威力そのものが乱数
      let times = 1, powMul = 1;
      if (move.kind === "multi") {
        const lo = Math.max(1, Math.round(num(move.min, 2))), hi = Math.max(lo, Math.round(num(move.max, 3)));
        times = lo + Math.floor(rnd() * (hi - lo + 1));
      } else if (move.kind === "gamble") {
        powMul = rnd() * num(move.maxMult, 2.4);
      }

      let total = 0, crit = false, aff = 1, reflected = 0;
      at.reflectedBy = 0;
      for (let i = 0; i < times && df.hp > 0; i++) {
        const r = strike(at, df, move, myAura, foeAura, powMul);
        total += r.dmg; crit = crit || r.crit; aff = r.aff;
      }
      reflected = at.reflectedBy || 0;

      // stack（使うたび攻が積み上がる）
      if (move.kind === "stack") {
        const cap = Math.max(1, Math.round(num(move.cap, 4)));
        if (at.stackUses == null) at.stackUses = 0;
        if (at.stackUses < cap) { at.stack += num(move.add, 6); at.stackUses++; }
      }
      // first（次のターン必ず先手）
      if (move.kind === "first") at.goFirst = true;

      const tag =
        (crit ? " 会心" : "") +
        (aff >= 1.08 ? " 有利" : (aff <= 0.92 ? " 不利" : "")) +
        (move.kind === "drain" ? " 吸収" : "") +
        (move.kind === "sure" ? " 必中" : "") +
        (times > 1 ? " " + times + " 連撃" : "") +
        (move.kind === "gamble" ? (powMul >= 1.6 ? " 大当たり" : powMul <= 0.4 ? " 空振り気味" : "") : "") +
        (move.kind === "stack" ? " 積み上げ" : "") +
        (move.kind === "first" ? " 次は先手" : "") +
        (reflected ? " ／ " + Math.round(reflected) + " 反射された" : "");

      return {
        t: move.kind === "finisher" ? "finisher" : (crit ? "crit" : "hit"),
        m: name + (move.kind === "finisher" ? "！！" : "") + " → " + total + tag
      };
    }

    let round = 0;
    const MAXR = 40;
    while (round < MAXR && iA < 3 && iB < 3) {
      round++;
      const A = LA[iA], B = LB[iB];
      // first（次のターン必ず先手）は素の速さより優先する
      let sa = eff(A, "spd") + (A.trait === "swift" ? A.spd * 0.16 : 0) + (round === 1 ? auA.firstStrike * 25 : 0) + (A.goFirst ? 9999 : 0);
      let sb = eff(B, "spd") + (B.trait === "swift" ? B.spd * 0.16 : 0) + (round === 1 ? auB.firstStrike * 25 : 0) + (B.goFirst ? 9999 : 0);
      const first = (sa > sb) ? "A" : (sb > sa) ? "B" : (foldA >= foldB ? "A" : "B");
      A.goFirst = false; B.goFirst = false;
      const seq = first === "A" ? ["A", "B"] : ["B", "A"];

      for (let q = 0; q < 2; q++) {
        const atkSide = seq[q];
        const at = atkSide === "A" ? LA[iA] : LB[iB];
        const df = atkSide === "A" ? LB[iB] : LA[iA];
        if (!at || !df || at.hp <= 0 || df.hp <= 0) continue;
        const myAura = atkSide === "A" ? auA : auB;
        const foeAura = atkSide === "A" ? auB : auA;
        let times = 1;
        if (at.trait === "twin" && rnd() < 0.22) { times = 2; at.extra++; }
        for (let t = 0; t < times && df.hp > 0 && at.hp > 0; t++) {
          const r = act(at, df, myAura, foeAura);
          push({ t: r.t, s: atkSide, r: round, m: r.m + (t > 0 ? "（連撃）" : "") });
        }
        // 反射で攻め手が倒れることがある
        if (at.hp <= 0) {
          push({ t: "buff", s: atkSide, r: round, m: at.name + " 倒れる" });
          if (atkSide === "A") iA++; else iB++;
        }
        if (df.hp <= 0) {
          const dfSide = atkSide === "A" ? "B" : "A";
          push({ t: "buff", s: dfSide, r: round, m: df.name + " 倒れる" });
          if (dfSide === "A") iA++; else iB++;
        }
      }

      // ターン終わりの処理。順序は fold で固定＝A/B を入れ替えても同じ結果になる。
      //   隊オーラ（呪詛/蝕毒/再生）＋ 技の継続効果（毒・盾・弱体・溜め・自己回復）
      (foldA >= foldB ? ["A", "B"] : ["B", "A"]).forEach(function (side) {
        const isA = side === "A";
        const au = isA ? auA : auB;
        const meF = isA ? LA[iA] : LB[iB];
        const foeF = isA ? LB[iB] : LA[iA];
        const fell = function (f) {   // 倒れた側の繰り上がり
          if (f === (isA ? LA[iA] : LB[iB])) { if (isA) iA++; else iB++; }
          else { if (isA) iB++; else iA++; }
        };

        if (meF && meF.hp > 0) {
          // 隊オーラの再生
          if (au.regen > 0 && meF.hp < meF.maxHp) {
            const h = Math.round(meF.maxHp * Math.min(0.04, au.regen));
            meF.hp = Math.min(meF.maxHp, meF.hp + h);
            push({ t: "buff", s: side, r: round, m: meF.name + " +" + h + " 回復" });
          }
          // regen（自分で張った毎ターン回復）
          if (meF.regenRate > 0 && meF.hp < meF.maxHp) {
            const h = Math.max(1, Math.round(meF.maxHp * meF.regenRate));
            meF.hp = Math.min(meF.maxHp, meF.hp + h);
            push({ t: "buff", s: side, r: round, m: meF.name + " +" + h + " 回復（継続）" });
          }
          // dot（毎ターン最大 HP の N%）
          for (let i = meF.dots.length - 1; i >= 0; i--) {
            const d = meF.dots[i];
            const x = Math.max(1, Math.round(meF.maxHp * d.rate));
            meF.hp -= x;
            push({ t: "dot", s: isA ? "B" : "A", r: round, m: meF.name + " 継続ダメージ -" + x });
            if (--d.turns <= 0) meF.dots.splice(i, 1);
          }
          // 盾と弱体の残りターン
          if (meF.shieldT > 0 && --meF.shieldT <= 0) meF.shieldCut = 0;
          for (let i = meF.debuffs.length - 1; i >= 0; i--) if (--meF.debuffs[i].turns <= 0) meF.debuffs.splice(i, 1);
          // delay（溜めた一撃。発動前に倒れると不発）
          for (let i = meF.delayed.length - 1; i >= 0; i--) {
            const d = meF.delayed[i];
            if (--d.turns > 0) continue;
            meF.delayed.splice(i, 1);
            const target = isA ? LB[iB] : LA[iA];
            if (target && target.hp > 0 && meF.hp > 0) {
              const dm = { elem: d.elem, element: ELEMENTS[d.elem], kind: "strike", name: d.name, pow: d.pow };
              const r = strike(meF, target, dm, au, isA ? auB : auA);
              push({ t: "finisher", s: side, r: round, m: meF.name + " の溜めていた「" + d.name + "」が炸裂 → " + r.dmg });
              if (target.hp <= 0) { push({ t: "buff", s: isA ? "B" : "A", r: round, m: target.name + " 倒れる" }); if (isA) iB++; else iA++; }
            }
          }
          if (meF.hp <= 0) { push({ t: "buff", s: side, r: round, m: meF.name + " 倒れる" }); if (isA) iA++; else iB++; }
        }

        if (foeF && foeF.hp > 0) {
          if (au.curseTick > 0) foeF.defDrop = Math.min(0.4, foeF.defDrop + au.curseTick);
          if (au.venomTick > 0) {
            const d = Math.max(1, Math.round(foeF.maxHp * Math.min(0.022, au.venomTick)));
            foeF.hp -= d;
            push({ t: "dot", s: side, r: round, m: foeF.name + " 蝕毒 -" + d });
            if (foeF.hp <= 0) { push({ t: "buff", s: isA ? "B" : "A", r: round, m: foeF.name + " 倒れる" }); if (isA) iB++; else iA++; }
          }
        }
      });
    }

    const aliveA = LA.reduce(function (n, f) { return n + (f.hp > 0 ? 1 : 0); }, 0);
    const aliveB = LB.reduce(function (n, f) { return n + (f.hp > 0 ? 1 : 0); }, 0);
    const hpFracA = LA.reduce(function (s, f) { return s + Math.max(0, f.hp) / f.maxHp; }, 0);
    const hpFracB = LB.reduce(function (s, f) { return s + Math.max(0, f.hp) / f.maxHp; }, 0);
    let winnerSide;
    if (aliveA !== aliveB) winnerSide = aliveA > aliveB ? "A" : "B";
    else if (Math.abs(hpFracA - hpFracB) > 1e-6) winnerSide = hpFracA > hpFracB ? "A" : "B";
    else winnerSide = foldA >= foldB ? "A" : "B";

    const decision = (aliveA === 0 || aliveB === 0) ? "殲滅" : "判定";
    return {
      log: log, turns: round, decision: decision, winnerSide: winnerSide,
      aliveA: aliveA, aliveB: aliveB,
      dealtA: LA.reduce(function (s, f) { return s + f.dealt; }, 0),
      dealtB: LB.reduce(function (s, f) { return s + f.dealt; }, 0),
      critsA: LA.reduce(function (s, f) { return s + f.crits; }, 0),
      critsB: LB.reduce(function (s, f) { return s + f.crits; }, 0),
      synergiesA: auA.synergies, synergiesB: auB.synergies,
      lineA: LA.map(function (f) { return { name: f.name, hp: Math.max(0, Math.round(f.hp)), maxHp: f.maxHp }; }),
      lineB: LB.map(function (f) { return { name: f.name, hp: Math.max(0, Math.round(f.hp)), maxHp: f.maxHp }; })
    };
  }

  /** スカッドの2本先取マッチ */
  function squadMatch(sqA, sqB, salt) {
    salt = (salt >>> 0) || 0;
    const games = [];
    let wa = 0, wb = 0;
    for (let k = 0; k < 3; k++) {
      const gs = (Math.imul(salt + 0x9E3779B9, 0x27D4EB2F) ^ Math.imul(k + 1, 0x85EBCA6B)) >>> 0;
      const desp = wa > wb ? "B" : (wb > wa ? "A" : null);
      const g = squadBattle(sqA, sqB, gs, desp);
      games.push(g);
      if (g.winnerSide === "A") wa++; else wb++;
      if (wa === 2 || wb === 2) break;
    }
    const winnerSide = (wa > wb) ? "A" : "B";
    return { games: games, count: games.length, scoreA: wa, scoreB: wb, winnerSide: winnerSide };
  }

  return {
    normalize: normalize, beastOf: beastOf, battle: battle, match: match,
    squadBattle: squadBattle, squadMatch: squadMatch, familyTag: familyTag, squadAura: squadAura,
    ELEMENTS: ELEMENTS, TRAITS: TRAITS, TEMPERS: TEMPERS, SYNERGY_DEFS: SYNERGY_DEFS,
    MOVE_KINDS: MOVE_KINDS, MOVE_KIND_NAME: MOVE_KIND_NAME, MOVE_KIND_DESC: MOVE_KIND_DESC,
    STAT_KEYS: STAT_KEYS, rankOf: rankOf, affinity: affinity
  };
})();
