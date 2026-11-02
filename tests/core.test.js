// 核心计算单元测试：node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core.js");

const NOW = "2026-11-02T15:00:00Z";
const BASE = {
  ticker: "MU", price: 42.3, bbU: 46.8, bbM: 41.5, bbL: 36.2,
  ema20: 41.9, ema50: 39.4, ema200: 33.1, vol: 18400000, avgVol: 12600000, pcr: null, ivr: null,
  provenance: { market: { kind: "api", ticker: "MU", source: "test", priceTime: "2026-11-02T14:58:00Z", barDate: "2026-11-02" }, options: {} }
};
const mk = (over) => Object.assign({}, BASE, over || {});

// 原版 index.html 里的 compute()（只保留点位部分），用于回归对比
function legacyLevels(i) {
  const c = C.DEFAULT_COEFFS, BW = Math.max(i.bbU - i.bbL, 0.01);
  const lv = { A1: i.bbL - c.kA1 * BW, A2: i.bbL, B1: i.bbL + c.kOuter * BW, B2: i.bbM - c.kInner * BW, C1: i.bbM - c.kTrial * BW, C2: i.bbM + c.kTrial * BW, D1: i.bbU - c.kOuter * BW, D2: i.bbU - c.kInner * BW, D3: i.bbU, E1: i.bbU + c.kE1 * BW, E2: i.bbU + c.kE2 * BW };
  let bias = 0; if (i.ema20 > i.ema50 && i.ema50 > i.ema200) bias = 1; else if (i.ema20 < i.ema50 && i.ema50 < i.ema200) bias = -1;
  const b = 0.35;
  if (bias === 1) { if (i.ema50 > i.bbL && i.ema50 < i.bbM) { lv.A2 = lv.A2 * (1 - b) + i.ema50 * b; lv.B2 = lv.B2 * (1 - b) + i.ema50 * b; } lv.E1 = i.bbU + c.kE1 * BW * 1.08; lv.E2 = i.bbU + c.kE2 * BW * 1.08; }
  else if (bias === -1) { if (i.ema50 > i.bbM && i.ema50 < i.bbU) { lv.D2 = lv.D2 * (1 - b) + i.ema50 * b; lv.D3 = lv.D3 * (1 - b) + i.ema50 * b; } lv.A1 = i.bbL - c.kA1 * BW * 1.08; }
  return lv;
}

function deepFinite(o, path = "") {
  if (typeof o === "number") assert.ok(Number.isFinite(o), "非有限数值: " + path);
  else if (Array.isArray(o)) o.forEach((x, i) => deepFinite(x, path + "[" + i + "]"));
  else if (o && typeof o === "object") Object.keys(o).forEach((k) => deepFinite(o[k], path + "." + k));
}

test("parseNum：空值/非数字一律为 null，不会变成 0", () => {
  assert.equal(C.parseNum(""), null);
  assert.equal(C.parseNum("   "), null);
  assert.equal(C.parseNum(undefined), null);
  assert.equal(C.parseNum("abc"), null);
  assert.equal(C.parseNum(NaN), null);
  assert.equal(C.parseNum(Infinity), null);
  assert.equal(C.parseNum("1,234.5"), 1234.5);
  assert.equal(C.parseNum("0"), 0);
});

test("点位：正常输入与原版算法逐档一致（回归）", () => {
  const cases = [
    mk(), // 多头排列，EMA50 在下轨~中轨
    mk({ ema20: 30, ema50: 44, ema200: 50 }), // 空头排列，EMA50 在中轨~上轨
    mk({ ema20: 40, ema50: 42, ema200: 41 }), // 交错
    mk({ price: 120, bbU: 130, bbM: 118, bbL: 106, ema20: 119, ema50: 115, ema200: 100 })
  ];
  for (const c of cases) {
    const r = C.buildLadder(c, { now: NOW });
    assert.ok(r.lv, JSON.stringify(r.errors));
    const L = legacyLevels(c);
    for (const k of C.LEVEL_ORDER) assert.ok(Math.abs(r.lv[k] - L[k]) < 1e-9, k);
    assert.equal(r.levels.clamps.length, 0);
  }
});

