# Command Code 订阅套餐到期时间检查 设计

- 日期：2026-09-17
- 状态：已确认
- 项目：MOA Desktop
- 前置：`2026-08-27-commandcode-usage-monitoring-design.md`（云端用量监控 v1）

## 背景与目标

云监控页已有 Command Code 的额度窗口、月度余额、用量汇总与模型明细，但用户无法看到**所订阅套餐的到期时间**。本设计为 Command Code 源补上「订阅套餐」区块：套餐名、订阅状态、到期时间（剩余天数）、排定取消提示。

范围说明：本次仅完善 Command Code 来源；MiMo / DeepSeek 的同类能力后续按同一模式扩展（各源接口结构不同，解析不可复用）。

明确不做（YAGNI）：到期告警/通知、自动续费操作、账单历史、其他两个源。

## 外部接口（逆向确认）

来源：Studio 前端 JS bundle 静态分析（`commandcode.ai/assets/*.js`，2026-09-17）+ 无认证端点探针（401=存在 / 404=不存在）。

| 端点 | 认证 | 返回 | 探针 |
|---|---|---|---|
| `GET https://api.commandcode.ai/internal/billing/subscriptions?withPending=true` | Cookie `__Secure-commandcode_prod_.session_token` | `{ success: true, data: <subscription> \| null }`，无订阅时 `data: null` | 401 ✓ |
| `GET https://api.commandcode.ai/alpha/billing/subscriptions` | Bearer Provider API Key（与 `/alpha/billing/credits` 相同） | 待实测，防御性解析 | 401 ✓ |

subscription 对象字段（Studio 前端使用处确认）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `planId` | string | 如 `individual-pro` / `individual-goat` / `individual-max` / `teams-pro` |
| `status` | string | `active` / `trialing` / `past_due` / `canceled` / `inactive`（Studio 视 active/trialing/past_due 为有效活跃） |
| `currentPeriodEnd` | ISO 字符串 | **套餐到期时间**；Studio 用 UTC 口径显示（`timeZone:"UTC"`） |
| `cancelAt` | ISO/null | 非空 → 已排定取消（到期后不续费），UI 显示 "Cancels <日期>" |
| `pendingPhase` | 对象 | 计划变更过渡：`{ unitAmount, currency, effectiveDate(epoch 秒) }` |
| `createdAt` / `metadata` | — | Studio 内部升级逻辑用，本功能不展示 |

planId → 展示名（取自 Studio 套餐层级常量）：go→Go、goat→GOAT、pro/pro-v1→Pro、provider→Provider、max→Max 10×、ultra→Max 20×、teams-pro→Teams Pro；未知 ID 原样显示。

## 数据模型（`src/shared/types.ts`）

```ts
interface CommandCodeSubscription {
  planId?: string
  status?: string
  currentPeriodEnd?: string      // ISO 原样保留
  currentPeriodEndTs?: number    // epoch 秒，归一化（兼容 ISO / 秒 / 毫秒）
  cancelScheduled?: boolean
  cancelAtTs?: number            // epoch 秒
  pendingPhase?: { unitAmount?: number; currency?: string; effectiveDateTs?: number }
}
```

`CommandCodeUsage` 扩展：`subscription?: CommandCodeSubscription`；`sourcesAvailable` 增加 `subscription: boolean`。

三态语义：
- `sourcesAvailable.subscription=false` → 区块不可用（端点失败/结构无法识别）→ UI「暂无数据」
- `=true` 且 `subscription` absent → 明确无订阅（`data:null`）→ UI「未订阅套餐」
- `=true` 且有 `subscription` → 正常展示

## 拉取与解析（`src/main/monitoring/commandCode.ts`）

- 请求数组新增两项：`/internal/billing/subscriptions?withPending=true`（Cookie）与 `/alpha/billing/subscriptions`（API Key，可选）；401/403 判定扩展为对全部响应检查。
- Cookie 端点为主，API Key 端点兜底（内部端点解析失败时才尝试）。
- 解析策略（沿用既有防御性风格）：
  - `success:false` → 解析失败（区块不可用）；`data:null` → 明确无订阅
  - 兼容数组形态（多订阅取 active/trialing 优先，否则首项）、`{ data: { subscription } }` 嵌套、snake_case 字段名
  - 时间字段归一化为 **epoch 秒**（与 `UsageWindowInfo.resetAt` 一致）：ISO 字符串 / 数字（>1e12 视为毫秒）均可

## UI（`CloudMonitorView.tsx` → `CommandCodePanel`）

「订阅套餐」section 置于「额度」之前，3 卡网格（与现有卡片同风格）：

1. **当前套餐**：展示名（大字）+ planId（小字，geek 风格）
2. **订阅状态**：中文文案（使用中/试用中/逾期未付/已取消/未激活）+ 颜色（active/trialing 绿、past_due 红、其余灰）；有 pendingPhase 时附「套餐将于 <日期> 变更」
3. **到期时间**：UTC 日期（与 Studio 一致，避免时区差一天）+ 副文案：
   - 已排定取消 → 「已排定取消，到期后不再续费」（黄）
   - 已过期 → 「已到期」（红）
   - 剩余 ≤7 天 → 「剩余 N 天，即将到期」（红）
   - 其他 → 「剩余 N 天，到期自动续费」（灰）

无订阅/不可用时的空态同现有卡片风格（居中灰字）。

## 文件清单

修改：
- `src/shared/types.ts` — CommandCodeSubscription + CommandCodeUsage.sourcesAvailable 扩展
- `src/main/monitoring/commandCode.ts` — 订阅拉取 + 解析 + 组装
- `src/renderer/src/components/CloudMonitorView.tsx` — 订阅 section

不改：IPC 通道 / preload / defaults / key-store（`monitor:refresh` 返回整体 usage 对象，新字段自动透传）。

## 验证

- `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
- `npm run build`
- 手动：登录后刷新 → 订阅卡显示套餐/状态/到期时间；无订阅账号显示空态；伪造未知 planId/缺失字段不崩（防御性解析）
