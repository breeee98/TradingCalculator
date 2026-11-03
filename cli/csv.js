// 读取日线 CSV（测试和命令行共用）。支持三种格式：
//  1) Date,Open,High,Low,Close,Volume（列名可带前缀，如 AAPL.Close）
//  2) "date","close","volume","open","high","low"（倒序也可以，会自动按日期升序）
//  3) 只有收盘价的多列表：每列一个代码 + Date 列 → 用 loadCloseOnly(path, ticker)
"use strict";
const fs = require("fs");

function splitCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function num(s) { if (s === undefined || s === "") return null; const n = Number(String(s).replace(/,/g, "")); return Number.isFinite(n) ? n : null; }
function normDate(s) {
  const m = String(s).match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

function loadBars(path) {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/^.*\./, ""));
  const col = (name) => head.indexOf(name);
  const iD = col("date"), iO = col("open"), iH = col("high"), iL = col("low"), iC = col("close"), iV = col("volume");
  if (iD < 0 || iC < 0) throw new Error("CSV 缺少 date/close 列：" + path);
  const bars = [];
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    const date = normDate(c[iD]);
    if (!date) continue; // 跳过盘中快照等非日期行
    const close = num(c[iC]);
    if (close === null) continue;
    bars.push({ date, open: num(c[iO]), high: num(c[iH]), low: num(c[iL]), close, volume: iV >= 0 ? num(c[iV]) : null });
  }
  bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  return bars;
}

function loadCloseOnly(path, ticker) {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const head = splitCsvLine(lines[0]);
  const iD = head.findIndex((h) => h.toLowerCase() === "date"), iC = head.indexOf(ticker);
  if (iC < 0) throw new Error("没有这一列：" + ticker);
  return lines.slice(1).map((l) => splitCsvLine(l)).map((c) => ({ date: normDate(c[iD]), close: num(c[iC]), volume: null }))
    .filter((b) => b.date && b.close !== null).sort((a, b) => (a.date < b.date ? -1 : 1));
}

module.exports = { loadBars, loadCloseOnly, splitCsvLine };
