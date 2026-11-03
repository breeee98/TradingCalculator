#!/usr/bin/env node
/**
 * 离线分析：读取 JSON 输入，输出与接口相同结构的 JSON。不联网、不下单。
 *
 * 用法：
 *   node cli/analyze.js input.json            # 公开分析（即使文件里有 position 也会忽略）
 *   node cli/analyze.js input.json --private  # 含止盈分析（仅在你自己的电脑上用）
 *   cat input.json | node cli/analyze.js -
 *
 * input.json：
 *   { "market": { "ticker":"MU", "price":..., "bbU":..., ... 或 "barsCsv":"path/to/daily.csv" },
 *     "position": { "shares":100, "avgCost":80, ... }, "now": "2026-11-02T20:00:00Z" }
 */
"use strict";
const fs = require("fs");
const path = require("path");
const Core = require("../core.js");
const { loadBars } = require("./csv.js");

function main(argv) {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { process.stderr.write("用法：node cli/analyze.js input.json [--private]\n"); return 2; }
  const text = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
  const req = JSON.parse(text);
  const market = Object.assign({}, req.market || {});
  if (market.barsCsv) {
    const base = file === "-" ? process.cwd() : path.dirname(path.resolve(file));
    const bars = loadBars(path.resolve(base, market.barsCsv));
    const ind = Core.indicatorsFromBars(bars);
    if (!ind.ok) throw new Error("日线不足");
    ["bbU", "bbM", "bbL", "ema20", "ema50", "ema200", "vol", "avgVol"].forEach((k) => { if (market[k] === undefined) market[k] = ind[k]; });
    if (market.price === undefined) market.price = ind.price;
    market.provenance = market.provenance || { market: { kind: "manual", ticker: market.ticker, source: "CSV: " + path.basename(market.barsCsv), barDate: ind.barDate } };
    delete market.barsCsv;
  }
  const report = Core.analyze({ market, position: req.position }, { includePosition: args.includes("--private"), now: req.now });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.status === "invalid" ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv); }
  catch (e) { process.stderr.write("错误：" + e.message + "\n"); process.exitCode = 2; }
}
module.exports = { main };