test("点位：趋势靠拢导致 B2 低于 B1 时被限制在相邻档位之间，顺序保持递增", () => {
  // 多头排列且 EMA50 紧贴下轨：原版会让 B2 跌到 B1 下面
  const c = mk({ ema20: 45, ema50: 36.5, ema200: 30 });
  const L = legacyLevels(c);
  assert.ok(L.B2 < L.B1, "前置条件：原版确实出现顺序颠倒");
  const r = C.buildLadder(c, { now: NOW });
  assert.equal(r.levels.orderViolations.length, 0);
  assert.ok(r.levels.clamps.some((x) => x.level === "B2"));
  for (let i = 1; i < C.LEVEL_ORDER.length; i++) assert.ok(r.lv[C.LEVEL_ORDER[i - 1]] < r.lv[C.LEVEL_ORDER[i]]);
});

test("卖出比例：任何乘数下累计都不超过 100%（修复原版 118%）", () => {
  for (const mult of [0.6, 1.0, 1.3]) {
    for (const basis of ["initial", "remaining"]) {
      const a = C.allocateTiers(C.DEFAULT_ALLOC, { buyMult: mult, sellMult: mult }, { sellBasis: basis });
      assert.ok(a.sellTotalPct <= 100 + 1e-9, `${basis} ${mult}: ${a.sellTotalPct}`);
      assert.ok(a.buyTotalPct <= 90 + 1e-9, "买入侧保留 10% 现金");
      let prev = 0;
      for (const k of C.SELL_TIERS) {
        const r = a.rows[k];
        assert.ok(r.cumPct >= prev - 1e-9);
        assert.ok(Math.abs(prev + r.effectivePct - r.cumPct) < 0.02);
        prev = r.cumPct;
      }
    }
  }
  // 原版示例：5,10,15,40,20 × 1.3 = 117% → 现在 E2 只拿剩余 9%
  const a = C.allocateTiers(C.DEFAULT_ALLOC, { buyMult: 1, sellMult: 1.3 }, { sellBasis: "initial" });
  assert.deepEqual(C.SELL_TIERS.map((k) => a.rows[k].effectivePct), [6.5, 13, 19.5, 52, 9]);
  assert.equal(a.rows.E2.capped, true);
  assert.equal(a.sellTotalPct, 100);
});

test("卖出比例：remaining 基数按 1 − Π(1 − p) 累计", () => {
  const a = C.allocateTiers(C.DEFAULT_ALLOC, { buyMult: 1, sellMult: 1 }, { sellBasis: "remaining" });
  let rem = 1;
  for (const k of C.SELL_TIERS) {
    rem *= 1 - C.DEFAULT_ALLOC[k] / 100;
    assert.ok(Math.abs(a.rows[k].cumPct - (1 - rem) * 100) < 0.01, k);
    assert.ok(Math.abs(a.rows[k].ofRemainingPct - C.DEFAULT_ALLOC[k]) < 0.01, k);
  }
});

test("卖出比例：保留核心仓上限 + 0% 档位保持 0（原版会强制变成 1%）", () => {
  const alloc = Object.assign({}, C.DEFAULT_ALLOC, { D1: 0 });
  const a = C.allocateTiers(alloc, { buyMult: 1, sellMult: 1.3 }, { maxSellPct: 60 });
  assert.equal(a.rows.D1.effectivePct, 0);
  assert.equal(a.sellTotalPct, 60);
});

test("期权数据缺失：记为 missing，不会被当成 Put/Call=0 触发追涨信号", () => {
  const withNull = C.buildLadder(mk({ pcr: "", ivr: "" }), { now: NOW });
  const pc = withNull.conviction.components.find((x) => x.factor === "putCall");
  assert.equal(pc.status, "missing");
  assert.equal(pc.sell, 0);
  // 量比 18.4/12.6 = 1.46，中性；缺失期权时卖出乘数应为 1.0
  assert.equal(withNull.conviction.sellMult, 1);
  assert.equal(withNull.conviction.completeness, "1/3");
  // 对照：原版 num("") = 0 → pcr ≤ 0.7 → 卖出加分
  const zero = C.scoreConviction(C.normalizeInput(mk({ pcr: 0.5 })));
  assert.equal(zero.sellMult, 1.3);
});

test("换股：期权数据属于其他股票时报错，并从评分中剔除", () => {
  const r = C.buildLadder(mk({ pcr: 0.5, ivr: 70, provenance: { market: BASE.provenance.market, options: { ticker: "NVDA", kind: "manual" } } }), { now: NOW });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "OPTIONS_TICKER_MISMATCH"));
  assert.equal(r.conviction.components.find((x) => x.factor === "putCall").status, "missing");
  assert.equal(r.conviction.components.find((x) => x.factor === "ivRank").status, "missing");
});

