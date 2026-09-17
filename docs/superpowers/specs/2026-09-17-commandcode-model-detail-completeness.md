# Command Code 模型明细完整性修复 设计

- 日期：2026-09-17
- 状态：已实施
- 项目：MOA Desktop
- 前置：`2026-08-27-commandcode-usage-monitoring-design.md`（云端用量监控 v1）、`2026-09-17-commandcode-subscription-expiry-design.md`

## 背景与目标

云监控页 Command Code 面板的「模型明细」表显示不全：早期用过的模型直接消失，各模型的请求数 / Tokens / 成本系统性偏低。

本设计定位根因并修复，使明细尽可能覆盖服务端保留窗口内的全部请求记录，同时**如实标注覆盖范围**（不做"看起来完整"的假象）。

## 根因（Studio 前端 bundle 静态分析确认）

来源：`https://commandcode.ai/assets/*.js`（105+ chunk 全量下载后反查，2026-09-17）。

### R1 只取了最近 100 条记录（主因）

v1 实现固定请求 `/internal/usage?limit=100`，模型明细是把这 100 条记录按模型聚合。

Studio 用量表的真实契约（`usage-BWG6ae2F.js`）：

```js
async function It(e = {}) {
  const { limit = 10, cursor, orgId, targetUserId } = e
  const o = new URLSearchParams({ limit: r.toString() })
  cursor && o.append('cursor', cursor)
  ...
  return await (await fetch(`${ht.USAGE_LIST}?${o}`, { credentials: 'include' })).json()
}
```

- 页大小白名单：`pagination-Bz6Vo--U.js` 中 `const p = [10, 25, 50, 100]`（10 为默认）→ **单页上限 100**。
- 响应结构：`{ usages: [...], window: { days }, nextCursor: string | null }`，`nextCursor` 非 null 表示还有更早的记录（UI 的 "Older" 按钮即用它翻页）。
- `window.days` 是**服务端记录保留窗口**：UI 文案 `Mn(e) = e ? (e.days === 1 ? 'the last 24 hours' : 'the last N days') : "your plan's recent-activity window"`。

结论：必须**游标翻页**才能拿到窗口内的全部记录；只取 100 条会漏掉更早的模型与请求。

### R2 无 `meta.model` 的记录被整条丢弃

v1 在 `parseUsageRecord` 中拿不到模型名时 `return undefined`。Studio 的显示口径是：

```js
// 模型列：xn[e.mode] ?? e.meta?.model ?? '-'
const xn = { learning: 'taste-1', 'web-search': 'web-search', 'web-fetch': 'web-fetch' }
```

即 `learning` / `web-search` / `web-fetch` 这类 mode 记录本应展示，却被我们整条丢弃（请求数、tokens 全部不计入）。

### R3 成本字段口径与 Studio 不一致

```js
const sn = e => e.meta?.totalCost != null
  ? ie(e.meta.totalCost)
  : ie(e.meta?.inputCost) + ie(e.meta?.outputCost) + ie(e.meta?.cacheCost)
```

Studio 行成本是**美元**的 `meta.totalCost`（缺失时分项求和）；v1 优先取 `creditsTotal`，与「汇总」卡片的 `totalCost`（美元）口径不同，两处数字无法对上。

### 已排除的替代方案（避免走弯路）

| 方案 | 结论 |
|---|---|
| `/internal/usage/charts` | 常量 `USAGE.CHARTS` 在 constants 中定义，但**全站 bundle 无任何调用点**，响应结构无法确认 → 不采用（不猜测接口） |
| `/internal/orgs/:id/analytics?from=&to=` | 返回 `{ models: [{ model, modelLabel, spend }] }`，但面向**组织管理员的 Team analytics**（"Last 30 days across all members"），个人账号不适用且只有花费、无请求数/tokens → 不采用 |
| 服务端是否另有个聚合端点 | 客户端可触达的用量端点只有 `USAGE.LIST` / `USAGE.SUMMARY`（+ ALPHA 计费端点），无 per-model 聚合端点 → 只能客户端聚合 |

## 决策

### D1 游标分页拉取（`fetchUsageRecords`）

