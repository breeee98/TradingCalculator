/*!
 * TradingCalculator core — 点位阶梯计算器的纯函数核心
 *
 * 网页（index.html）、只读 JSON 接口（api/worker.js）、命令行（cli/analyze.js）
 * 和自动化测试（tests/）全部调用这一份代码，保证同一套算法。
 *
 * 约定：
 *  - 所有函数都是纯函数：不读写 DOM、不访问网络、不读 localStorage，不修改入参。
 *  - 缺失数据一律用 null 表示，绝不转换成 0 参与计算。
 *  - 不下单、不连接券商。只输出参考数字和理由。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LadderCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "2.0.0";
  var SCHEMA = "tradingcalculator.analysis.v1";

  // ---------------------------------------------------------------- 常量
  var DEFAULT_COEFFS = { kA1: 0.5, kOuter: 0.3, kInner: 0.12, kTrial: 0.08, kE1: 0.3, kE2: 0.6 };
  var DEFAULT_ALLOC = { A1: 20, A2: 35, B1: 15, B2: 5, C1: 10, C2: 5, D1: 5, D2: 10, D3: 15, E1: 40, E2: 20 };
  var DEFAULT_OPTIONS = {
    sellBasis: "initial",   // "initial" = 各档比例以计划开始时的持仓为基数；"remaining" = 以触发当时的剩余持仓为基数
    maxSellPct: 100,        // 卖出累计上限（占计划基数），长期账户可留核心仓
    cashReservePct: 10,     // 买入侧保留现金（占计划资金），累计买入不超过 100 - 该值
    staleMinutes: 15        // 最新价格超过该分钟数标记 ⚠
  };

  // 由低到高
  var LEVEL_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2", "D1", "D2", "D3", "E1", "E2"];
  var SELL_TIERS = ["D1", "D2", "D3", "E1", "E2"];          // 价格由低到高依次触发
  var BUY_TIERS = ["C2", "C1", "B2", "B1", "A2", "A1"];     // 价格由高到低依次触发
  var LEVEL_META = {
    A1: { zone: "A", label: "强买", side: "buy" },
    A2: { zone: "A", label: "强买", side: "buy" },
    B1: { zone: "B", label: "买入", side: "buy" },
    B2: { zone: "B", label: "买入", side: "buy" },
    C1: { zone: "C", label: "试仓", side: "buy" },
    C2: { zone: "C", label: "试仓", side: "buy" },
    D1: { zone: "D", label: "卖出", side: "sell" },
    D2: { zone: "D", label: "卖出", side: "sell" },
    D3: { zone: "D", label: "卖出", side: "sell" },
    E1: { zone: "E", label: "强卖", side: "sell" },
    E2: { zone: "E", label: "强卖", side: "sell" }
  };
  var TICKER_RE = /^[A-Z0-9^][A-Z0-9.\/=:^_-]{0,31}$/;

  // ---------------------------------------------------------------- 小工具
  function parseNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return null;
    if (typeof v === "string") {
      var s = v.replace(/,/g, "").trim();
      if (!s) return null;
      v = s;
    }
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function round(v, d) {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    var f = Math.pow(10, d === undefined ? 2 : d);
    return Math.round(v * f) / f;
  }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      Object.keys(src).forEach(function (k) { if (src[k] !== undefined) target[k] = src[k]; });
    }
    return target;
  }
  function normTicker(t) { return typeof t === "string" ? t.trim().toUpperCase() : ""; }
  function isValidTicker(t) { return TICKER_RE.test(normTicker(t)); }
  function floorStep(x, step) {
    if (!(step > 0)) return x;
    // 加一个极小量，避免 2.9999999 这类浮点误差被向下取整
    return Math.floor(x / step + 1e-9) * step;
  }
  function stepDecimals(step) {
    var s = String(step);
    return s.indexOf(".") >= 0 ? s.split(".")[1].length : 0;
  }
  function parseTime(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number" && Number.isFinite(v)) {
      var ms = v < 1e12 ? v * 1000 : v; // unix 秒或毫秒
      var d0 = new Date(ms);
      return isNaN(d0.getTime()) ? null : d0;
    }
    if (typeof v === "string") {
      var s = v.trim();
      if (/^\d{9,13}$/.test(s)) return parseTime(Number(s));
      // "YYYY-MM-DD" 当作 UTC 日期（日线 bar 日期）
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00Z";
      var d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    return null;
  }
  function ymd(d) { return d ? d.toISOString().slice(0, 10) : null; }
  function daysBetween(fromDate, toDate) {
    var a = Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate());
    var b = Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate());
    return Math.round((b - a) / 86400000);
  }
  function msg(code, message, field, extra) {
    var m = { code: code, message: message };
    if (field) m.field = field;
    if (extra) assign(m, extra);
    return m;
  }

  // ---------------------------------------------------------------- 1. 输入规范化
  var NUM_FIELDS = ["price", "bbU", "bbM", "bbL", "ema20", "ema50", "ema200", "vol", "avgVol", "pcr", "ivr"];
  var FIELD_LABEL = {
    price: "现价", bbU: "布林带上轨", bbM: "布林带中轨", bbL: "布林带下轨",
    ema20: "EMA20", ema50: "EMA50", ema200: "EMA200", vol: "当日成交量", avgVol: "20日均量",
    pcr: "Put/Call 比", ivr: "IV Rank"
  };

  /**
   * 把任意来源（网页表单字符串、接口 JSON、测试对象）的输入规范成统一结构。
   * 空字符串 / 非数字 → null（缺失），不会变成 0。
   */
  function normalizeInput(raw) {
    raw = raw || {};
    var out = { ticker: normTicker(raw.ticker) };
    NUM_FIELDS.forEach(function (f) { out[f] = parseNum(raw[f]); });
    var c = raw.coeffs || {};
    out.coeffs = {};
    Object.keys(DEFAULT_COEFFS).forEach(function (k) {
      var v = parseNum(c[k] !== undefined ? c[k] : raw[k]);
      out.coeffs[k] = v === null ? DEFAULT_COEFFS[k] : v;
    });
    var a = raw.alloc || {};
    out.alloc = {};
    LEVEL_ORDER.forEach(function (k) {
      var v = parseNum(a[k] !== undefined ? a[k] : raw["p" + k]);
      out.alloc[k] = v === null ? DEFAULT_ALLOC[k] : v;
    });
    var o = raw.options || {};
    out.options = {
      sellBasis: o.sellBasis === "remaining" ? "remaining" : "initial",
      maxSellPct: parseNum(o.maxSellPct) === null ? DEFAULT_OPTIONS.maxSellPct : parseNum(o.maxSellPct),
      cashReservePct: parseNum(o.cashReservePct) === null ? DEFAULT_OPTIONS.cashReservePct : parseNum(o.cashReservePct),
      staleMinutes: parseNum(o.staleMinutes) === null ? DEFAULT_OPTIONS.staleMinutes : parseNum(o.staleMinutes)
    };
    out.provenance = normalizeProvenance(raw.provenance, out.ticker);
    return out;
  }

  function normalizeProvenance(p, ticker) {
    p = p || {};
    var m = p.market || {};
    var op = p.options || {};
    return {
      market: {
        kind: m.kind || "unknown",                 // api | manual | demo | unknown
        ticker: normTicker(m.ticker || ""),
        source: m.source || null,
        fetchedAt: m.fetchedAt || null,
        priceTime: m.priceTime || null,          // 最新价格自身的时间戳（行情服务提供时）
        barDate: m.barDate || null,              // 日线指标所用最后一根 K 线日期
        partialBar: m.partialBar === true,       // 最后一根日线确定盘中未完结（行情服务明确告知）
        maybePartialBar: m.maybePartialBar === true, // 在交易时段内获取、但服务没说明（只提示，不改变评分）
        manualFields: Array.isArray(m.manualFields) ? m.manualFields.slice() : []
      },
      options: {
        kind: op.kind || "unknown",
        ticker: normTicker(op.ticker || ""),
        source: op.source || null,
        time: op.time || null
      }
    };
  }

  // ---------------------------------------------------------------- 2. 验证
  /**
   * 返回 { errors:[], warnings:[], fieldStatus:{field:"ok"|"missing"|"invalid"|"stale"} }
   * errors 存在时，阶梯价格不可用于决策。
   */
  function validateInput(inp, now) {
    var errors = [], warnings = [], status = {};
    NUM_FIELDS.forEach(function (f) { status[f] = inp[f] === null ? "missing" : "ok"; });
    function bad(f, code, text) { status[f] = "invalid"; errors.push(msg(code, text, f)); }

    if (!inp.ticker) warnings.push(msg("TICKER_MISSING", "未填写股票代码。", "ticker"));
    else if (!isValidTicker(inp.ticker) && inp.ticker !== "示例") warnings.push(msg("TICKER_FORMAT", "股票代码格式看起来不对：" + inp.ticker, "ticker"));

    if (inp.price === null) errors.push(msg("REQUIRED", "现价缺失。", "price"));
    else if (inp.price <= 0) bad("price", "NON_POSITIVE", "现价必须大于 0。");

    ["bbU", "bbM", "bbL"].forEach(function (f) {
      if (inp[f] === null) errors.push(msg("REQUIRED", FIELD_LABEL[f] + "缺失。", f));
      else if (inp[f] <= 0) bad(f, "NON_POSITIVE", FIELD_LABEL[f] + "必须大于 0。");
    });
    if (inp.bbU !== null && inp.bbL !== null && inp.bbU > 0 && inp.bbL > 0) {
      if (inp.bbU <= inp.bbL) { bad("bbU", "BB_ORDER", "布林带上轨必须大于下轨。"); status.bbL = "invalid"; }
      else if (inp.bbM !== null && !(inp.bbL <= inp.bbM && inp.bbM <= inp.bbU)) bad("bbM", "BB_ORDER", "布林带中轨必须落在上轨和下轨之间。");
    }

    ["ema20", "ema50", "ema200"].forEach(function (f) {
      if (inp[f] === null) warnings.push(msg("MISSING", FIELD_LABEL[f] + "缺失，趋势修正按“未知”处理（不修正点位）。", f));
      else if (inp[f] <= 0) bad(f, "NON_POSITIVE", FIELD_LABEL[f] + "必须大于 0。");
    });

    if (inp.vol !== null && inp.vol < 0) bad("vol", "NEGATIVE", "成交量不能为负。");
    if (inp.avgVol !== null && inp.avgVol < 0) bad("avgVol", "NEGATIVE", "20日均量不能为负。");
    if (inp.avgVol === 0) { status.avgVol = "invalid"; warnings.push(msg("ZERO", "20日均量为 0，量能评分跳过。", "avgVol")); }
    if (inp.vol === null || inp.avgVol === null) warnings.push(msg("MISSING", "成交量数据缺失，量能评分跳过（记为未知，不是中性 0）。", inp.vol === null ? "vol" : "avgVol"));

    if (inp.pcr === null) warnings.push(msg("MISSING", "Put/Call 比缺失，期权情绪按未知处理。", "pcr"));
    else if (inp.pcr <= 0) bad("pcr", "NON_POSITIVE", "Put/Call 比必须大于 0。");
    else if (inp.pcr > 5) warnings.push(msg("UNUSUAL", "Put/Call 比 " + inp.pcr + " 异常偏高，请确认没有填错（常见范围 0.3–2）。", "pcr"));
    if (inp.ivr === null) warnings.push(msg("MISSING", "IV Rank 缺失，事件风险按未知处理。", "ivr"));
    else if (inp.ivr < 0 || inp.ivr > 100) bad("ivr", "RANGE", "IV Rank 必须在 0–100 之间。");

    // 系数与比例
    Object.keys(inp.coeffs).forEach(function (k) {
      if (!(inp.coeffs[k] >= 0)) errors.push(msg("COEFF", "系数 " + k + " 必须 ≥ 0。", k));
    });
    if (inp.coeffs.kE1 >= inp.coeffs.kE2) errors.push(msg("COEFF_ORDER", "E1 越过上轨幅度必须小于 E2。", "kE1"));
    if (inp.coeffs.kTrial >= inp.coeffs.kInner) errors.push(msg("COEFF_ORDER", "C1/C2 半宽必须小于 B2/D2 偏移，否则 C 档会越过 B2/D2。", "kTrial"));
    if (inp.coeffs.kInner >= inp.coeffs.kOuter) errors.push(msg("COEFF_ORDER", "B2/D2 偏移必须小于 B1/D1 偏移，否则 B1/B2、D1/D2 顺序颠倒。", "kInner"));
    LEVEL_ORDER.forEach(function (k) {
      var v = inp.alloc[k];
      if (!(v >= 0 && v <= 100)) errors.push(msg("ALLOC_RANGE", k + " 比例必须在 0–100% 之间。", "p" + k));
    });
    var o = inp.options;
    if (!(o.maxSellPct >= 0 && o.maxSellPct <= 100)) errors.push(msg("OPTION_RANGE", "卖出累计上限必须在 0–100% 之间。", "maxSellPct"));
    if (!(o.cashReservePct >= 0 && o.cashReservePct < 100)) errors.push(msg("OPTION_RANGE", "保留现金比例必须在 0–99% 之间。", "cashReservePct"));

    // 跨字段合理性：价格离布林带太远，多半是不同股票/不同时间的数据
    if (!errors.length && inp.price > 0 && inp.bbU > inp.bbL) {
      var bw = inp.bbU - inp.bbL;
      if (inp.price > inp.bbU + 3 * bw || inp.price < inp.bbL - 3 * bw) {
        warnings.push(msg("PRICE_FAR_FROM_BANDS", "现价离布林带超过 3 个带宽，可能是数据不同步（不同股票或不同日期）。", "price"));
      }
      ["ema20", "ema50"].forEach(function (f) {
        if (inp[f] > 0 && Math.abs(inp[f] / inp.price - 1) > 0.5) {
          warnings.push(msg("EMA_FAR_FROM_PRICE", FIELD_LABEL[f] + " 与现价相差超过 50%，请确认数据来自同一只股票。", f));
        }
      });
    }

    // 数据来源与股票是否一致
    var pv = inp.provenance;
    if (inp.ticker && pv.market.ticker && pv.market.ticker !== inp.ticker) {
      errors.push(msg("MARKET_TICKER_MISMATCH", "价格/布林带/EMA 数据属于 " + pv.market.ticker + "，与当前代码 " + inp.ticker + " 不一致。", "ticker"));
    }
    if (pv.market.kind === "demo") warnings.push(msg("DEMO_DATA", "当前是演示数据，不是真实行情。", "price"));
    if (inp.ticker && pv.options.ticker && pv.options.ticker !== inp.ticker && (inp.pcr !== null || inp.ivr !== null)) {
      errors.push(msg("OPTIONS_TICKER_MISMATCH", "期权数据属于 " + pv.options.ticker + "，不能用于 " + inp.ticker + "。", "pcr"));
      if (inp.pcr !== null) status.pcr = "invalid";
      if (inp.ivr !== null) status.ivr = "invalid";
    }
    if (pv.market.partialBar) warnings.push(msg("PARTIAL_BAR", "最后一根日线盘中未完结：当日成交量不完整，量能评分已跳过。", "vol"));
    else if (pv.market.maybePartialBar) warnings.push(msg("MAYBE_PARTIAL_BAR", "在美股交易时段内获取：当日成交量可能还没走完，量比可能偏低。", "vol"));
    if ((inp.pcr !== null || inp.ivr !== null) && !pv.options.ticker && pv.options.kind !== "demo") {
      warnings.push(msg("OPTIONS_SOURCE_UNKNOWN", "期权数据没有记录所属股票和来源，请确认是 " + (inp.ticker || "当前股票") + " 的最新数据。", "pcr"));
    }

    // 时效
    var fresh = freshness(inp, now);
    if (fresh.price.stale) {
      var age = fresh.price.basis === "priceTime" ? fresh.price.ageMinutes : fresh.price.fetchedMinutesAgo;
      warnings.push(msg("STALE_PRICE", "⚠ 最新价格已超过 " + inp.options.staleMinutes + " 分钟（" + (fresh.price.basis === "priceTime" ? "行情时间 " : "获取于 ") + age + " 分钟前）。", "price"));
    }
    if (fresh.price.basis === "fetchedAt") warnings.push(msg("PRICE_TIME_UNKNOWN", "行情服务没有提供价格时间戳，只知道获取时间；真实延迟未知（可能是延迟报价或上一收盘价）。", "price"));
    if (pv.market.kind === "manual" && !pv.market.priceTime) warnings.push(msg("MANUAL_TIME_UNKNOWN", "价格为手动输入，没有结构化时间；请在“数据时间/来源”里注明。", "price"));
    if (fresh.indicators.stale) warnings.push(msg("STALE_BARS", "⚠ 日线指标停留在 " + pv.market.barDate + "，距今 " + fresh.indicators.ageDays + " 天。", "bbM"));
    return { errors: errors, warnings: warnings, fieldStatus: status, freshness: fresh };
  }

  function freshness(inp, now) {
    now = now ? parseTime(now) : new Date();
    var pv = inp.provenance.market;
    var res = {
      price: { time: null, basis: null, ageMinutes: null, stale: false, fetchedAt: pv.fetchedAt || null, fetchedMinutesAgo: null },
      indicators: { barDate: pv.barDate || null, ageDays: null, stale: false }
    };
    var ft = parseTime(pv.fetchedAt);
    if (ft) res.price.fetchedMinutesAgo = Math.max(0, Math.round((now - ft) / 60000));
    var pt = parseTime(pv.priceTime);
    if (pt) {
      res.price.time = pt.toISOString();
      res.price.basis = "priceTime";
      res.price.ageMinutes = Math.max(0, Math.round((now - pt) / 60000));
      res.price.stale = res.price.ageMinutes > inp.options.staleMinutes;
    } else if (ft && pv.kind === "api") {
      // 只有“获取时间”：真实行情时间至少这么旧，可能更旧
      res.price.basis = "fetchedAt";
      res.price.stale = res.price.fetchedMinutesAgo > inp.options.staleMinutes;
    }
    var bd = parseTime(pv.barDate);
    if (bd) {
      res.indicators.ageDays = daysBetween(bd, now);
      // 周末 + 假期最多空 4 天；超过视为陈旧
      res.indicators.stale = res.indicators.ageDays > 4;
    }
    return res;
  }

  // ---------------------------------------------------------------- 3. 点位
  /**
   * 计算 A1–E2。算法保持原版：以布林带带宽 BW 为单位展开，
   * 多头/空头排列时向 EMA50 加权靠拢。新增：靠拢后若越过相邻档位，限制在相邻档位之间。
   */
  function computeLevels(inp) {
    var c = inp.coeffs;
    var bbU = inp.bbU, bbM = inp.bbM, bbL = inp.bbL;
    var BW = bbU - bbL;
    var lv = {
      A1: bbL - c.kA1 * BW,
      A2: bbL,
      B1: bbL + c.kOuter * BW,
      B2: bbM - c.kInner * BW,
      C1: bbM - c.kTrial * BW,
      C2: bbM + c.kTrial * BW,
      D1: bbU - c.kOuter * BW,
      D2: bbU - c.kInner * BW,
      D3: bbU,
      E1: bbU + c.kE1 * BW,
      E2: bbU + c.kE2 * BW
    };
    var baseOrder = orderViolations(lv);

    var e20 = inp.ema20, e50 = inp.ema50, e200 = inp.ema200;
    var emaKnown = e20 !== null && e50 !== null && e200 !== null && e20 > 0 && e50 > 0 && e200 > 0;
    var bias = 0, alignment = "unknown";
    if (emaKnown) {
      if (e20 > e50 && e50 > e200) { bias = 1; alignment = "bull"; }
      else if (e20 < e50 && e50 < e200) { bias = -1; alignment = "bear"; }
      else alignment = "mixed";
    }
    var blend = 0.35;
    var notes = [];
    var adjusted = [];
    if (!emaKnown) notes.push("EMA 数据不完整，不做趋势修正。");
    else if (bias === 0) notes.push("均线中性排列，不做点位修正。");
    if (bias === 1) {
      if (e50 > bbL && e50 < bbM) {
        lv.A2 = lv.A2 * (1 - blend) + e50 * blend;
        lv.B2 = lv.B2 * (1 - blend) + e50 * blend;
        adjusted.push("A2", "B2");
        notes.push("多头排列，A2/B2 已向 EMA50 加权靠拢。");
      } else notes.push("多头排列，但 EMA50 不在下轨~中轨之间，未做靠拢修正。");
      lv.E1 = bbU + c.kE1 * BW * 1.08;
      lv.E2 = bbU + c.kE2 * BW * 1.08;
    } else if (bias === -1) {
      if (e50 > bbM && e50 < bbU) {
        lv.D2 = lv.D2 * (1 - blend) + e50 * blend;
        lv.D3 = lv.D3 * (1 - blend) + e50 * blend;
        adjusted.push("D2", "D3");
        notes.push("空头排列，D2/D3 已向 EMA50 加权靠拢。");
      } else notes.push("空头排列，但 EMA50 不在中轨~上轨之间，未做靠拢修正。");
      lv.A1 = bbL - c.kA1 * BW * 1.08;
    }

    // 靠拢修正后的保序：只调整被修正过的档位
    var clamps = [];
    if (!baseOrder.length) {
      var eps = 0.01 * BW;
      adjusted.forEach(function (k) {
        var i = LEVEL_ORDER.indexOf(k);
        var lo = i > 0 ? lv[LEVEL_ORDER[i - 1]] : -Infinity;
        var hi = i < LEVEL_ORDER.length - 1 ? lv[LEVEL_ORDER[i + 1]] : Infinity;
        var v = lv[k], nv = v;
        if (lo + eps >= hi - eps) nv = (lo + hi) / 2;
        else if (v <= lo + eps) nv = lo + eps;
        else if (v >= hi - eps) nv = hi - eps;
        if (nv !== v) {
          clamps.push({ level: k, from: round(v, 4), to: round(nv, 4) });
          lv[k] = nv;
        }
      });
      if (clamps.length) notes.push("趋势靠拢后 " + clamps.map(function (x) { return x.level; }).join("/") + " 会越过相邻档位，已限制在相邻档位之间。");
    }
    return {
      lv: lv, BW: BW, bias: bias, alignment: alignment, trendNote: notes.join(" "),
      adjusted: adjusted, clamps: clamps, orderViolations: baseOrder.length ? baseOrder : orderViolations(lv)
    };
  }

  function orderViolations(lv) {
    var v = [];
    for (var i = 1; i < LEVEL_ORDER.length; i++) {
      var a = LEVEL_ORDER[i - 1], b = LEVEL_ORDER[i];
      if (!(lv[a] < lv[b])) v.push({ lower: a, upper: b, lowerPrice: round(lv[a], 4), upperPrice: round(lv[b], 4) });
    }
    return v;
  }

  // ---------------------------------------------------------------- 4. 评分
  function clampMult(score) {
    if (score <= -0.75) return 0.6;
    if (score >= 0.75) return 1.3;
    return 1.0;
  }

  /**
   * 量能 / 期权情绪评分。规则与原版相同；缺失项记为 missing，不参与计分，
   * 也不会被当成“比值 0”触发任何规则。
   */
  function scoreConviction(inp) {
    var comps = [];
    var buy = 0, sell = 0;
    var volRatio = null;
    var partial = inp.provenance && inp.provenance.market.partialBar;
    if (inp.vol === null || inp.avgVol === null || !(inp.avgVol > 0) || inp.vol < 0) {
      comps.push({ factor: "volume", status: "missing", value: null, buy: 0, sell: 0, reason: "成交量或20日均量缺失，跳过。" });
    } else if (partial) {
      volRatio = inp.vol / inp.avgVol;
      comps.push({ factor: "volume", status: "partial", value: round(volRatio, 3), buy: 0, sell: 0, reason: "当日K线盘中未完结，量比 " + round(volRatio, 2) + " 不可靠，跳过。" });
    } else {
      volRatio = inp.vol / inp.avgVol;
      var c = { factor: "volume", status: "ok", value: round(volRatio, 3), buy: 0, sell: 0 };
      if (volRatio >= 1.5) { c.buy = 1; c.sell = 1; c.reason = "量比 " + round(volRatio, 2) + " ≥ 1.5，放量，买卖两侧都加强。"; }
      else if (volRatio < 0.8) { c.buy = -1; c.sell = -1; c.reason = "量比 " + round(volRatio, 2) + " < 0.8，缩量，两侧都减弱。"; }
      else c.reason = "量比 " + round(volRatio, 2) + " 在 0.8–1.5 之间，中性。";
      buy += c.buy; sell += c.sell; comps.push(c);
    }
    if (inp.pcr === null) {
      comps.push({ factor: "putCall", status: "missing", value: null, buy: 0, sell: 0, reason: "Put/Call 比缺失，按未知处理（不是 0）。" });
    } else {
      var p = { factor: "putCall", status: "ok", value: inp.pcr, buy: 0, sell: 0 };
      if (inp.pcr >= 1.1) { p.buy = 1; p.sell = -1; p.reason = "Put/Call " + inp.pcr + " ≥ 1.1，恐慌性买 put，低位反向看多。"; }
      else if (inp.pcr <= 0.7) { p.buy = -1; p.sell = 1; p.reason = "Put/Call " + inp.pcr + " ≤ 0.7，追涨买 call，高位偏谨慎。"; }
      else p.reason = "Put/Call " + inp.pcr + " 在 0.7–1.1 之间，中性。";
      buy += p.buy; sell += p.sell; comps.push(p);
    }
    if (inp.ivr === null) {
      comps.push({ factor: "ivRank", status: "missing", value: null, buy: 0, sell: 0, reason: "IV Rank 缺失，按未知处理。" });
    } else {
      var v = { factor: "ivRank", status: "ok", value: inp.ivr, buy: 0, sell: 0 };
      if (inp.ivr >= 60) { v.buy = -0.5; v.sell = -0.5; v.reason = "IV Rank " + inp.ivr + " ≥ 60，事件风险偏高，两侧仓位略降。"; }
      else v.reason = "IV Rank " + inp.ivr + " < 60，无调整。";
      buy += v.buy; sell += v.sell; comps.push(v);
    }
    var known = comps.filter(function (x) { return x.status === "ok"; }).length;
    return {
      buyScore: buy, sellScore: sell,
      buyMult: clampMult(buy), sellMult: clampMult(sell),
      volRatio: volRatio === null ? null : round(volRatio, 4),
      components: comps,
      completeness: known + "/3",
      knownFactors: known
    };
  }

  // ---------------------------------------------------------------- 5. 比例分配（修复累计超 100%）
  /**
   * 卖出侧：按 D1→D2→D3→E1→E2（价格由低到高）依次累计。
   *   basis="initial"：每档比例 = 占计划开始时持仓（计划基数）的百分比；累计到上限后，后面的档位只拿剩余额度。
   *   basis="remaining"：每档比例 = 占触发当时剩余持仓的百分比；累计 = 1 − Π(1 − p)。
   * 买入侧：按 C2→C1→B2→B1→A2→A1（价格由高到低）依次累计，基数是计划资金，累计 ≤ 100 − 保留现金。
   * 返回的 effectivePct / cumPct 都是“占计划基数”的百分比，保证累计不超过上限。
   */
  function allocateTiers(alloc, mults, options) {
    options = assign({}, DEFAULT_OPTIONS, options || {});
    var sellCap = Math.max(0, Math.min(100, options.maxSellPct));
    var buyCap = Math.max(0, Math.min(100, 100 - options.cashReservePct));
    var rows = {};

    var cum = 0;
    SELL_TIERS.forEach(function (k) {
      var requested = Math.min(100, Math.max(0, alloc[k] * mults.sellMult));
      var remainingBefore = 100 - cum;
      // initial：本档占计划基数 requested%；remaining：本档占当时剩余持仓 requested%
      var uncappedCum = options.sellBasis === "remaining" ? cum + remainingBefore * requested / 100 : cum + requested;
      var newCum = Math.max(cum, Math.min(sellCap, uncappedCum));
      var eff = newCum - cum;
      rows[k] = {
        tier: k, side: "sell", basis: options.sellBasis === "remaining" ? "remaining" : "initial",
        basePct: alloc[k], multiplier: mults.sellMult, requestedPct: round(requested, 2),
        effectivePct: round(eff, 2), cumPct: round(newCum, 2),
        ofRemainingPct: remainingBefore > 1e-9 ? round(eff / remainingBefore * 100, 2) : 0,
        capped: uncappedCum > sellCap + 1e-9
      };
      cum = newCum;
    });

    cum = 0;
    BUY_TIERS.forEach(function (k) {
      var mult = LEVEL_META[k].zone === "C" ? 1 : mults.buyMult;
      var requested = Math.min(100, Math.max(0, alloc[k] * mult));
      var newCum = Math.min(buyCap, cum + requested);
      var eff = newCum - cum;
      rows[k] = {
        tier: k, side: "buy", basis: "budget",
        basePct: alloc[k], multiplier: mult, requestedPct: round(requested, 2),
        effectivePct: round(eff, 2), cumPct: round(newCum, 2),
        ofRemainingPct: null,
        capped: eff + 1e-9 < requested
      };
      cum = newCum;
    });
    return {
      rows: rows,
      sellTotalPct: rows.E2.cumPct, buyTotalPct: rows.A1.cumPct,
      sellCapPct: sellCap, buyCapPct: buyCap, sellBasis: options.sellBasis
    };
  }

  // ---------------------------------------------------------------- 6. 位置 / 候选条件
  function locateZone(price, lv) {
    if (price === null || !lv) return null;
    var asc = LEVEL_ORDER.map(function (k) { return { k: k, p: lv[k] }; });
    var nearest = asc.reduce(function (best, x) { return Math.abs(x.p - price) < Math.abs(best.p - price) ? x : best; }, asc[0]);
    var res = { price: price, nearest: nearest.k, nearestPrice: round(nearest.p, 4), lower: null, upper: null, zone: LEVEL_META[nearest.k].zone, position: "inside" };
    if (price > lv.E2) { res.position = "above"; res.lower = "E2"; res.zone = "E"; res.label = "高于 E2：阶梯上沿之外，不追高"; return res; }
    if (price < lv.A1) { res.position = "below"; res.upper = "A1"; res.zone = "A"; res.label = "低于 A1：阶梯下沿之外，保留现金应对超预期下跌"; return res; }
    for (var i = 0; i < asc.length - 1; i++) {
      if (price >= asc[i].p && price < asc[i + 1].p) { res.lower = asc[i].k; res.upper = asc[i + 1].k; break; }
    }
    if (res.lower === null && price === lv.E2) { res.lower = "E2"; }
    res.label = "位于 " + (res.lower || "—") + " 与 " + (res.upper || "—") + " 之间，最接近 " + res.nearest + "（" + res.zone + " 档）";
    return res;
  }

  function candidateConditions(inp, lev, conv) {
    var c = [];
    var lv = lev.lv, p = inp.price;
    SELL_TIERS.forEach(function (k) {
      if (p >= lv[k]) c.push({ id: "REACHED_" + k, side: "sell", label: "现价已到达 " + k + "（" + round(lv[k], 2) + "）", evidence: { price: p, level: round(lv[k], 4) } });
    });
    BUY_TIERS.forEach(function (k) {
      if (p <= lv[k]) c.push({ id: "REACHED_" + k, side: "buy", label: "现价已回落到 " + k + "（" + round(lv[k], 2) + "）", evidence: { price: p, level: round(lv[k], 4) } });
    });
    if (p > inp.bbU) c.push({ id: "ABOVE_UPPER_BAND", side: "info", label: "现价高于布林带上轨（单独出现不构成卖出理由）", evidence: { price: p, bbU: inp.bbU } });
    if (p < inp.bbL) c.push({ id: "BELOW_LOWER_BAND", side: "info", label: "现价低于布林带下轨", evidence: { price: p, bbL: inp.bbL } });
    conv.components.forEach(function (x) {
      if (x.status !== "ok") return;
      if (x.factor === "volume" && x.value >= 1.5) c.push({ id: "VOLUME_SPIKE", side: "confirm", label: "放量（量比 " + round(x.value, 2) + "）", evidence: { volRatio: x.value } });
      if (x.factor === "volume" && x.value < 0.8) c.push({ id: "VOLUME_DRY", side: "weaken", label: "缩量（量比 " + round(x.value, 2) + "）", evidence: { volRatio: x.value } });
      if (x.factor === "putCall" && x.value >= 1.1) c.push({ id: "PCR_FEAR", side: "buy", label: "Put/Call 偏高（恐慌）", evidence: { pcr: x.value } });
      if (x.factor === "putCall" && x.value <= 0.7) c.push({ id: "PCR_GREED", side: "sell", label: "Put/Call 偏低（追涨）", evidence: { pcr: x.value } });
      if (x.factor === "ivRank" && x.value >= 60) c.push({ id: "IV_ELEVATED", side: "risk", label: "IV Rank 偏高（事件风险）", evidence: { ivr: x.value } });
    });
    if (lev.alignment === "bull") c.push({ id: "TREND_BULL", side: "info", label: "EMA20 > EMA50 > EMA200 多头排列", evidence: { ema20: inp.ema20, ema50: inp.ema50, ema200: inp.ema200 } });
    if (lev.alignment === "bear") c.push({ id: "TREND_BEAR", side: "info", label: "EMA20 < EMA50 < EMA200 空头排列", evidence: { ema20: inp.ema20, ema50: inp.ema50, ema200: inp.ema200 } });
    return c;
  }

  function trendScore(inp, lev) {
    var basis = [];
    if (lev.alignment === "unknown") basis.push("EMA20/50/200 不完整，趋势未知。");
    else basis.push("EMA20 " + inp.ema20 + " / EMA50 " + inp.ema50 + " / EMA200 " + inp.ema200 + " → " +
      (lev.alignment === "bull" ? "多头排列" : lev.alignment === "bear" ? "空头排列" : "交错（中性）"));
    if (inp.ema50 > 0 && inp.price > 0) basis.push("现价" + (inp.price >= inp.ema50 ? "在" : "在") + " EMA50 " + (inp.price >= inp.ema50 ? "之上" : "之下") + "（" + round((inp.price / inp.ema50 - 1) * 100, 1) + "%）");
    if (inp.ema200 > 0 && inp.price > 0) basis.push("现价" + (inp.price >= inp.ema200 ? "在 EMA200 之上" : "在 EMA200 之下") + "（" + round((inp.price / inp.ema200 - 1) * 100, 1) + "%）");
    return {
      score: lev.alignment === "unknown" ? null : lev.bias,
      label: { bull: "多头", bear: "空头", mixed: "中性", unknown: "未知" }[lev.alignment],
      alignment: lev.alignment, basis: basis, note: lev.trendNote
    };
  }

  // ---------------------------------------------------------------- 7. 阶梯总装
  /**
   * 计算完整阶梯。返回 ok=false 时不要把价格当作决策依据（errors 里写明原因）。
   */
  function buildLadder(raw, ctx) {
    ctx = ctx || {};
    var inp = normalizeInput(raw);
    var val = validateInput(inp, ctx.now);
    var result = {
      ok: false, input: inp, errors: val.errors.slice(), warnings: val.warnings.slice(),
      fieldStatus: val.fieldStatus, freshness: val.freshness,
      levels: null, lv: null, rows: [], allocation: null, conviction: null, trend: null, zone: null, candidates: []
    };
    var core = ["price", "bbU", "bbM", "bbL"];
    var coreBroken = core.some(function (f) { return val.fieldStatus[f] !== "ok"; }) ||
      val.errors.some(function (e) { return /^COEFF/.test(e.code) || e.code === "ALLOC_RANGE" || e.code === "OPTION_RANGE"; });
    if (coreBroken) return result;

    var lev = computeLevels(inp);
    if (lev.orderViolations.length) {
      result.errors.push(msg("LADDER_ORDER", "档位顺序异常：" + lev.orderViolations.map(function (v) { return v.lower + " ≥ " + v.upper; }).join("，") + "。请检查布林带或系数。"));
      return result;
    }
    // 有期权数据串号时，不能让错误的期权数据参与评分
    var scoringInput = inp;
    if (val.fieldStatus.pcr === "invalid" || val.fieldStatus.ivr === "invalid") {
      scoringInput = assign({}, inp);
      if (val.fieldStatus.pcr === "invalid") scoringInput.pcr = null;
      if (val.fieldStatus.ivr === "invalid") scoringInput.ivr = null;
    }
    var conv = scoreConviction(scoringInput);
    var alloc = allocateTiers(inp.alloc, conv, inp.options);
    var rows = LEVEL_ORDER.slice().reverse().map(function (k) {
      var meta = LEVEL_META[k];
      var a = alloc.rows[k];
      return {
        key: k, zone: meta.zone, side: meta.side, label: meta.label,
        price: lev.lv[k], multiplier: a.multiplier,
        alloc: a
      };
    });
    result.levels = lev;
    result.lv = lev.lv;
    result.rows = rows;
    result.allocation = alloc;
    result.conviction = conv;
    result.trend = trendScore(inp, lev);
    result.zone = locateZone(inp.price, lev.lv);
    result.candidates = candidateConditions(scoringInput, lev, conv);
    // ok 只表示“阶梯可以计算”。数据串号等 error 仍会让 ok=false。
    result.ok = result.errors.length === 0;
    return result;
  }

  // ---------------------------------------------------------------- 8. 止盈分析（第二阶段）
  var DEFAULT_POSITION = {
    accountType: "swing", shares: null, avgCost: null, sales: [], events: [],
    exitPlan: { text: "", targets: [], keepCorePct: null }, planBaseShares: null, shareStep: null, eventWindowDays: 7
  };

  function normalizePosition(raw) {
    raw = raw || {};
    var p = {
      ticker: normTicker(raw.ticker),
      accountType: raw.accountType === "long" ? "long" : "swing",
      shares: parseNum(raw.shares),
      avgCost: parseNum(raw.avgCost),
      planBaseShares: parseNum(raw.planBaseShares),
      shareStep: parseNum(raw.shareStep),
      eventWindowDays: parseNum(raw.eventWindowDays) === null ? DEFAULT_POSITION.eventWindowDays : parseNum(raw.eventWindowDays),
      sales: (Array.isArray(raw.sales) ? raw.sales : []).map(function (s) {
        return {
          date: s && s.date ? String(s.date) : null,
          shares: parseNum(s && s.shares), price: parseNum(s && s.price),
          tier: s && s.tier && SELL_TIERS.indexOf(String(s.tier).toUpperCase()) >= 0 ? String(s.tier).toUpperCase() : null,
          costBasis: parseNum(s && s.costBasis),
          inPlan: !(s && s.inPlan === false)
        };
      }),
      events: (Array.isArray(raw.events) ? raw.events : []).map(function (e) {
        return { date: e && e.date ? String(e.date) : null, type: e && e.type === "earnings" ? "earnings" : "other", label: e && e.label ? String(e.label) : "" };
      }),
      exitPlan: {
        text: raw.exitPlan && raw.exitPlan.text ? String(raw.exitPlan.text) : "",
        targets: (raw.exitPlan && Array.isArray(raw.exitPlan.targets) ? raw.exitPlan.targets : []).map(function (t) {
          return typeof t === "object" && t !== null ? { price: parseNum(t.price), pct: parseNum(t.pct), note: t.note || "" } : { price: parseNum(t), pct: null, note: "" };
        }).filter(function (t) { return t.price !== null; }),
        keepCorePct: raw.exitPlan ? parseNum(raw.exitPlan.keepCorePct) : null
      }
    };
    if (raw.earningsDate) p.events.push({ date: String(raw.earningsDate), type: "earnings", label: "财报" });
    return p;
  }

  function validatePosition(pos, ladderTicker) {
    var errors = [], warnings = [];
    if (pos.ticker && ladderTicker && pos.ticker !== ladderTicker) errors.push(msg("POSITION_TICKER_MISMATCH", "持仓代码 " + pos.ticker + " 与行情代码 " + ladderTicker + " 不一致。", "ticker"));
    if (pos.shares === null) errors.push(msg("REQUIRED", "当前持仓股数缺失。", "shares"));
    else if (pos.shares < 0) errors.push(msg("NEGATIVE", "持仓股数不能为负。", "shares"));
    if (pos.avgCost === null) errors.push(msg("REQUIRED", "持仓平均成本缺失。", "avgCost"));
    else if (pos.avgCost <= 0) errors.push(msg("NON_POSITIVE", "平均成本必须大于 0。", "avgCost"));
    pos.sales.forEach(function (s, i) {
      if (s.shares === null || s.shares <= 0) errors.push(msg("SALE_SHARES", "第 " + (i + 1) + " 条卖出记录的股数无效。", "sales"));
      if (s.price === null || s.price <= 0) errors.push(msg("SALE_PRICE", "第 " + (i + 1) + " 条卖出记录的价格无效。", "sales"));
    });
    var k = pos.exitPlan.keepCorePct;
    if (k !== null && !(k >= 0 && k <= 100)) errors.push(msg("KEEP_CORE", "保留核心仓比例必须在 0–100% 之间。", "keepCorePct"));
    if (pos.planBaseShares !== null && pos.shares !== null) {
      var sold = pos.sales.filter(function (s) { return s.inPlan && s.shares > 0; }).reduce(function (a, s) { return a + s.shares; }, 0);
      if (pos.planBaseShares + 1e-9 < pos.shares + sold) warnings.push(msg("PLAN_BASE_SMALL", "计划基数小于“当前持仓 + 计划内已卖出”，已按后者计算。", "planBaseShares"));
    }
    pos.events.forEach(function (e, i) { if (!parseTime(e.date)) warnings.push(msg("EVENT_DATE", "第 " + (i + 1) + " 个事件日期无法识别：" + (e.date || "空"), "events")); });
    return { errors: errors, warnings: warnings };
  }

  /**
   * 根据 D1–E2 计算候选止盈。核心原则：价格到达某档只是“候选”，
   * 至少需要一个额外确认（量能/期权情绪、财报事件、空头趋势、原定退出价）才会给出“建议减仓”。
   */
  function analyzeTakeProfit(rawPosition, ladder, ctx) {
    ctx = ctx || {};
    var now = ctx.now ? parseTime(ctx.now) : new Date();
    var pos = normalizePosition(rawPosition);
    if (!pos.ticker && ladder && ladder.input) pos.ticker = ladder.input.ticker;
    var pv = validatePosition(pos, ladder && ladder.input ? ladder.input.ticker : null);
    var out = {
      ok: false, ticker: pos.ticker, accountType: pos.accountType,
      errors: pv.errors, warnings: pv.warnings, options: [], tiers: [], summary: null
    };
    if (!ladder || !ladder.ok) { out.errors.push(msg("LADDER_UNAVAILABLE", "阶梯数据不可用（见行情部分的错误），无法做止盈分析。")); return out; }
    if (ladder.input.provenance.market.kind === "demo") { out.errors.push(msg("DEMO_DATA", "演示数据不能用于真实持仓的止盈分析，请先获取或填写真实行情。")); return out; }
    if (pv.errors.length) return out;

    var inp = ladder.input, lv = ladder.lv, price = inp.price, conv = ladder.conviction;
    var step = pos.shareStep !== null && pos.shareStep > 0 ? pos.shareStep :
      (Math.abs(pos.shares - Math.round(pos.shares)) > 1e-9 ? 0.001 : 1);
    var dec = stepDecimals(step);
    var planSales = pos.sales.filter(function (s) { return s.inPlan; });
    var soldInPlan = planSales.reduce(function (a, s) { return a + s.shares; }, 0);
    var base = Math.max(pos.planBaseShares || 0, pos.shares + soldInPlan);
    var realizedFromRecords = pos.sales.reduce(function (a, s) {
      var cb = s.costBasis !== null ? s.costBasis : pos.avgCost;
      return a + (s.price - cb) * s.shares;
    }, 0);
    var keepCore = pos.exitPlan.keepCorePct !== null ? pos.exitPlan.keepCorePct : 0;
    var maxSell = Math.min(inp.options.maxSellPct, 100 - keepCore);
    var alloc = allocateTiers(inp.alloc, conv, { sellBasis: inp.options.sellBasis, maxSellPct: maxSell, cashReservePct: inp.options.cashReservePct });

    // 即将到来的事件
    var upcoming = pos.events.map(function (e) {
      var d = parseTime(e.date);
      return d ? assign({}, e, { daysAway: daysBetween(now, d) }) : null;
    }).filter(function (e) { return e && e.daysAway >= 0; }).sort(function (a, b) { return a.daysAway - b.daysAway; });
    var eventSoon = upcoming.filter(function (e) { return e.daysAway <= pos.eventWindowDays; });
    var earningsSoon = eventSoon.filter(function (e) { return e.type === "earnings"; });

    var inProfit = price > pos.avgCost;
    var sentimentKnown = conv.components.filter(function (x) { return x.factor !== "volume" && x.status === "ok"; }).length;
    var volComp = conv.components.filter(function (x) { return x.factor === "volume"; })[0];
    var volSpike = volComp && volComp.status === "ok" && volComp.value >= 1.5;
    var riskRefKey = pos.accountType === "long" ? "A2" : "C1";
    var riskRef = lv[riskRefKey];

    var allocatedShares = soldInPlan;   // 计划内已卖股数先抵扣低档位
    var remaining = pos.shares;
    var tiers = [];
    var planTargetHit = pos.exitPlan.targets.filter(function (t) { return price >= t.price; });

    SELL_TIERS.forEach(function (k) {
      var tierPrice = lv[k];
      var a = alloc.rows[k];
      var targetCum = Math.min(base, floorStep(base * a.cumPct / 100, step));
      var suggested = Math.max(0, targetCum - allocatedShares);
      suggested = Math.min(remaining, floorStep(suggested + 1e-9, step));
      suggested = round(suggested, dec);
      var alreadyCovered = targetCum <= soldInPlan + 1e-9;
      var reached = price >= tierPrice;

      var reasonsFor = [], reasonsAgainst = [], conf = 0;
      var decision, confidence = "中";
      if (!reached) {
        decision = "未触及";
      } else if (!inProfit) {
        decision = "无需操作";
        reasonsAgainst.push("现价 " + round(price, 2) + " 未高于成本 " + round(pos.avgCost, 2) + "，不属于止盈。");
      } else if (alreadyCovered || suggested <= 0) {
        decision = "已完成";
        reasonsFor.push("该档目标累计股数已由之前的卖出记录覆盖。");
      } else {
        reasonsFor.push("现价已到达 " + k + "（" + round(tierPrice, 2) + "）——这只是候选条件，本身不足以卖出。");
        if (conv.sellMult >= 1.2) { conf += 1; reasonsFor.push("量能/期权情绪确认卖出档（卖出乘数 " + conv.sellMult + "）。"); }
        if (conv.sellMult <= 0.8) { conf -= 1; reasonsAgainst.push("量能/期权情绪不支持卖出（卖出乘数 " + conv.sellMult + "）。"); }
        if (earningsSoon.length) {
          var w = pos.accountType === "swing" ? 1 : 0.5;
          conf += w; reasonsFor.push("财报在 " + earningsSoon[0].daysAway + " 天后（" + earningsSoon[0].date + "），" + (pos.accountType === "swing" ? "波段仓位财报前降低敞口。" : "长期仓位可小幅降低财报跳空风险。"));
        } else if (eventSoon.length) {
          conf += 0.5; reasonsFor.push("重要事件在 " + eventSoon[0].daysAway + " 天后：" + (eventSoon[0].label || eventSoon[0].date) + "。");
        }
        if (ladder.levels.alignment === "bull" && !volSpike) { conf -= 1; reasonsAgainst.push("多头排列中沿上轨上行很常见；没有放量确认时，触及档位不构成卖出理由。"); }
        if (ladder.levels.alignment === "bear") { conf += 1; reasonsFor.push("空头排列下反弹到卖出档，减仓理由更充分。"); }
        if (pos.accountType === "long" && LEVEL_META[k].zone === "D") { conf -= 1; reasonsAgainst.push("长期账户：D 档默认只作提醒，核心逻辑未变时可继续持有。"); }
        if (planTargetHit.length) { conf += 1; reasonsFor.push("已到达你原定的退出价 " + planTargetHit.map(function (t) { return round(t.price, 2); }).join(" / ") + "。"); }
        if (sentimentKnown === 0) { confidence = "低"; reasonsAgainst.push("期权数据缺失，无法确认情绪，置信度降低。"); }
        else if (sentimentKnown === 2 && volComp && volComp.status === "ok") confidence = "高";
        if (conf >= 1) decision = "建议减仓";
        else if (conf >= 0) decision = "可考虑减仓（等待确认）";
        else decision = "继续持有";
      }

      var proceeds = suggested * tierPrice;
      var tierProfit = suggested * (tierPrice - pos.avgCost);
      var remainingAfter = round(Math.max(0, remaining - suggested), dec);
      tiers.push({
        tier: k, zone: LEVEL_META[k].zone, price: round(tierPrice, 2), reached: reached,
        decision: decision, confidence: decision === "未触及" ? null : confidence, confirmationScore: decision === "未触及" ? null : conf,
        targetCumPct: a.cumPct, effectivePct: a.effectivePct, ofRemainingPct: a.ofRemainingPct,
        targetCumShares: round(targetCum, dec),
        suggestedShares: suggested,
        expectedProceeds: round(proceeds, 2),
        expectedRealizedProfit: round(tierProfit, 2),
        remainingSharesAfter: remainingAfter,
        isActionNow: decision === "建议减仓",
        reasonsFor: reasonsFor, reasonsAgainst: reasonsAgainst
      });
      allocatedShares = Math.max(allocatedShares, targetCum);
      remaining = remainingAfter;
    });

    // 汇总：只把“建议减仓”的档位算作现在执行
    var nowTiers = tiers.filter(function (t) { return t.decision === "建议减仓"; });
    var sellNow = round(nowTiers.reduce(function (a, t) { return a + t.suggestedShares; }, 0), dec);
    var proceedsNow = nowTiers.reduce(function (a, t) { return a + t.suggestedShares * price; }, 0);
    var profitNow = nowTiers.reduce(function (a, t) { return a + t.suggestedShares * (price - pos.avgCost); }, 0);
    var remainAfterNow = round(pos.shares - sellNow, dec);
    var reachedTiers = tiers.filter(function (t) { return t.reached; });
    var holdTiers = reachedTiers.filter(function (t) { return t.decision === "继续持有" || t.decision === "可考虑减仓（等待确认）"; });

    var rec;
    if (!inProfit) rec = "noAction";
    else if (nowTiers.length) rec = "trim";
    else if (holdTiers.length) rec = "hold";
    else rec = "noAction";

    var allReachedDone = reachedTiers.length > 0 && reachedTiers.every(function (t) { return t.decision === "已完成"; });
    var optionsList = [
      { id: "trim", label: "分批止盈", recommended: rec === "trim",
        detail: nowTiers.length ? ("按现价约卖出 " + sellNow + " 股（" + nowTiers.map(function (t) { return t.tier; }).join("+") + "），预计金额 $" + round(proceedsNow, 2) + "，本次已实现利润约 $" + round(profitNow, 2) + "。")
          : "目前没有同时满足“到达档位 + 额外确认”的档位。" },
      { id: "hold", label: "继续持有", recommended: rec === "hold",
        detail: holdTiers.length ? ("已到达 " + holdTiers.map(function (t) { return t.tier; }).join("/") + "，但确认不足或有继续持有的理由；可把这些档位设为提醒或限价单。")
          : nowTiers.length ? ("也可以放弃本次减仓继续持有，代价是承担回落到 " + riskRefKey + "（" + round(riskRef, 2) + "）的回吐风险。") : "保持现有计划。" },
      { id: "noAction", label: "无需操作", recommended: rec === "noAction",
        detail: !inProfit ? "现价未高于成本，止盈不适用。"
          : !reachedTiers.length ? "现价低于 D1（" + round(lv.D1, 2) + "），还没到任何止盈档位。"
          : allReachedDone ? "已到达的档位都已按计划执行完毕。"
          : "不调整任何仓位也是一个选项；已到达但未执行的部分会继续承担波动。" }
    ];

    var unrealizedNow = (price - pos.avgCost) * pos.shares;
    var remainRisk = {
      remainingShares: remainAfterNow,
      remainingCostBasis: round(remainAfterNow * pos.avgCost, 2),
      marketValueAtPrice: round(remainAfterNow * price, 2),
      unrealizedProfitAtPrice: round(remainAfterNow * (price - pos.avgCost), 2),
      referenceLevel: riskRefKey, referencePrice: round(riskRef, 2),
      drawdownToReference: round(remainAfterNow * Math.max(0, price - riskRef), 2),
      cushionToCostPct: round((price - pos.avgCost) / price * 100, 2),
      eventRisk: earningsSoon.length ? ("财报在 " + earningsSoon[0].daysAway + " 天后，可能跳空，跳空幅度不受阶梯约束。") : null,
      note: "若回落到 " + riskRefKey + "（" + round(riskRef, 2) + "），剩余持仓的回吐约 $" + round(remainAfterNow * Math.max(0, price - riskRef), 2) + "；跳空可能直接越过这个价位。"
    };

    out.ok = true;
    out.planBaseShares = round(base, dec);
    out.shareStep = step;
    out.sellBasis = alloc.sellBasis;
    out.maxSellPct = alloc.sellCapPct;
    out.soldInPlanShares = round(soldInPlan, dec);
    out.realizedFromRecords = round(realizedFromRecords, 2);
    out.realizedNote = "已实现利润按平均成本法计算（卖出价 − 平均成本），若券商使用 FIFO 或指定批次，数字会不同；可在记录里填 costBasis 覆盖。";
    out.unrealizedNow = round(unrealizedNow, 2);
    out.inProfit = inProfit;
    out.upcomingEvents = upcoming;
    out.exitPlan = pos.exitPlan;
    out.tiers = tiers;
    out.options = optionsList;
    out.recommendation = rec;
    out.summary = {
      sellNowShares: sellNow, proceedsNow: round(proceedsNow, 2), realizedProfitNow: round(profitNow, 2),
      remainingRisk: remainRisk
    };
    if (pos.exitPlan.text) out.warnings.push(msg("EXIT_PLAN_TEXT", "你写的原退出计划：“" + pos.exitPlan.text + "”——请对照上面的数字自行判断，工具不会自动解析文字计划。"));
    return out;
  }

  // ---------------------------------------------------------------- 9. 指标（从日线计算）
  function sma(values, n, end) {
    if (end + 1 < n) return null;
    var s = 0;
    for (var i = end - n + 1; i <= end; i++) { if (values[i] === null) return null; s += values[i]; }
    return s / n;
  }
  function emaSeries(values, n) {
    var out = new Array(values.length).fill(null);
    if (values.length < n) return out;
    var k = 2 / (n + 1);
    var seed = 0;
    for (var i = 0; i < n; i++) seed += values[i];
    var e = seed / n;
    out[n - 1] = e;
    for (var j = n; j < values.length; j++) { e = values[j] * k + e * (1 - k); out[j] = e; }
    return out;
  }
  /**
   * bars: [{date, open, high, low, close, volume}] 按日期升序。返回最后一根 K 线对应的指标。
   * BB(20, 2σ)：SMA20 ± 2 × 总体标准差；EMA 用前 N 根 SMA 作种子；
   * 20 日均量 = 当日之前 20 个交易日的平均（不含当日），当日量 / 均量 = 量比。
   */
  function indicatorsFromBars(bars, opts) {
    opts = opts || {};
    var warnings = [];
    var clean = (bars || []).filter(function (b) { return b && parseNum(b.close) !== null; });
    var closes = clean.map(function (b) { return parseNum(b.close); });
    var vols = clean.map(function (b) { return parseNum(b.volume); });
    var n = closes.length;
    if (n < 20) return { ok: false, warnings: [msg("TOO_FEW_BARS", "日线不足 20 根，无法计算布林带。")] };
    var end = n - 1;
    var mid = sma(closes, 20, end);
    var sq = 0;
    for (var i = end - 19; i <= end; i++) sq += Math.pow(closes[i] - mid, 2);
    var sd = Math.sqrt(sq / 20);
    var e20 = emaSeries(closes, 20)[end];
    var e50 = n >= 50 ? emaSeries(closes, 50)[end] : null;
    var e200 = n >= 200 ? emaSeries(closes, 200)[end] : null;
    if (e50 === null) warnings.push(msg("TOO_FEW_BARS", "日线不足 50 根，EMA50 缺失。"));
    if (e200 === null) warnings.push(msg("TOO_FEW_BARS", "日线不足 200 根，EMA200 缺失。"));
    var vol = vols[end];
    var avgVol = null;
    if (n >= 21) {
      var prev = vols.slice(end - 20, end);
      if (prev.every(function (v) { return v !== null; })) avgVol = prev.reduce(function (a, b) { return a + b; }, 0) / 20;
    }
    return {
      ok: true, barDate: clean[end].date || null,
      price: closes[end], bbU: mid + 2 * sd, bbM: mid, bbL: mid - 2 * sd,
      ema20: e20, ema50: e50, ema200: e200, vol: vol, avgVol: avgVol, barsUsed: n, warnings: warnings
    };
  }

  // ---------------------------------------------------------------- 10. 统一 JSON 报告（接口与网页“复制 JSON”共用）
  var LIMITATIONS = [
    "阶梯系数是起点估计，没有经过系统性回测；请用自己的历史交易校准。",
    "布林带/EMA 基于日线；盘中价格变化不会改变当天的布林带。",
    "评分只用量比、Put/Call、IV Rank 三个因子，没有基本面、新闻和大盘环境。",
    "财报或突发事件造成的跳空可能直接越过多个档位，阶梯不能限制跳空损失。",
    "工具不下单、不连接券商，输出只是参考，不构成投资建议。"
  ];

  function analyze(request, ctx) {
    ctx = ctx || {};
    var now = ctx.now ? parseTime(ctx.now) : new Date();
    var includePosition = ctx.includePosition === true;
    var ladder = buildLadder(request.market || request, { now: now });
    var inp = ladder.input;
    var pv = inp.provenance;
    var report = {
      schema: SCHEMA, engineVersion: VERSION, generatedAt: now.toISOString(),
      ticker: inp.ticker || null,
      status: ladder.ok ? "ok" : (ladder.lv ? "degraded" : "invalid"),
      data: {
        price: { value: inp.price, source: pv.market.source, kind: pv.market.kind, time: ladder.freshness.price.time, timeBasis: ladder.freshness.price.basis, ageMinutes: ladder.freshness.price.ageMinutes, stale: ladder.freshness.price.stale },
        dailyIndicators: { barDate: pv.market.barDate, source: pv.market.source, interval: "1day", partialBar: pv.market.partialBar, ageDays: ladder.freshness.indicators.ageDays, stale: ladder.freshness.indicators.stale },
        options: { source: pv.options.source, time: pv.options.time, ticker: pv.options.ticker || null, kind: pv.options.kind },
        fetchedAt: pv.market.fetchedAt
      },
      inputs: {},
      ladder: [],
      currentZone: ladder.zone,
      candidates: ladder.candidates,
      scores: ladder.conviction ? {
        trend: ladder.trend,
        sentiment: {
          buyScore: ladder.conviction.buyScore, sellScore: ladder.conviction.sellScore,
          buyMultiplier: ladder.conviction.buyMult, sellMultiplier: ladder.conviction.sellMult,
          completeness: ladder.conviction.completeness, components: ladder.conviction.components
        }
      } : null,
      allocation: ladder.allocation ? { sellBasis: ladder.allocation.sellBasis, sellCapPct: ladder.allocation.sellCapPct, buyCapPct: ladder.allocation.buyCapPct, sellTotalPct: ladder.allocation.sellTotalPct, buyTotalPct: ladder.allocation.buyTotalPct,
        definition: ladder.allocation.sellBasis === "remaining" ? "卖出比例以触发当时的剩余持仓为基数，累计 = 1 − Π(1 − 各档比例)" : "卖出比例以计划开始时的持仓为基数，按 D1→E2 依次累计，不超过上限" } : null,
      takeProfit: null,
      errors: ladder.errors,
      warnings: ladder.warnings,
      limitations: LIMITATIONS.slice()
    };
    NUM_FIELDS.forEach(function (f) {
      report.inputs[f] = { value: inp[f], status: ladder.fieldStatus[f], label: FIELD_LABEL[f] };
    });
    report.ladder = ladder.rows.map(function (r) {
      return {
        level: r.key, zone: r.zone, action: r.label, side: r.side, price: round(r.price, 2),
        allocation: { basePct: r.alloc.basePct, multiplier: r.alloc.multiplier, effectivePct: r.alloc.effectivePct, cumulativePct: r.alloc.cumPct, ofRemainingPct: r.alloc.ofRemainingPct, basis: r.alloc.basis, capped: r.alloc.capped }
      };
    });
    if (includePosition && request.position) {
      var tp = analyzeTakeProfit(request.position, ladder, { now: now });
      report.takeProfit = tp;
    } else if (request.position && !includePosition) {
      report.warnings = report.warnings.concat([msg("POSITION_IGNORED", "公开接口不处理持仓数据，已忽略。")]);
    }
    return report;
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA,
    DEFAULT_COEFFS: DEFAULT_COEFFS, DEFAULT_ALLOC: DEFAULT_ALLOC, DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    LEVEL_ORDER: LEVEL_ORDER, SELL_TIERS: SELL_TIERS, BUY_TIERS: BUY_TIERS, LEVEL_META: LEVEL_META,
    FIELD_LABEL: FIELD_LABEL, NUM_FIELDS: NUM_FIELDS, LIMITATIONS: LIMITATIONS,
    parseNum: parseNum, parseTime: parseTime, round: round, isValidTicker: isValidTicker, normTicker: normTicker,
    normalizeInput: normalizeInput, validateInput: validateInput, freshness: freshness,
    computeLevels: computeLevels, scoreConviction: scoreConviction, clampMult: clampMult,
    allocateTiers: allocateTiers, locateZone: locateZone, candidateConditions: candidateConditions,
    buildLadder: buildLadder, normalizePosition: normalizePosition, analyzeTakeProfit: analyzeTakeProfit,
    indicatorsFromBars: indicatorsFromBars, emaSeries: emaSeries, analyze: analyze, clone: clone, ymd: ymd
  };
});