test("换股：价格/指标属于其他股票时 ok=false", () => {
  const r = C.buildLadder(mk({ ticker: "NVDA" }), { now: NOW });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "MARKET_TICKER_MISMATCH"));
});

test("验证：布林带顺序、价格、IV Rank、系数顺序、比例范围", () => {
  const codes = (o) => C.buildLadder(mk(o), { now: NOW }).errors.map((e) => e.code);
  assert.ok(codes({ bbU: 30 }).includes("BB_ORDER"));
  assert.ok(codes({ bbM: 50 }).includes("BB_ORDER"));
  assert.ok(codes({ price: 0 }).includes("NON_POSITIVE"));
  assert.ok(codes({ price: "" }).includes("REQUIRED"));
  assert.ok(codes({ ivr: 120 }).includes("RANGE"));
  assert.ok(codes({ pcr: -1 }).includes("NON_POSITIVE"));
  assert.ok(codes({ kE1: 0.7 }).includes("COEFF_ORDER"));
  assert.ok(codes({ kTrial: 0.2 }).includes("COEFF_ORDER"));
  assert.ok(codes({ pE1: 150 }).includes("ALLOC_RANGE"));
  const r = C.buildLadder(mk({ bbU: 30 }), { now: NOW });
  assert.equal(r.lv, null, "核心输入无效时不输出点位");
  const far = C.buildLadder(mk({ price: 400 }), { now: NOW });
  assert.ok(far.warnings.some((w) => w.code === "PRICE_FAR_FROM_BANDS"));
});

test("时效：价格时间超过 15 分钟标 ⚠；只有获取时间时提示延迟未知", () => {
  const stale = C.buildLadder(mk({ provenance: { market: Object.assign({}, BASE.provenance.market, { priceTime: "2026-11-02T14:30:00Z" }) } }), { now: NOW });
  assert.ok(stale.warnings.some((w) => w.code === "STALE_PRICE"));
  assert.equal(stale.freshness.price.ageMinutes, 30);
  const fresh = C.buildLadder(mk(), { now: NOW });
  assert.ok(!fresh.warnings.some((w) => w.code === "STALE_PRICE"));
  const noTs = C.buildLadder(mk({ provenance: { market: { kind: "api", ticker: "MU", fetchedAt: "2026-11-02T14:59:00Z" } } }), { now: NOW });
  assert.ok(noTs.warnings.some((w) => w.code === "PRICE_TIME_UNKNOWN"));
  const oldBars = C.buildLadder(mk({ provenance: { market: Object.assign({}, BASE.provenance.market, { barDate: "2026-10-20" }) } }), { now: NOW });
  assert.ok(oldBars.warnings.some((w) => w.code === "STALE_BARS"));
});

test("盘中未完结的日线：量能评分跳过", () => {
  const r = C.buildLadder(mk({ vol: 40000000, provenance: { market: Object.assign({}, BASE.provenance.market, { partialBar: true }) } }), { now: NOW });
  const v = r.conviction.components.find((x) => x.factor === "volume");
  assert.equal(v.status, "partial");
  assert.equal(v.buy, 0);
});

test("所在区域：高于 E2 / 低于 A1 / 档位之间", () => {
  const r = C.buildLadder(mk(), { now: NOW });
  assert.equal(C.locateZone(1000, r.lv).position, "above");
  assert.equal(C.locateZone(1, r.lv).position, "below");
  const z = C.locateZone((r.lv.D1 + r.lv.D2) / 2, r.lv);
  assert.equal(z.lower, "D1"); assert.equal(z.upper, "D2"); assert.equal(z.zone, "D");
});

// ---------- 止盈分析 ----------
const neutral = (over) => mk(Object.assign({ ema20: 41, ema50: 42, ema200: 40, vol: 1e6, avgVol: 1e6 }, over || {}));
const pos = (over) => Object.assign({ ticker: "MU", accountType: "swing", shares: 100, avgCost: 30 }, over || {});

test("止盈：只到达档位、没有确认 → 不会给“建议减仓”", () => {
  const lad = C.buildLadder(neutral({ price: 45.6 }), { now: NOW }); // 高于 D2
  const tp = C.analyzeTakeProfit(pos(), lad, { now: NOW });
  assert.ok(tp.ok, JSON.stringify(tp.errors));
  const reached = tp.tiers.filter((t) => t.reached);
  assert.ok(reached.length >= 2);
  assert.ok(reached.every((t) => t.decision !== "建议减仓"));
  assert.notEqual(tp.recommendation, "trim");
  assert.deepEqual(tp.options.map((o) => o.id), ["trim", "hold", "noAction"]);
});