- 页大小 `USAGE_PAGE_SIZE = 100`（服务端白名单上限，尽量减少请求数）。
- 逐页串行（游标必须依赖上一页），首页与其余 5 个端点**并行**推进，避免串行叠加延迟。
- 上限保护：`USAGE_MAX_PAGES = 20`（≤2000 条记录）、`USAGE_PAGE_BUDGET_MS = 12_000`（总耗时预算）。超限即停止翻页并把已取记录照常聚合，同时置 `truncated = true`。
- 失败语义分层：
  - **首页**失败（网络 / 非 200 / 结构不可识别）→ 返回 `status` 交调用方处理（401/403 → `session_expired`；其余 → 明细区块不可用，不误报）。
  - **后续页**失败 → **保留已取记录**并置 `truncated = true`（不丢数据、不谎报完整）。

### D2 模型名回退（消除整条丢弃）

`meta.model` / `meta.modelName` / 顶层 `model` 优先（保持 v1 的细粒度分组），都缺失时按 Studio 口径回退 `CC_MODE_LABELS[mode] ?? mode`。仅当既无模型名也无 mode 时才丢弃记录。

### D3 成本口径对齐 Studio

`meta.totalCost` → `inputCost + outputCost + cacheCost`（存在任意分项时求和）→ `creditsTotal`（顶层）→ `meta.planPoolDraw` → `raw.cost` → 0。

前两级为美元口径，与 Studio 行成本、「汇总」卡片一致；后三级仅作最后兜底（单位可能不同，已在注释中标注）。

### D4 覆盖范围透明化（`modelsCoverage`）

新增字段（`src/shared/types.ts`）：

```ts
modelsCoverage?: {
  records: number      // 已聚合的请求记录条数
  truncated: boolean   // 仍有更早记录未纳入（页数/耗时上限，或后续页失败）
  windowDays?: number  // 服务端记录保留窗口天数（响应 window.days）
}
```

UI 在「模型明细」标题右侧显示：

```
基于 2,000 条请求记录聚合 · 服务端保留窗口 30 天 · 汇总共 5,431 条请求（更早记录未纳入）
```

- `truncated === true` 或 `summary.totalCount > coverage.records` → 文案变黄并提示"更早记录未纳入"（`title` 里说明明细与汇总口径差异）。
- 未达上限时保持 muted 灰，不制造噪音。

## 文件清单

修改：
- `src/shared/types.ts` — `CommandCodeUsage.modelsCoverage`
- `src/main/monitoring/commandCode.ts` — 分页拉取、模型名回退、成本口径、覆盖信息、日志增强
- `src/renderer/src/components/CloudMonitorView.tsx` — 明细覆盖说明行

无新增依赖。

## 验证

- `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json` ✅
- `npm run build` ✅（electron-vite，3.16s）
- 行为级测试：从 `commandCode.ts` 抽取纯函数 + 分页逻辑（esbuild 转译），注入假 `ccGet` 跑 40 条断言 ✅
  - 多页翻页：cursor 传递、记录合并、跨页模型累加、末页 `nextCursor=null` 不计截断
  - 页数上限 → `truncated=true`
  - 后续页网络异常 / 500 → 保留已取记录 + `truncated=true`；首页网络异常 → `status=null`；首页 401 → 透传
  - 模型名回退（learning→taste-1、web-search、未知 mode 原样）
  - 成本优先级（`meta.totalCost` > 分项求和 > `creditsTotal` 兜底）
  - 响应形态兼容（根部数组 / `usages` / `items` / `data.usages` / 结构不可识别 → null）
- 尚未做：带真实账号的实机刷新（需用户登录态，未提取任何凭证）。主进程日志已增强，可在应用中确认：

```
[Monitor] refresh(commandcode): summary=200 credits=200 windows=200 subscription=200 subAlpha=200 | usage=200 pages=3 records=280
```

`pages > 1` 即证明翻页生效；`records` 应与明细覆盖文案一致。

### 实机验证（2026-09-17，用户账号 individual-goat）

在应用内经 `window.moaAPI.monitorRefresh` 真实调用 + CDP 读回（未提取任何凭证，复用应用自身登录态）：

