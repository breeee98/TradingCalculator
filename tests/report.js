#!/usr/bin/env node
// 生成 docs/验证报告.md：历史场景回放 + 不同数据条件下的信号稳定性。
// 用法：node tests/report.js
"use strict";
const fs = require("fs");
const path = require("path");
const C = require("../core.js");
const S = require("./scenarios.js");

const REC = { trim: "分批止盈", hold: "继续持有", noAction: "无需操作", null: "—" };
const pct = (x, d = 0) => (x === null || x === undefined ? "—" : (x * 100).toFixed(d) + "%");

function flips(days) { let n = 0; for (let i = 1; i < days.length; i++) if (days[i].rec !== days[i - 1].rec) n++; return n; }
function agree(a, b, key) { let n = 0, m = 0; a.forEach((d, i) => { if (!b[i]) return; m++; if (d[key] === b[i][key]) n++; }); return m ? n / m : null; }
// 原版算法（无保序修正）在同一天会不会出现档位顺序颠倒：用原版公式独立重算
function legacyLevels(m) {
  const c = C.DEFAULT_COEFFS, BW = Math.max(m.bbU - m.bbL, 0.01), b = 0.35;
  const lv = { A1: m.bbL - c.kA1 * BW, A2: m.bbL, B1: m.bbL + c.kOuter * BW, B2: m.bbM - c.kInner * BW, C1: m.bbM - c.kTrial * BW, C2: m.bbM + c.kTrial * BW, D1: m.bbU - c.kOuter * BW, D2: m.bbU - c.kInner * BW, D3: m.bbU, E1: m.bbU + c.kE1 * BW, E2: m.bbU + c.kE2 * BW };
  // 原版用 num()，缺失的 EMA 会变成 0
  const e20 = m.ema20 || 0, e50 = m.ema50 || 0, e200 = m.ema200 || 0;
  let bias = 0; if (e20 > e50 && e50 > e200) bias = 1; else if (e20 < e50 && e50 < e200) bias = -1;
  if (bias === 1) { if (e50 > m.bbL && e50 < m.bbM) { lv.A2 = lv.A2 * (1 - b) + e50 * b; lv.B2 = lv.B2 * (1 - b) + e50 * b; } }
  else if (bias === -1) { if (e50 > m.bbM && e50 < m.bbU) { lv.D2 = lv.D2 * (1 - b) + e50 * b; lv.D3 = lv.D3 * (1 - b) + e50 * b; } }
  return lv;
}
function legacyOrderBroken(sc) {
  const bars = S.DATA[sc.ticker]();
  let n = 0;
  bars.forEach((bar, t) => {
    if (bar.date < sc.from || bar.date > sc.to) return;
    const m = S.marketInput(sc.ticker, bars, t, {});
    if (!m) return;
    const lv = legacyLevels(m);
    if (!C.LEVEL_ORDER.every((k, i) => i === 0 || lv[C.LEVEL_ORDER[i - 1]] < lv[k])) n++;
  });
  return n;
}
function levelJump(days, date) {
  const i = days.findIndex((d) => d.date === date);
  if (i <= 0) return null;
  const a = C.LEVEL_ORDER.indexOf(days[i - 1].nearest), b = C.LEVEL_ORDER.indexOf(days[i].nearest);
  return { from: days[i - 1].nearest, to: days[i].nearest, steps: b - a, gap: days[i].gap, ret: days[i].close / days[i - 1].close - 1 };
}
function fwdStats(days, rec) {
  const xs = days.filter((d) => d.rec === rec && d.fwd10 !== null).map((d) => d.fwd10);
  if (!xs.length) return "—";
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  return `n=${xs.length}，10日后平均 ${pct(avg, 1)}`;
}

