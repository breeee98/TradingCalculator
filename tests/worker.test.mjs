// 接口测试：模拟 Twelve Data 返回，验证路由、公开/受保护的边界、隐私与错误处理
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { loadBars } = require("../cli/csv.js");
const worker = (await import("../api/worker.js")).default;

const bars = loadBars(new URL("./fixtures/aapl_2015_2017.csv", import.meta.url).pathname);
const ENV = { TWELVE_DATA_API_KEY: "test-key-should-never-leak", POSITION_TOKEN: "s3cret-token-0123456789" };
let calls = [];
function mockTwelveData({ marketOpen = false, symbol = "AAPL", fail = null } = {}) {
  calls = [];
  globalThis.fetch = async (u) => {
    calls.push(String(u));
    const url = new URL(u);
    if (fail) return new Response(JSON.stringify({ status: "error", code: fail, message: "upstream says no (apikey=" + url.searchParams.get("apikey") + ")" }), { status: fail === 429 ? 429 : 200 });
    if (url.pathname === "/time_series") {
      const values = bars.map((b) => ({ datetime: b.date, open: String(b.open), high: String(b.high), low: String(b.low), close: String(b.close), volume: String(b.volume) }));
      return new Response(JSON.stringify({ meta: { symbol }, values, status: "ok" }));
    }
    if (url.pathname === "/quote") {
      const last = bars[bars.length - 1];
      return new Response(JSON.stringify({ symbol, datetime: last.date, timestamp: Math.floor(Date.now() / 1000) - 60, close: String(last.close + 1), is_market_open: marketOpen }));
    }
    return new Response("{}", { status: 404 });
  };
}
const req = (path, init) => new Request("https://api.example.test" + path, init);

test("GET /v1/analysis：公开只读，返回统一 schema，不泄露密钥", async () => {
  mockTwelveData();
  const r = await worker.fetch(req("/v1/analysis?symbol=aapl&pcr=0.9&ivr=40&options_source=Barchart"), ENV, {});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  const text = await r.text();
  assert.ok(!text.includes(ENV.TWELVE_DATA_API_KEY));
  const j = JSON.parse(text);
  assert.equal(j.schema, "tradingcalculator.analysis.v1");
  assert.equal(j.ticker, "AAPL");
  assert.equal(j.ladder.length, 11);
  assert.equal(j.inputs.pcr.value, 0.9);
  assert.equal(j.data.options.source, "Barchart");
  assert.ok(j.data.price.time, "价格时间戳来自 quote.timestamp");
  assert.equal(j.data.dailyIndicators.barDate, "2017-02-16");
  assert.equal(j.takeProfit, null);
  assert.equal(calls.length, 2, "一次 time_series + 一次 quote");
});

test("GET /v1/analysis：拒绝任何持仓/账户参数", async () => {
  mockTwelveData();
  for (const q of ["shares=100", "avgCost=80", "position=x", "token=abc"]) {
    const r = await worker.fetch(req("/v1/analysis?symbol=AAPL&" + q), ENV, {});
    assert.equal(r.status, 400, q);
  }
  assert.equal(calls.length, 0, "被拒绝的请求不应调用上游");
});

test("盘中：今天未完结的日线不参与指标计算", async () => {
  mockTwelveData({ marketOpen: true });
  const r = await worker.fetch(req("/v1/analysis?symbol=AAPL"), ENV, {});
  const j = await r.json();
  assert.equal(j.data.dailyIndicators.barDate, "2017-02-15");
});

test("POST /v1/position-analysis：没有或错误的 token 一律 401；正确 token 返回止盈分析且不缓存", async () => {
  mockTwelveData();
  const body = JSON.stringify({ symbol: "AAPL", options: { pcr: 0.6 }, position: { shares: 50, avgCost: 110, accountType: "swing" } });
  for (const auth of [null, "Bearer wrong", "Basic abc"]) {
    const h = { "Content-Type": "application/json" }; if (auth) h.Authorization = auth;
    const r = await worker.fetch(req("/v1/position-analysis", { method: "POST", headers: h, body }), ENV, {});
    assert.equal(r.status, 401);
  }
  const ok = await worker.fetch(req("/v1/position-analysis", { method: "POST", headers: { Authorization: "Bearer " + ENV.POSITION_TOKEN, "Content-Type": "application/json" }, body }), ENV, {});
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control"), /no-store/);
  assert.equal(ok.headers.get("access-control-allow-origin"), null, "默认不开放浏览器跨域");
  const j = await ok.json();
  assert.ok(j.takeProfit && j.takeProfit.ok, JSON.stringify(j.takeProfit && j.takeProfit.errors));
  assert.equal(j.takeProfit.ticker, "AAPL");
});

test("POST：未配置 POSITION_TOKEN 时接口关闭", async () => {
  mockTwelveData();
  const r = await worker.fetch(req("/v1/position-analysis", { method: "POST", headers: { Authorization: "Bearer x" }, body: "{}" }), { TWELVE_DATA_API_KEY: "k" }, {});
  assert.equal(r.status, 503);
});

test("上游错误：限流 → 429；错误信息里不带上游原文/密钥", async () => {
  mockTwelveData({ fail: 429 });
  const r = await worker.fetch(req("/v1/analysis?symbol=AAPL"), ENV, {});
  assert.equal(r.status, 429);
  const t = await r.text();
  assert.ok(!t.includes(ENV.TWELVE_DATA_API_KEY));
  assert.ok(!t.includes("upstream says no"));
});

test("上游返回的代码不一致 → 拒绝", async () => {
  mockTwelveData({ symbol: "MSFT" });
  const r = await worker.fetch(req("/v1/analysis?symbol=AAPL"), ENV, {});
  assert.equal(r.status, 502);
});

test("兼容旧网页：GET /?symbol= 返回旧字段 + 时间字段", async () => {
  mockTwelveData();
  const j = await (await worker.fetch(req("/?symbol=AAPL"), ENV, {})).json();
  for (const k of ["symbol", "price", "EMA_20", "EMA_50", "EMA_200", "volume", "average_volume_20", "price_time", "indicator_date"]) assert.ok(k in j, k);
  assert.ok(j.Bollinger_Bands.upper > j.Bollinger_Bands.lower);
});

test("非法 symbol → 400", async () => {
  mockTwelveData();
  const r = await worker.fetch(req("/v1/analysis?symbol=" + encodeURIComponent("<script>")), ENV, {});
  assert.equal(r.status, 400);
});