test("止盈：放量 + 期权追涨确认 → 建议减仓，股数与金额正确", () => {
  const lad = C.buildLadder(neutral({ price: 45.6, vol: 2e6, pcr: 0.6, ivr: 30, provenance: { market: BASE.provenance.market, options: { ticker: "MU", kind: "manual" } } }), { now: NOW });
  assert.equal(lad.conviction.sellMult, 1.3);
  const tp = C.analyzeTakeProfit(pos(), lad, { now: NOW });
  const d1 = tp.tiers.find((t) => t.tier === "D1"), d2 = tp.tiers.find((t) => t.tier === "D2");
  assert.equal(d1.decision, "建议减仓");
  assert.equal(d1.suggestedShares, 6);   // floor(100 × 6.5%)
  assert.equal(d2.suggestedShares, 13);  // floor(100 × 19.5%) − 6
  assert.equal(tp.summary.sellNowShares, 19);
  assert.equal(tp.summary.remainingRisk.remainingShares, 81);
  assert.equal(tp.summary.realizedProfitNow, C.round(19 * (45.6 - 30), 2));
  assert.equal(tp.recommendation, "trim");
  // 全部档位合计不超过持仓
  const total = tp.tiers.reduce((a, t) => a + t.suggestedShares, 0);
  assert.ok(total <= 100);
});

test("止盈：多头排列且无放量 → 继续持有", () => {
  const lad = C.buildLadder(mk({ price: 47 }), { now: NOW }); // BASE 是多头排列，量比 1.46
  const tp = C.analyzeTakeProfit(pos(), lad, { now: NOW });
  assert.ok(tp.tiers.filter((t) => t.reached).every((t) => t.decision === "继续持有"));
  assert.equal(tp.recommendation, "hold");
});

test("止盈：财报在 7 天内的波段仓位，作为额外确认", () => {
  const lad = C.buildLadder(neutral({ price: 44 }), { now: NOW });
  const tp = C.analyzeTakeProfit(pos({ events: [{ date: "2026-11-05", type: "earnings" }] }), lad, { now: NOW });
  assert.equal(tp.tiers.find((t) => t.tier === "D1").decision, "建议减仓");
  assert.ok(tp.summary.remainingRisk.eventRisk);
});

test("止盈：低于成本 → 无需操作；低于 D1 → 无需操作", () => {
  const lad = C.buildLadder(neutral({ price: 45.6 }), { now: NOW });
  const loss = C.analyzeTakeProfit(pos({ avgCost: 50 }), lad, { now: NOW });
  assert.equal(loss.recommendation, "noAction");
  assert.ok(loss.tiers.filter((t) => t.reached).every((t) => t.decision === "无需操作"));
  const low = C.analyzeTakeProfit(pos(), C.buildLadder(neutral({ price: 40 }), { now: NOW }), { now: NOW });
  assert.equal(low.recommendation, "noAction");
  assert.ok(low.tiers.every((t) => t.decision === "未触及"));
});

test("止盈：已有卖出记录先抵扣低档位，累计股数按计划基数计算", () => {
  const lad = C.buildLadder(neutral({ price: 45.6, vol: 2e6, pcr: 0.6, provenance: { market: BASE.provenance.market, options: { ticker: "MU" } } }), { now: NOW });
  // 原有 100 股，D1 已卖 6 股，现持 94 股
  const tp = C.analyzeTakeProfit(pos({ shares: 94, sales: [{ date: "2026-10-30", shares: 6, price: 43.7, tier: "D1" }] }), lad, { now: NOW });
  assert.equal(tp.planBaseShares, 100);
  assert.equal(tp.tiers.find((t) => t.tier === "D1").decision, "已完成");
  assert.equal(tp.tiers.find((t) => t.tier === "D2").suggestedShares, 13);
  assert.equal(tp.realizedFromRecords, C.round(6 * (43.7 - 30), 2));
});