主进程日志（`MOA_MONITOR_DEBUG=1`）：

```
[Monitor] usage page 1: usages=100 nextCursor=absent window=1 rootKeys=usages,nextCursor,limit,periodBasis,window
[Monitor] refresh(commandcode): summary=200 credits=200 windows=null subscription=200 subAlpha=null | usage=200 pages=1 records=100
```

结论：

1. **解析路径正确**：响应根结构确为 `{ usages, nextCursor, limit, periodBasis, window }`，`nextCursor` 字段真实存在于响应中（本次为空 → 无下一页），`window.days = 1`。
2. **未翻页 ≠ 漏翻页**：服务端明确返回无下一页，说明 **100 条已是该账号保留窗口（1 天）内服务端提供的全部记录**。该账号 GOAT 套餐对应 "Limited usage analytics"，列表能力受套餐限制。
3. 端到端耗时：一次完整刷新 ~2.0s（100 条记录 / 1 页）。

UI 实际渲染（CDP 读 DOM）：

```
模型明细
基于 100 条请求记录聚合 · 服务端保留窗口 1 天 · 汇总共 516 条请求（更早记录未纳入）
模型                            请求数  ↑ 输入    ↓ 输出   总 Tokens   成本
deepseek/deepseek-v4.1-flash    100     9.3M     69.3k    9.3M        ¥1.17
```

即"汇总 516 条 vs 明细 100 条"的差异现在被显式说明，而不再是无解释的缺口 —— 这正是用户报告的"明细显示不全"的可感知成因。

### 诊断开关

`MOA_MONITOR_DEBUG=1` 启动应用时，每页打印响应结构（页号 / 记录数 / 游标有无 / 窗口天数 / 根字段名），用于后续排查服务端字段或分页行为变化。默认关闭，无副作用。

## 已知限制

- **服务端保留窗口 + 套餐上限是硬边界**：实测该账号 `window.days = 1`，且服务端在返回 100 条后即 `nextCursor` 为空 —— 明细最多只能覆盖这段时间内服务端提供的记录，客户端无法补齐（GOAT 套餐对应 "Limited usage analytics"）。UI 已显式标注记录数、窗口天数与"更早记录未纳入"。
- 分页上限（20 页 / 12s）是**性能与完整性的折中**：记录数超过 2000 条时明细仍会截断，此时 UI 明确标注。
- 明细与「汇总」卡片的数据源不同（明细=请求记录聚合，汇总=服务端 summary 接口，实测前者 100 条 / 后者 516 条），两者合计可能仍有差异；UI 已注明口径。
- 响应中的 `periodBasis` 字段（实测出现）含义未确认，暂未解析；它可能与"汇总"的统计周期有关，若后续需要进一步解释口径差异可再研究。

## 追加实测（2026-09-17 10:00，用户反馈「模型明细不涨」）

### 现象

用户持续使用后模型明细的请求数 / Tokens / 成本停滞在 100 条对应的数值，不随使用增长。

### 取证

| 手段 | 结果 |
|---|---|
| 页大小试探（`limit=500`） | **HTTP 400**（服务端拒绝）→ 100 条是服务端白名单硬上限，无法通过加大 limit 多拿记录 |
| 聚合记录时间跨度（`coverage.fromTs/toTs`） | 100 条仅覆盖 **≈21.5 分钟**（`toTs - fromTs = 1,288,000 ms`），而 `window.days = 1` 声称窗口为 24h |
| `summary.totalCount` | 566（同期），远大于明细的 100 条 |

### 结论

`/internal/usage` 对**该套餐账号**（GOAT / "Limited usage analytics"）恒定只返回**最近 100 条**记录且不给游标：明细表达的是"最近约 20 分钟"，不是窗口内全量、更不是累计量 —— 所以数字看起来"不涨"（实际在滚动替换）。这是服务端套餐限制，不是本地解析缺陷；加大 limit 已被实测证伪（400）。

### 已实现的应对（本次）