function analyzeAll() {
  const rows = [];
  for (const sc of S.SCENARIOS) {
    const base = S.run(sc);
    const variants = {
      neutralOpt: S.run(sc, { pcr: 0.9, ivr: 40 }),
      greedOpt: S.run(sc, { pcr: 0.6, ivr: 40 }),
      fearOpt: S.run(sc, { pcr: 1.2, ivr: 70 }),
      up03: S.run(sc, { priceMult: 1.003 }),
      dn03: S.run(sc, { priceMult: 0.997 }),
      noVol: S.run(sc, { dropVolume: true }),
      noE200: S.run(sc, { dropEma200: true }),
      remaining: S.run(sc, { options: { sellBasis: "remaining" } }),
      long: S.run(sc, { accountType: "long" })
    };
    rows.push({ sc, base, variants });
  }
  return rows;
}

function main() {
  const all = analyzeAll();
  const L = [];
  L.push("# 验证报告：历史场景回放与信号稳定性", "");
  L.push(`生成时间：${new Date().toISOString()} · 引擎版本 ${C.VERSION} · 由 \`node tests/report.js\` 自动生成`, "");
  L.push("## 数据与方法", "");
  L.push("- 数据：仓库内 `tests/fixtures/` 的真实历史日线（AAPL 2015-02 至 2017-02、TSLA 2015-10 至 2018-10，来自 plotly/datasets 公开数据集；标普 500 2007–2016 只有收盘价）。这台机器无法访问最新行情源，所以没有 2024–2026 的数据；接上 Worker 后可以用同一套脚本跑最新数据。");
  L.push("- 逐日回放：第 t 天只用第 t 天及以前的日线计算布林带/EMA/均量，没有未来数据。现价 = 当日收盘价。");
  L.push("- 期权数据：历史 Put/Call 和 IV Rank 拿不到，基准情形按“缺失”处理；另做“中性 / 追涨 / 恐慌”三组假设对照。");
  L.push("- 假设持仓：100 股，成本 = 场景起点收盘价 × 0.85（让多数日子处于盈利，从而检验止盈判断本身）；波段账户；财报场景在事件日前 7 天内计入“财报临近”。");
  L.push("- 这不是收益回测：样本很少，10 日后涨跌只作描述，不能证明系数有效。", "");

  L.push("## 1. 各场景结果", "");
  L.push("| 场景 | 类型 | 天数 | 阶梯可用 | 趋势排列 | 分批止盈 / 继续持有 / 无需操作 | 建议日次日起改变次数 | 原版档位顺序颠倒天数 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const { sc, base } of all) {
    const d = base.days;
    const c = (r) => d.filter((x) => x.rec === r).length;
    const al = [...new Set(d.map((x) => ({ bull: "多头", bear: "空头", mixed: "交错", unknown: "未知" }[x.alignment])))].join("/");
    L.push(`| ${sc.id}<br>${sc.note} | ${sc.type} | ${d.length} | ${d.filter((x) => x.ok).length}/${d.length} | ${al} | ${c("trim")} / ${c("hold")} / ${c("noAction")} | ${flips(d)} | ${legacyOrderBroken(sc)} |`);
  }
  L.push("", "“原版档位顺序颠倒天数”：用旧版 index.html 的公式独立重算，统计出现 B2 ≤ B1 之类顺序颠倒的交易日。新版在这些日子把被趋势修正的档位限制在相邻档位之间。", "");

  L.push("## 2. 关键日子", "");
  const keyDays = [
    ["crash-aapl-2015", "2015-08-24"], ["crash-tsla-2018", "2018-09-28"], ["gap-aapl-201604", "2016-04-27"],
    ["gap-aapl-201607", "2016-07-27"], ["gap-tsla-201808", "2018-08-02"], ["uptrend-aapl", "2017-02-01"], ["highvol-tsla-2018", "2018-08-07"]
  ];
  L.push("| 场景 | 日期 | 开盘跳空 | 当日涨跌 | 最近档位变化 | 越过档位数 | 量比 | 止盈判断 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const [id, date] of keyDays) {
    const r = all.find((x) => x.sc.id === id).base;
    const j = levelJump(r.days, date);
    const day = r.days.find((x) => x.date === date);
    if (!j || !day) continue;
    L.push(`| ${id} | ${date} | ${pct(j.gap, 1)} | ${pct(j.ret, 1)} | ${j.from} → ${j.to} | ${j.steps > 0 ? "+" : ""}${j.steps} | ${day.volRatio === null ? "—" : day.volRatio.toFixed(2)} | ${REC[day.rec]} |`);
  }
  L.push("", "跳空日的价格会一次越过多个档位：阶梯只在收盘后重新计算，盘中和跳空期间无法限制损失或锁定利润。2015-08-24 这类“盘中暴跌、收盘收回”的日子，用收盘价看几乎没变化，盘中最低价其实已经跌破 A1——当前算法只看现价，不看日内高低点。", "");

  L.push("## 3. 信号稳定性（与基准逐日对比，相同的比例）", "");
  L.push("| 场景 | 期权=中性 | 期权=追涨 | 期权=恐慌 | 现价 +0.3% | 现价 −0.3% | 去掉成交量 | 去掉 EMA200 | 剩余持仓基数 | 长期账户 |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const { sc, base, variants: v } of all) {
    const a = (x) => pct(agree(base.days, x.days, "rec"));
    L.push(`| ${sc.id} | ${a(v.neutralOpt)} | ${a(v.greedOpt)} | ${a(v.fearOpt)} | ${a(v.up03)} | ${a(v.dn03)} | ${a(v.noVol)} | ${a(v.noE200)} | ${a(v.remaining)} | ${a(v.long)} |`);
  }
  L.push("");
  L.push("最近档位（不看止盈判断，只看现价最接近哪一档）在现价 ±0.3% 扰动下的一致率：", "");
  L.push("| 场景 | +0.3% | −0.3% |", "|---|---|---|");
  for (const { sc, base, variants: v } of all) L.push(`| ${sc.id} | ${pct(agree(base.days, v.up03.days, "nearest"))} | ${pct(agree(base.days, v.dn03.days, "nearest"))} |`);
  L.push("");

  L.push("## 4. 描述性统计：判断之后 10 个交易日的涨跌（不构成有效性证明）", "");
  L.push("| 场景 | 分批止盈 | 继续持有 | 无需操作 |", "|---|---|---|---|");
  for (const { sc, base } of all) L.push(`| ${sc.id} | ${fwdStats(base.days, "trim")} | ${fwdStats(base.days, "hold")} | ${fwdStats(base.days, "noAction")} |`);
  L.push("");

  // 不变量汇总
  let invariantDays = 0, bad = 0;
  for (const { base, variants } of all) for (const r of [base].concat(Object.values(variants))) for (const d of r.days) {
    invariantDays++;
    const okOrder = !d.lv || C.LEVEL_ORDER.every((k, i) => i === 0 || d.lv[C.LEVEL_ORDER[i - 1]] < d.lv[k]);
    const okAlloc = d.sellTotal === null || (d.sellTotal <= d.sellCap + 1e-9 && d.buyTotal <= d.buyCap + 1e-9);
    const okShares = d.tpTotalShares <= 100 + 1e-9;
    const okTrim = d.tiers.every((t) => t.decision !== "建议减仓" || t.reasonsFor.length >= 2);
    if (!(okOrder && okAlloc && okShares && okTrim)) bad++;
  }
  L.push("## 5. 不变量检查", "");
  L.push(`在全部 ${invariantDays} 个“场景 × 数据条件 × 交易日”里检查：档位严格递增、卖出累计 ≤ 上限、买入累计 ≤ 100% − 保留现金、建议股数合计 ≤ 持仓、每个“建议减仓”都至少有一条价格以外的确认理由。违反次数：**${bad}**。`, "");
  const out = path.join(__dirname, "..", "docs", "验证报告.md");
  fs.writeFileSync(out, L.join("\n") + "\n");
  process.stdout.write("已写入 " + out + "\n");
  return all;
}

if (require.main === module) main();
module.exports = { analyzeAll, agree, flips, levelJump, legacyOrderBroken };