test("止盈：零碎股按 0.001 股计算；长期账户保留核心仓", () => {
  const lad = C.buildLadder(neutral({ price: 60, vol: 2e6, pcr: 0.6, provenance: { market: BASE.provenance.market, options: { ticker: "MU" } } }), { now: NOW });
  const tp = C.analyzeTakeProfit(pos({ shares: 6.752, accountType: "long", exitPlan: { keepCorePct: 50 } }), lad, { now: NOW });
  assert.equal(tp.shareStep, 0.001);
  assert.equal(tp.maxSellPct, 50);
  const total = tp.tiers.reduce((a, t) => a + t.suggestedShares, 0);
  assert.ok(total <= 6.752 * 0.5 + 1e-9, String(total));
  // 长期账户 D 档默认降一级
  assert.ok(tp.tiers.filter((t) => t.zone === "D").every((t) => t.decision !== "建议减仓"));
});

test("止盈：持仓代码不一致或演示数据时拒绝计算", () => {
  const lad = C.buildLadder(neutral({ price: 45 }), { now: NOW });
  assert.equal(C.analyzeTakeProfit(pos({ ticker: "NVDA" }), lad, { now: NOW }).ok, false);
  const demo = C.buildLadder(neutral({ price: 45, provenance: { market: { kind: "demo", ticker: "MU" } } }), { now: NOW });
  const tp = C.analyzeTakeProfit(pos(), demo, { now: NOW });
  assert.equal(tp.ok, false);
  assert.ok(tp.errors.some((e) => e.code === "DEMO_DATA"));
});

// ---------- 统一 JSON ----------
test("analyze：公开模式忽略持仓；受保护模式包含止盈；全部数值有限且可序列化", () => {
  const req = { market: neutral({ price: 45.6 }), position: pos() };
  const pub = C.analyze(req, { now: NOW });
  assert.equal(pub.takeProfit, null);
  assert.ok(pub.warnings.some((w) => w.code === "POSITION_IGNORED"));
  assert.ok(!JSON.stringify(pub).includes("avgCost"));
  const priv = C.analyze(req, { now: NOW, includePosition: true });
  assert.ok(priv.takeProfit && priv.takeProfit.ok);
  for (const r of [pub, priv]) {
    deepFinite(JSON.parse(JSON.stringify(r)));
    assert.equal(r.schema, C.SCHEMA);
    assert.equal(r.ladder.length, 11);
    assert.equal(r.inputs.pcr.status, "missing");
    assert.equal(r.inputs.pcr.value, null);
  }
});

// ---------- 指标 ----------
test("指标：布林带/EMA/均量与逐步手算一致，均量不含当日", () => {
  const bars = [];
  for (let i = 0; i < 260; i++) bars.push({ date: "d" + i, close: 100 + 10 * Math.sin(i / 9) + i * 0.1, volume: 1000 + i });
  const ind = C.indicatorsFromBars(bars);
  const closes = bars.map((b) => b.close);
  const last20 = closes.slice(-20), m = last20.reduce((a, b) => a + b) / 20;
  const sd = Math.sqrt(last20.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  assert.ok(Math.abs(ind.bbM - m) < 1e-9);
  assert.ok(Math.abs(ind.bbU - (m + 2 * sd)) < 1e-9);
  let e = closes.slice(0, 50).reduce((a, b) => a + b) / 50;
  for (let i = 50; i < closes.length; i++) e = closes[i] * (2 / 51) + e * (1 - 2 / 51);
  assert.ok(Math.abs(ind.ema50 - e) < 1e-9);
  const prev20 = bars.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20;
  assert.equal(ind.avgVol, prev20);
  assert.equal(ind.vol, 1259);
  assert.equal(C.indicatorsFromBars(bars.slice(0, 100)).ema200, null);
});

test("指标：与第三方实现（R TTR::BBands，plotly 数据集自带列）逐日一致", () => {
  const fs = require("fs");
  const { splitCsvLine } = require("../cli/csv.js");
  const rows = fs.readFileSync(__dirname + "/fixtures/aapl_2015_2017.csv", "utf8").trim().split("\n").slice(1).map(splitCsvLine);
  // 该数据集的 dn/mavg/up 是 TTR::BBands(HLC, n=20, sd=2) 的结果，使用典型价 (H+L+C)/3、总体标准差
  const bars = rows.map((c) => ({ date: c[0], close: (+c[2] + +c[3] + +c[4]) / 3, volume: +c[5] }));
  let max = 0;
  for (let i = 19; i < rows.length; i++) {
    const ind = C.indicatorsFromBars(bars.slice(0, i + 1));
    max = Math.max(max, Math.abs(ind.bbM - +rows[i][8]), Math.abs(ind.bbU - +rows[i][9]), Math.abs(ind.bbL - +rows[i][7]));
  }
  assert.ok(max < 1e-6, "最大偏差 " + max);
});
