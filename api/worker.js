/**
 * TradingCalculator 只读分析接口（Cloudflare Worker）
 *
 * 和网页使用同一份 core.js。部署前需要你自己配置密钥（见 docs/API.md）：
 *   wrangler secret put TWELVE_DATA_API_KEY
 *   wrangler secret put POSITION_TOKEN        # 仅受保护的持仓接口需要
 *
 * 路由：
 *   GET  /v1/health                    健康检查
 *   GET  /v1/analysis?symbol=MU[&pcr=0.8&ivr=45&options_source=Barchart&options_time=2026-11-02]
 *                                      公开、只读。只接受行情与期权情绪参数，拒绝任何持仓/账户参数。
 *   POST /v1/position-analysis         受保护（Authorization: Bearer <POSITION_TOKEN>），
 *                                      body 里带持仓，返回止盈分析。不缓存、不记录、不存储。
 *   GET  /?symbol=MU                   兼容旧网页的行情格式，额外提供 price_time / indicator_date。
 *
 * 本服务不下单、不连接券商。
 */
import Core from "../core.js";

const TD = "https://api.twelvedata.com";
const PUBLIC_PARAMS = new Set(["symbol", "pcr", "ivr", "options_source", "options_time", "sell_basis"]);
const MAX_BODY = 32 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return preflight(request, env, url);
      if (url.pathname === "/v1/health" && request.method === "GET") {
        return json({ ok: true, engineVersion: Core.VERSION, schema: Core.SCHEMA }, 200, publicHeaders());
      }
      if (url.pathname === "/v1/analysis" && request.method === "GET") return await publicAnalysis(request, url, env, ctx);
      if (url.pathname === "/v1/position-analysis" && request.method === "POST") return await positionAnalysis(request, env);
      if (url.pathname === "/" && request.method === "GET" && url.searchParams.has("symbol")) return await legacy(request, url, env);
      return json({ error: "not_found", message: "没有这个接口。" }, 404, publicHeaders());
    } catch (e) {
      if (e && e.httpStatus) return json({ error: e.code, message: e.message }, e.httpStatus, url.pathname === "/v1/position-analysis" ? privateHeaders(request, env) : publicHeaders(request, env));
      // 不把内部错误细节（可能含上游 URL）返回给调用方
      return json({ error: "internal_error", message: "服务内部错误。" }, 500, publicHeaders());
    }
  }
};

// ------------------------------------------------------------------ 路由实现
async function publicAnalysis(request, url, env, ctx) {
  const extra = [...url.searchParams.keys()].filter((k) => !PUBLIC_PARAMS.has(k));
  if (extra.length) throw httpError(400, "unsupported_params", "公开接口只接受行情与期权情绪参数，不接受：" + extra.join(", ") + "。持仓分析请用受保护的 POST /v1/position-analysis。");
  const symbol = requireSymbol(url.searchParams.get("symbol"));

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const market = await loadMarket(symbol, env);
  const optionsIn = {
    pcr: url.searchParams.get("pcr"), ivr: url.searchParams.get("ivr"),
    source: url.searchParams.get("options_source"), time: url.searchParams.get("options_time")
  };
  const report = Core.analyze({ market: toCoreInput(symbol, market, optionsIn, url.searchParams.get("sell_basis")) });
  const res = json(report, 200, Object.assign(publicHeaders(request, env), { "Cache-Control": "public, max-age=60" }));
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function positionAnalysis(request, env) {
  const headers = privateHeaders(request, env);
  if (!env.POSITION_TOKEN) throw httpError(503, "disabled", "持仓接口未启用（没有配置 POSITION_TOKEN）。");
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !timingSafeEqual(token, env.POSITION_TOKEN)) throw httpError(401, "unauthorized", "未授权。");
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) throw httpError(413, "too_large", "请求体过大。");
  const text = await request.text();
  if (text.length > MAX_BODY) throw httpError(413, "too_large", "请求体过大。");
  let body;
  try { body = JSON.parse(text); } catch (e) { throw httpError(400, "bad_json", "请求体不是合法 JSON。"); }
  if (!body || typeof body !== "object" || !body.position) throw httpError(400, "missing_position", "缺少 position。");
  const symbol = requireSymbol(body.symbol || (body.position && body.position.ticker));
  const market = await loadMarket(symbol, env);
  const report = Core.analyze(
    { market: toCoreInput(symbol, market, body.options || {}, body.sellBasis), position: Object.assign({}, body.position, { ticker: symbol }) },
    { includePosition: true }
  );
  return json(report, 200, headers);
}

async function legacy(request, url, env) {
  const symbol = requireSymbol(url.searchParams.get("symbol"));
  const m = await loadMarket(symbol, env);
  return json({
    symbol, price: m.price, price_time: m.priceTime, source: m.source,
    Bollinger_Bands: { upper: m.ind.bbU, middle: m.ind.bbM, lower: m.ind.bbL, datetime: m.ind.barDate },
    EMA_20: m.ind.ema20, EMA_50: m.ind.ema50, EMA_200: m.ind.ema200,
    volume: m.ind.vol, average_volume_20: m.ind.avgVol,
    indicator_date: m.ind.barDate, partial_bar: false, is_market_open: m.isMarketOpen
  }, 200, publicHeaders(request, env));
}

