// 历史场景回放测试：上涨趋势、急跌、横盘、财报跳空、高波动 + 不同数据条件下的稳定性
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core.js");
const S = require("./scenarios.js");
const R = require("./report.js");

const ALL = R.analyzeAll(); // 每个场景：基准 + 9 种数据条件
const get = (id) => ALL.find((x) => x.sc.id === id);

test("五类场景都覆盖到，且每天阶梯都能计算", () => {
  const types = new Set(ALL.map((x) => x.sc.type));
  for (const t of ["上涨趋势", "急跌", "横盘", "财报跳空", "高波动"]) assert.ok(types.has(t), t);
  for (const { sc, base } of ALL) {
    assert.ok(base.days.length >= 10, sc.id);
    assert.ok(base.days.every((d) => d.ok), sc.id + "：" + JSON.stringify(base.days.filter((d) => !d.ok).map((d) => d.date + d.errors)));
  }
});

test("不变量：档位递增、比例不超上限、股数不超持仓、“建议减仓”必有额外确认", () => {
  for (const { sc, base, variants } of ALL) {
    for (const r of [base].concat(Object.values(variants))) {
      for (const d of r.days) {
        const where = sc.id + " " + d.date;
        for (let i = 1; i < C.LEVEL_ORDER.length; i++) assert.ok(d.lv[C.LEVEL_ORDER[i - 1]] < d.lv[C.LEVEL_ORDER[i]], where);
        assert.ok(d.sellTotal <= d.sellCap + 1e-9 && d.buyTotal <= d.buyCap + 1e-9, where);
        assert.ok(d.tpTotalShares <= 100 + 1e-9, where);
        for (const t of d.tiers) {
          if (t.decision === "建议减仓") assert.ok(t.reasonsFor.length >= 2, where + " " + t.tier);
          for (const k of ["price", "suggestedShares", "expectedProceeds", "expectedRealizedProfit"]) assert.ok(Number.isFinite(t[k]), where + k);
        }
      }
    }
  }
});

test("稳定性：期权数据缺失与“中性”期权数据给出完全相同的判断", () => {
  for (const { sc, base, variants } of ALL) assert.equal(R.agree(base.days, variants.neutralOpt.days, "rec"), 1, sc.id);
});

test("稳定性：现价 ±0.3% 扰动下，止盈判断一致率 ≥ 85%", () => {
  for (const { sc, base, variants } of ALL) {
    for (const v of [variants.up03, variants.dn03]) {
      const a = R.agree(base.days, v.days, "rec");
      assert.ok(a >= 0.85, `${sc.id}: ${a}`);
    }
  }
});

test("稳定性：比例基数（初始/剩余）只改变股数，不改变判断", () => {
  for (const { sc, base, variants } of ALL) assert.equal(R.agree(base.days, variants.remaining.days, "rec"), 1, sc.id);
});

test("上涨趋势：多头排列、没有放量、没有事件时，绝不给“建议减仓”", () => {
  for (const id of ["uptrend-tsla", "uptrend-aapl"]) {
    for (const d of get(id).base.days) {
      if (d.alignment === "bull" && (d.volRatio === null || d.volRatio < 1.5)) {
        assert.ok(d.tiers.every((t) => t.decision !== "建议减仓"), id + " " + d.date);
      }
    }
  }
  // 两个上涨场景里大部分日子应是“继续持有”
  const up = get("uptrend-aapl").base.days;
  assert.ok(up.filter((d) => d.rec === "hold").length / up.length > 0.6);
});

test("急跌：暴跌日不会给“分批止盈”，买入侧档位被触发", () => {
  const checks = [["crash-tsla-2018", "2018-09-28"], ["crash-gspc-2008", "2008-10-09"], ["gap-aapl-201604", "2016-04-27"]];
  for (const [id, date] of checks) {
    const d = get(id).base.days.find((x) => x.date === date);
    assert.ok(d, id + date);
    assert.notEqual(d.rec, "trim", id + date);
    assert.ok(d.reachedBuy > 0, id + date + " 应触发买入侧候选");
  }
});

test("财报跳空：一天越过多个档位，并在报告中可见", () => {
  const j1 = R.levelJump(get("gap-aapl-201607").base.days, "2016-07-27");
  const j2 = R.levelJump(get("gap-tsla-201808").base.days, "2018-08-02");
  const j3 = R.levelJump(get("crash-tsla-2018").base.days, "2018-09-28");
  assert.ok(j1.steps >= 3 && j2.steps >= 3 && j3.steps <= -3, JSON.stringify([j1, j2, j3]));
});

test("数据缺失：只有收盘价（无成交量）时量能记为缺失，不产生量能条件", () => {
  for (const d of get("crash-gspc-2008").base.days) {
    assert.equal(d.volRatio, null);
    assert.ok(d.warnings.includes("MISSING"));
  }
});

test("数据缺失：EMA200 未形成时趋势为“未知”，不做趋势修正但阶梯照常可用", () => {
  const days = get("crash-aapl-2015").base.days;
  assert.ok(days.every((d) => d.alignment === "unknown" && d.ok && d.clamps === 0));
});

test("原版算法在强势上涨中经常出现档位顺序颠倒（新版已修正）", () => {
  assert.ok(R.legacyOrderBroken(get("uptrend-tsla").sc) > 0);
  assert.ok(R.legacyOrderBroken(get("uptrend-aapl").sc) > 0);
});

test("无未来数据：第 t 天的结果不受之后日线影响；重复运行结果完全一致", () => {
  const bars = S.DATA.TSLA();
  const t = bars.findIndex((b) => b.date === "2018-08-02");
  const a = S.marketInput("TSLA", bars, t, {});
  const b = S.marketInput("TSLA", bars.slice(0, t + 1), t, {});
  assert.deepEqual(a, b);
  const sc = get("highvol-tsla-2018").sc;
  assert.equal(JSON.stringify(S.run(sc).days), JSON.stringify(S.run(sc).days));
});
