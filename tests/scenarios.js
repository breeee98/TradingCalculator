// 历史场景回放工具：逐日只用“当天及以前”的日线计算指标（无未来数据），
// 再走一遍阶梯与止盈判断。测试（scenarios.test.js）和报告（report.js）共用。
"use strict";
const path = require("path");
const C = require("../core.js");
const { loadBars, loadCloseOnly } = require("../cli/csv.js");

const FIX = (f) => path.join(__dirname, "fixtures", f);
const DATA = {
  AAPL: () => loadBars(FIX("aapl_2015_2017.csv")),
  TSLA: () => loadBars(FIX("tsla_2012_2015.csv")),          // 文件名沿用来源，实际覆盖 2015-10 至 2018-10
  GSPC: () => loadCloseOnly(FIX("closes_2007_2016.csv"), "GSPC") // 只有收盘价，没有成交量
};

const SCENARIOS = [
  { id: "uptrend-tsla", type: "上涨趋势", ticker: "TSLA", from: "2016-12-01", to: "2017-03-01", note: "TSLA 两个月上涨约 34%" },
  { id: "uptrend-aapl", type: "上涨趋势", ticker: "AAPL", from: "2016-12-12", to: "2017-02-16", note: "AAPL 两个月上涨约 17%，含 2017-02-01 财报跳空" },
  { id: "crash-aapl-2015", type: "急跌", ticker: "AAPL", from: "2015-08-10", to: "2015-09-04", note: "2015-08-24 全球急跌，开盘跳空 −10%；EMA200 尚未形成（数据只有约 130 根）" },
  { id: "crash-tsla-2018", type: "急跌", ticker: "TSLA", from: "2018-08-10", to: "2018-10-08", note: "TSLA 两个月下跌约 30%，含 2018-09-28 单日 −13.9%" },
  { id: "crash-gspc-2008", type: "急跌", ticker: "GSPC", from: "2008-09-01", to: "2008-11-28", note: "标普 500 2008 年金融危机；数据只有收盘价，无成交量" },
  { id: "range-aapl", type: "横盘", ticker: "AAPL", from: "2016-05-24", to: "2016-07-21", note: "两个月涨跌 +1.6%，区间宽度约 11%" },
  { id: "range-tsla", type: "横盘", ticker: "TSLA", from: "2016-07-05", to: "2016-10-26", note: "近四个月在区间内来回" },
  { id: "gap-aapl-201604", type: "财报跳空", ticker: "AAPL", from: "2016-04-20", to: "2016-05-04", event: "2016-04-27", note: "财报后跳空 −8.0%" },
  { id: "gap-aapl-201607", type: "财报跳空", ticker: "AAPL", from: "2016-07-20", to: "2016-08-03", event: "2016-07-27", note: "财报后跳空 +7.9%" },
  { id: "gap-tsla-201808", type: "财报跳空", ticker: "TSLA", from: "2018-07-26", to: "2018-08-09", event: "2018-08-02", note: "财报后跳空 +9.2%，收盘 +16.2%" },
  { id: "highvol-tsla-2018", type: "高波动", ticker: "TSLA", from: "2018-08-01", to: "2018-10-15", note: "“funding secured”、SEC 起诉与和解，单日波动多次超过 10%" }
];

function marketInput(ticker, bars, t, opts) {
  opts = opts || {};
  const ind = C.indicatorsFromBars(bars.slice(0, t + 1));
  if (!ind.ok) return null;
  const price = opts.priceMult ? ind.price * opts.priceMult : ind.price;
  const m = {
    ticker, price, bbU: ind.bbU, bbM: ind.bbM, bbL: ind.bbL,
    ema20: ind.ema20, ema50: ind.ema50, ema200: ind.ema200,
    vol: ind.vol, avgVol: ind.avgVol,
    pcr: opts.pcr === undefined ? null : opts.pcr, ivr: opts.ivr === undefined ? null : opts.ivr,
    options: opts.options,
    provenance: {
      market: { kind: "manual", ticker, source: "历史回放", barDate: bars[t].date },
      options: opts.pcr != null || opts.ivr != null ? { kind: "manual", ticker } : {}
    }
  };
  if (opts.dropVolume) { m.vol = null; m.avgVol = null; }
  if (opts.dropEma200) m.ema200 = null;
  return m;
}

/**
 * 回放一个场景。position 默认：100 股，成本 = 场景起点收盘价 × 0.85。
 */
function run(sc, opts) {
  opts = opts || {};
  const bars = DATA[sc.ticker]();
  const i0 = bars.findIndex((b) => b.date >= sc.from);
  let i1 = bars.findIndex((b) => b.date > sc.to); if (i1 < 0) i1 = bars.length;
  // 假设成本 = 场景起点收盘价 × 0.85，使大多数日子处于盈利状态，能够检验止盈判断本身
  const cost = opts.avgCost || bars[i0].close * 0.85;
  const days = [];
  for (let t = i0; t < i1; t++) {
    const mi = marketInput(sc.ticker, bars, t, opts);
    if (!mi) continue;
    const now = bars[t].date + "T21:00:00Z";
    const lad = C.buildLadder(mi, { now });
    const pos = { ticker: sc.ticker, accountType: opts.accountType || "swing", shares: 100, avgCost: cost,
      events: sc.event && opts.withEarnings !== false ? [{ date: sc.event, type: "earnings" }] : [] };
    const tp = lad.ok ? C.analyzeTakeProfit(pos, lad, { now }) : null;
    const fwd = (n) => (t + n < bars.length ? bars[t + n].close / bars[t].close - 1 : null);
    days.push({
      date: bars[t].date, close: bars[t].close, open: bars[t].open,
      gap: t > 0 && bars[t].open != null ? bars[t].open / bars[t - 1].close - 1 : null,
      ok: lad.ok, errors: lad.errors.map((e) => e.code), warnings: lad.warnings.map((w) => w.code),
      lv: lad.lv, nearest: lad.zone && lad.zone.nearest, zone: lad.zone && lad.zone.zone, position: lad.zone && lad.zone.position,
      alignment: lad.levels && lad.levels.alignment, clamps: lad.levels ? lad.levels.clamps.length : 0,
      sellMult: lad.conviction && lad.conviction.sellMult, buyMult: lad.conviction && lad.conviction.buyMult,
      volRatio: lad.conviction && lad.conviction.volRatio,
      sellTotal: lad.allocation && lad.allocation.sellTotalPct, buyTotal: lad.allocation && lad.allocation.buyTotalPct,
      sellCap: lad.allocation && lad.allocation.sellCapPct, buyCap: lad.allocation && lad.allocation.buyCapPct,
      reachedSell: lad.candidates.filter((c) => c.side === "sell" && /^REACHED_/.test(c.id)).length,
      reachedBuy: lad.candidates.filter((c) => c.side === "buy" && /^REACHED_/.test(c.id)).length,
      rec: tp && tp.ok ? tp.recommendation : null,
      sellNow: tp && tp.ok ? tp.summary.sellNowShares : 0,
      tiers: tp && tp.ok ? tp.tiers : [],
      tpTotalShares: tp && tp.ok ? tp.tiers.reduce((a, x) => a + x.suggestedShares, 0) : 0,
      fwd5: fwd(5), fwd10: fwd(10)
    });
  }
  return { scenario: sc, cost, days };
}

module.exports = { SCENARIOS, DATA, run, marketInput };