// ------------------------------------------------------------------ 行情
/**
 * 一次 time_series（日线 300 根）+ 一次 quote（最新价与时间戳）。
 * 盘中时，今天这根日线还没走完：指标只用已完结的日线计算，避免盘中布林带/量比来回跳。
 */
async function loadMarket(symbol, env) {
  if (!env.TWELVE_DATA_API_KEY) throw httpError(500, "not_configured", "服务未配置行情密钥。");
  const q = (p) => new URLSearchParams(Object.assign({}, p, { apikey: env.TWELVE_DATA_API_KEY })).toString();
  const [ts, quote] = await Promise.all([
    tdFetch(TD + "/time_series?" + q({ symbol, interval: "1day", outputsize: "300", order: "ASC" })),
    tdFetch(TD + "/quote?" + q({ symbol }))
  ]);
  if (!ts || !Array.isArray(ts.values) || !ts.values.length) throw httpError(502, "upstream_empty", "行情服务没有返回日线数据。");
  if (ts.meta && ts.meta.symbol && String(ts.meta.symbol).toUpperCase() !== symbol) throw httpError(502, "upstream_mismatch", "行情服务返回的代码与请求不一致。");
  let bars = ts.values.map((v) => ({ date: String(v.datetime).slice(0, 10), open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: v.volume === undefined ? null : +v.volume }));
  const isOpen = quote && quote.is_market_open === true;
  const quoteDate = quote && quote.datetime ? String(quote.datetime).slice(0, 10) : null;
  let droppedPartial = false;
  if (isOpen && bars.length && bars[bars.length - 1].date === quoteDate) { bars = bars.slice(0, -1); droppedPartial = true; }
  const ind = Core.indicatorsFromBars(bars);
  if (!ind.ok) throw httpError(502, "upstream_short", "日线数量不足，无法计算指标。");
  const qp = quote ? Core.parseNum(quote.close) : null;
  const price = qp !== null && qp > 0 ? qp : ind.price;
  const ts0 = quote && quote.timestamp ? Core.parseTime(Number(quote.timestamp)) : null;
  return {
    price, priceTime: ts0 ? ts0.toISOString() : null, isMarketOpen: isOpen, droppedPartial,
    source: "Twelve Data（quote + 日线 time_series）", fetchedAt: new Date().toISOString(), ind
  };
}

function toCoreInput(symbol, m, opt, sellBasis) {
  const pcr = Core.parseNum(opt.pcr), ivr = Core.parseNum(opt.ivr);
  return {
    ticker: symbol, price: m.price,
    bbU: m.ind.bbU, bbM: m.ind.bbM, bbL: m.ind.bbL,
    ema20: m.ind.ema20, ema50: m.ind.ema50, ema200: m.ind.ema200,
    vol: m.ind.vol, avgVol: m.ind.avgVol,
    pcr, ivr,
    options: { sellBasis: sellBasis === "remaining" ? "remaining" : "initial" },
    provenance: {
      market: { kind: "api", ticker: symbol, source: m.source, fetchedAt: m.fetchedAt, priceTime: m.priceTime, barDate: m.ind.barDate, partialBar: false },
      options: pcr === null && ivr === null ? { kind: "unknown" } :
        { kind: "caller", ticker: symbol, source: opt.source ? String(opt.source).slice(0, 80) : "调用方提供", time: opt.time ? String(opt.time).slice(0, 40) : null }
    }
  };
}

async function tdFetch(u) {
  let r;
  try { r = await fetch(u, { headers: { Accept: "application/json" } }); }
  catch (e) { throw httpError(502, "upstream_unreachable", "无法连接行情服务。"); }
  let data;
  try { data = await r.json(); } catch (e) { throw httpError(502, "upstream_bad_json", "行情服务返回的不是 JSON。"); }
  if (!r.ok || (data && data.status === "error")) {
    const code = data && data.code;
    if (r.status === 429 || code === 429) throw httpError(429, "rate_limited", "行情服务请求次数已达上限，请稍后再试。");
    if (code === 400 || code === 404) throw httpError(404, "symbol_not_found", "行情服务找不到这个代码。");
    throw httpError(502, "upstream_error", "行情服务请求失败。");
  }
  return data;
}

// ------------------------------------------------------------------ 工具
function requireSymbol(s) {
  const t = Core.normTicker(s || "");
  if (!t || !Core.isValidTicker(t)) throw httpError(400, "bad_symbol", "symbol 无效。");
  return t;
}
function httpError(status, code, message) { const e = new Error(message); e.httpStatus = status; e.code = code; return e; }
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" }, headers || {}) });
}
function publicHeaders() {
  // 公开接口只读、无凭据，允许任意来源读取
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Cache-Control": "no-store" };
}
function privateHeaders(request, env) {
  const h = { "Cache-Control": "no-store, private", "Pragma": "no-cache" };
  // 默认不开放浏览器跨域：持仓接口应由服务端（如 Muse 的后端）调用
  const origin = request.headers.get("Origin");
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Vary"] = "Origin";
  }
  return h;
}
function preflight(request, env, url) {
  if (url.pathname === "/v1/position-analysis") {
    const origin = request.headers.get("Origin");
    if (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Vary": "Origin" } });
  }
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