1. `coverage` 增加 `fromTs` / `toTs`，UI 覆盖行显示实际时间跨度（如 `覆盖 09-17 10:02 ~ 10:23`），让"这是滚动窗口"一眼可见。
2. 「拿满一页且无游标」时自动用 `limit=500` 复探一次（自适应）：服务端若放宽即可自动获得更长跨度；被拒（400）或结果不更多时静默沿用原结果（不改变行为）。日志：`usage probe limit=500 → status=400，沿用 100 条`。

### 已定方案与实现：A+ 本地累计 + 后台定时采集（2026-09-17）

用户决策：需要"明细能持续增长"，且接受为完整性增加后台采集。实现：

| 部件 | 内容 |
|---|---|
| 表 `cc_usage_records` | 主键 `(source_id, record_id)` → `INSERT OR IGNORE` 天然去重；字段含记录时间 `created_at` 与首次采集时间 `first_seen_at` |
| `monitoring/usageAccumulator.ts` | `persistUsageRecords`（幂等累积，逐条插入，单条失败不影响其余）/ `getCumulativeUsage`（按模型聚合 + 起止时间 + sinceTs + lastCollectedAt）/ `clearCumulativeUsage` |
| `monitoring/collector.ts` | 应用运行期后台采集：启动 15s 后首跑，其后每分钟检查、按设置间隔（默认 15 分钟，可选 5/10/15/30/60，0=关闭）执行；**与手动刷新共用 `refreshCommandCodeUsage`**（同走 fetchProxy/代理设置） |
| `commandCode.ts` | 记录解析新增 `id` / `createdAtMs`（服务端无 id 时用「时间\|模型\|tokens\|成本」合成，保证去重可复现）；刷新成功后落库；页大小探针加 **6 小时冷却**（该账号恒定 400，避免每次刷新白打一个请求） |
| IPC / preload | `monitor:getCumulative`、`monitor:collectorStatus` |
| UI | 明细口径切换「本地累计（默认）/ 云端窗口」+ 后台采集开关与间隔；累计行显示条数、起始时间、最近记录时间、采集状态与口径说明 |

**踩坑（已修）**：DB 里的 `app_settings` 只保存用户改过的字段，`monitoring` 常常整体缺失（渲染层靠 `DEFAULT_SETTINGS` 合并才显示三个面板）→ 后台采集若只读原始值则 `sources` 为空、永不启用。修复：collector 做同样的默认值合并（**仅字段缺失时**回退默认；显式空数组视为用户主动清空）。

**实机证据（用户账号，2026-09-17 10:25）**：采集成功落库

```
表存在: cc_usage_records
累计记录: 100 条
  记录时间范围: 2026/9/17 09:51:40 ~ 10:20:23     ← 覆盖 28.7 分钟真实记录
  首次采集: 10:25:36   最近采集: 10:25:36
  · deepseek/deepseek-v4.1-flash: req=100 cost=$0.3558 tok=22,459,098
重复 record_id 组数: 0                            ← 去重生效
```

**已知偏差（已修）**：端到端延迟一次"服务端对鉴权请求整体超时"的窗口（未鉴权请求 401 秒回、同一份代码 12 分钟前正常）。该窗口暴露了一个真实缺陷：**区块级降级会把"网络全挂"伪装成成功**（`ok:true` + 各区块 false）→ 页面显示空数据而非错误条，用户分不清是网络问题还是真没用量。

修复：新增纯函数 `classifyTotalFailure`（在 refresh 汇总处调用）

- 有任一区块拿到数据 → 不算失败（保持区块级降级）
- 所有区块都空 + 明细首页网络异常 / 必发端点被 reject / 必发端点无状态 → `{ ok:false, code:'network' }`
- 所有区块都空 + 全部 HTTP ≥ 400 → `{ ok:false, code:'unknown' }`
- 所有端点 200 但确实无数据（空白账号）→ 不算失败（保持空态）

顺带收益：后台采集器现在会把 `network` 记为 `lastError`，UI 采集行会显示"最近一次采集失败（network）"而不是静默成功。

### 已排除的其他方案

- **B 本地代理日志口径**：`request_logs` 只有请求级 `cost` + `models`（TEXT），**无法按模型拆分成本**，做不出真正的按模型明细。
- **C 仅文案**：不满足"想看到增长"的诉求。
- **加大 limit**：实测服务端 400 拒绝，已证伪。
