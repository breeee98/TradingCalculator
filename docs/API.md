# 只读 JSON 分析接口（给 Muse 或其他程序调用）

> **当前状态：代码已写好并通过测试，但还没有部署。** 现有网页继续使用原来的 `trading-api.duyuqin1998.workers.dev`，它没有被改动。Muse 目前**没有**接上任何接口。

## 1. 三个接口

| 接口 | 用途 | 是否需要授权 | 是否涉及持仓 |
|---|---|---|---|
| `GET /v1/analysis?symbol=MU` | 公开分析：阶梯价格、区域、候选条件、评分、警告 | 不需要 | **不涉及**，带持仓参数会被拒绝（HTTP 400） |
| `POST /v1/position-analysis` | 止盈分析：候选止盈价、建议股数、金额、利润、剩余风险 | `Authorization: Bearer <POSITION_TOKEN>` | 持仓放在请求体里，服务端不缓存、不存储、不记日志 |
| `GET /?symbol=MU` | 兼容旧网页的行情格式，多了 `price_time`、`indicator_date` | 不需要 | 不涉及 |

公开接口可选参数（只有这些，其他参数一律拒绝）：

- `pcr`：Put/Call 成交量比；`ivr`：IV Rank（0–100）。都是可选辅助：可以只传一个或都不传，不传就完全按技术面计算；`0` 会作为真实数值保留；无效值跳过并在 `warnings` 里说明。期权数据不改变任何价格点位，只对仓位比例做 ±5% 以内的相对调整。
- `options_source`、`options_time`：期权数据的来源和时间，会原样写进输出的 `data.options`。
- `sell_basis`：`initial`（默认，以初始持仓为基数）或 `remaining`（以剩余持仓为基数）。

受保护接口请求体：

```json
{
  "symbol": "MU",
  "options": { "pcr": 0.85, "ivr": 48, "source": "Barchart", "time": "2026-11-02 收盘" },
  "sellBasis": "initial",
  "position": {
    "accountType": "swing",
    "shares": 15,
    "avgCost": 98.5,
    "sales": [{ "date": "2026-10-20", "shares": 2, "price": 120, "tier": "D1" }],
    "events": [{ "date": "2026-12-17", "type": "earnings", "label": "财报" }],
    "exitPlan": { "text": "跌破 EMA50 减半", "targets": [135], "keepCorePct": 30 }
  }
}
```

## 2. 输出结构（schema `tradingcalculator.analysis.v1`）

网页第 5 节“复制 JSON”、命令行 `cli/analyze.js` 和接口输出完全相同的结构：

| 字段 | 内容 |
|---|---|
| `ticker`、`generatedAt`、`engineVersion`、`status` | `status`：`ok` / `degraded`（能算但有错误，如数据串号）/ `invalid`（核心输入无效，不出价格） |
| `data.price` | 现价、来源、行情时间戳、距今分钟数、是否超过 15 分钟 |
| `data.dailyIndicators` | 日线指标最后一根 K 线日期、是否陈旧、是否盘中未完结 |
| `data.options` | 期权数据来源、时间、所属代码 |
| `inputs.<字段>` | 每个输入的数值与状态：`ok` / `missing` / `invalid` |
| `ladder[]` | A1–E2 价格，每档 `basePct`、`multiplier`、`effectivePct`（占计划基数）、`cumulativePct`、`ofRemainingPct`、`capped` |
| `currentZone` | 现价位于哪两档之间、最接近哪一档、是否超出阶梯 |
| `candidates[]` | 触发的候选条件（到达某档、放量、Put/Call 偏低/偏高、IV 偏高、均线排列……），每条带证据 |
| `scores.trend` | 趋势：EMA 排列与依据 |
| `scores.technical` | 技术面仓位乘数（成交量，主要依据）及理由 |
| `scores.optionsAux` | 期权情绪（可选辅助）：`used[]` 参与判断的项目、`skipped[]` 跳过的项目及原因（未填写 / 无效值 / 属于其他股票）、`buyAdjPct` / `sellAdjPct` 相对调整（−5 至 +5）、`mode`（`technicalOnly` 或 `technical+optionsAux`） |
| `scores.final` | 最终仓位乘数 = 技术面乘数 × (1 + 期权相对调整%)；C 档不调整 |
| `takeProfit` | 只在受保护接口出现：每档判断（建议减仓 / 可考虑减仓 / 继续持有 / 未触及 / 无需操作 / 已完成）、理由、股数、金额、利润、剩余风险，以及始终存在的三个选项 `trim` / `hold` / `noAction` |
| `errors[]` / `warnings[]` / `limitations[]` | 数据缺失、过期、串号和模型局限 |

完整示例：`node cli/analyze.js examples/request.public.json`。

## 3. 部署（需要你自己操作，我没有你的 Cloudflare 权限）

```bash
cd api
cp wrangler.toml.example wrangler.toml
npx wrangler secret put TWELVE_DATA_API_KEY   # 你的 Twelve Data key，只存在 Cloudflare
npx wrangler secret put POSITION_TOKEN        # 可选，启用持仓接口；用 32 位以上随机字符串
npx wrangler deploy
```

- 部署成新的 Worker（例如 `tradingcalculator-api`），不会影响现有的 `trading-api`。
- 每次请求消耗 2 次 Twelve Data 调用（日线 + 报价），公开接口结果缓存 60 秒。
- 盘中时，今天这根未走完的日线不参与指标计算，避免布林带和量比盘中来回跳；现价用实时报价并带时间戳。
- 如果想让现有网页也显示真实的行情时间：把网页里的 `API_URL` 改成新 Worker 的根地址（`GET /?symbol=` 兼容旧格式），或者在旧 Worker 返回里加上 `price_time`、`indicator_date`、`partial_bar` 三个字段，网页会自动读取。

## 4. Muse 怎么接（需要你确认 Muse 的运行环境）

我不知道 Muse 跑在哪里、能用哪些工具，所以没有假设它已经接通。按 Muse 的能力选一种：

1. **Muse 能发 HTTP 请求**（有 web fetch / HTTP 工具）：部署后把 `https://<你的worker>.workers.dev/v1/analysis?symbol=MU` 给它。如果 Muse 所在平台有域名白名单，需要把 `*.workers.dev`（或你的自定义域名）加进去。
2. **要分析持仓**：只有当 Muse 有**服务端的密钥存储**时，才把 `POSITION_TOKEN` 放进去，由 Muse 的后端调用 `POST /v1/position-analysis`。不要把 token 写进对话、提示词、Notion 页面或网页代码。如果 Muse 只是一个聊天界面、没有安全的密钥存储，就不要给它 token，改用第 3 种。
3. **暂时手动**：在网页第 5 节点“复制公开分析 JSON”（或“含持仓 JSON”），贴给 Muse。零部署，立即可用。
4. **Muse 能运行命令**：`node cli/analyze.js input.json [--private]`，完全离线。
5. **Muse 支持 MCP 工具**：可以再写一个很薄的 MCP 包装调用上面的接口——这部分还没做。

## 5. 隐私与安全

- 公开接口不接受也不返回任何持仓/账户字段；Twelve Data key 只在 Worker 环境变量里，测试确认不会出现在任何响应中。
- 持仓接口：Bearer token 常数时间比较；默认不开放浏览器跨域（应由服务端调用）；`Cache-Control: no-store`；请求体上限 32 KB。
- 网页里的持仓只存在浏览器 localStorage（按股票代码分开），不会被上传、不会进快照、不会进“公开 JSON”。
- 整个项目不下单、不连接券商账户。
