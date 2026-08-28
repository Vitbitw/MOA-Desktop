# Command Code 云端用量监控功能设计

- 日期：2026-08-27
- 状态：已确认（v1）
- 项目：MOA Desktop

## 背景与目标

MoA Desktop 已有本地用量统计（`request_logs` 表 + 用量页），但用户还需要监控 **Command Code 云端账号**（`https://commandcode.ai/studio`）的用量：总请求/成本/tokens、每月额度余额、5小时/7天滚动窗口额度、按模型拆分明细。

目标：侧边栏新增「云监控」独立入口，登录 Command Code 后实时展示上述数据，支持手动/自动刷新。

明确不做（YAGNI）：历史数据落库、告警、多监控源实现（仅预置一个 Command Code 源，架构上预留扩展）、图表可视化。

## 现状盘点

| 项 | 状态 |
|---|---|
| 本地用量统计（request_logs + 用量页） | ✅ 已有 |
| key-store（safeStorage 加密落盘） | ✅ 已有，可扩展存凭证 |
| 代理感知 fetchProxy | ✅ 已有，云端请求应复用 |
| Command Code API | 外部接口，需逆向：`/internal/*` 用 session cookie，`/alpha/billing/credits` 用 Provider API Key |

## 外部接口（已逆向确认）

| 端点 | 认证 | 返回 |
|---|---|---|
| `GET https://api.commandcode.ai/internal/usage/summary` | Cookie `__Secure-commandcode_prod_.session_token` | `{ totalCount, totalCost, totalTokens, successRate }` |
| `GET https://api.commandcode.ai/internal/usage?limit=N` | 同上 | 用量请求记录列表（`{ usages: [{ id, createdAt, tokensIn, tokensOut, tokensTotal, creditsTotal, meta: { model, provider, planId, totalCost } }] }`），按 model 聚合为模型明细 |
| `GET https://api.commandcode.ai/internal/billing/credits` | 同上 | `{ credits: { monthlyCredits } }` |
| `GET https://api.commandcode.ai/alpha/billing/credits` | Bearer API Key（可选） | 5h/7d 窗口（`used_percent`/`reset_at` 等，字段需防御性解析）+ 月度余额 |

窗口数据字段名不完全确定，实现时对 `used_percent` / `percent` / `reset_at` / `resetAt` / `resets_at` 等多种形态做防御性解析；拿不到则隐藏对应卡片。

## 架构决策

### D1 监控源抽象

新增类型 `RemoteUsageSource`，存于 `AppSettings.monitoring.sources`（数组）：

```ts
interface RemoteUsageSource {
  id: string
  type: 'commandcode'          // 仅支持此类型
  name: string
  studioUrl: string            // 展示/登录跳转用
  enabled: boolean
}
```

`DEFAULT_SETTINGS.monitoring` 预置一个已启用的源：`{ id: 'commandcode', type: 'commandcode', name: 'Command Code 云端', studioUrl: 'https://commandcode.ai/studio', enabled: true }`。

### D2 凭证存储（key-store 扩展）

`KeyStoreSchema` 新增 `usageCredentials: Record<string, string>`：
- `usageCredentials[sourceId]` = session token（登录捕获）
- `usageCredentials[sourceId + '.apiKey']` = Provider API Key（可选）

沿用现有 `encryptValue`/`decryptValue`（safeStorage 加密，不可用时明文回退）。

### D3 登录流程

1. IPC `monitor:login(sourceId)` → 主进程打开模态 `BrowserWindow`（约 900×700，父窗口居中）
2. 独立 session partition（`persist:commandcode`），加载 `studioUrl`
3. 每 1.5s 轮询该 partition 的 cookie，匹配 `__Secure-commandcode_prod_.session_token`（host 含 `.commandcode.ai`）
4. 捕获 → 加密存 key-store → 关窗 → 返回 `{ success }`
5. 窗口被用户关闭且未捕获 → 返回 `{ success: false, cancelled: true }`，静默

### D4 数据拉取与归一化

IPC `monitor:refresh(sourceId)`：

1. 读凭证；无 session token → `code: 'not_authenticated'`
2. 并行请求（走 `fetchProxy`，尊重网络代理设置；15s 超时）：
   - summary / charts / credits（Cookie）
   - 若有 API Key → `/alpha/billing/credits`（Bearer）
3. 任一端点 401 → `code: 'session_expired'`
4. 防御性解析，charts 按 model 聚合为明细行
5. 返回归一化结构，`sourcesAvailable` 标记每个区块是否成功（部分失败优雅降级）

```ts
interface UsageWindow { usedPercent?: number; resetAt?: number }
interface CommandCodeUsage {
  fetchedAt: number
  sourcesAvailable: { summary: boolean; charts: boolean; credits: boolean; windows: boolean }
  summary?: { totalCount: number; totalCost: number; totalTokens: number; successRate: number }
  credits?: { monthlyCredits: number }
  windows?: { fiveHour?: UsageWindow; weekly?: UsageWindow }
  models?: Array<{ model: string; requests: number; cost: number; tokensIn: number; tokensOut: number; tokensTotal: number }>
}
```

### D5 IPC 通道（`monitor:*`）

- `monitor:getStatus(sourceId)` → `{ loggedIn, hasApiKey }`
- `monitor:login(sourceId)` → `{ success, cancelled?, error? }`
- `monitor:logout(sourceId)` → 清除该源凭证
- `monitor:setApiKey(sourceId, apiKey)` → 存加密
- `monitor:refresh(sourceId)` → `{ success, data?, error?, code? }`
- `monitor:updated` 事件：登录/登出/刷新后通知（云监控页跨窗口同步，可选，v1 先不做跨窗口，仅页面内 invoke）

### D6 UI（CloudMonitorView.tsx，新组件）

- 未登录：空态卡 + 「登录」按钮
- 已登录：
  - 动作栏：登录状态 + 上次刷新时间 + 刷新按钮 + 重新登录/退出登录 + 自动刷新开关（10 分钟，仅页面打开时）
  - 额度区 3 张卡：5小时窗口（已用%+进度条+重置倒计时）、7天窗口、月度额度余额（$）
  - 汇总行：总请求数 / 总成本 / 总Tokens / 成功率
  - 模型明细表：模型 / 请求数 / ↑输入 / ↓输出 / 总tokens / 成本
  - API Key 提示条：当 windows 数据缺失时出现，内联输入保存
- 入口：Sidebar 底部「云监控」按钮 + App 工具栏「云监控」tab（viewMode 增加 `'cloud'`）

### D7 错误处理与边界

- 401 → `session_expired`，UI 提示重新登录
- 网络错误/超时 → 错误条 + 保留上次数据 + 重试
- 部分端点失败 → 降级显示 + `sourcesAvailable` 提示
- 登录窗中途关闭 → cancelled，静默
- 无数据 → 空态引导

## 文件清单

新增：
- `src/main/monitoring/commandCode.ts` — 登录窗 + cookie 捕获 + API 客户端 + refresh 聚合
- `src/renderer/src/components/CloudMonitorView.tsx` — 云监控页面

修改：
- `src/shared/types.ts` — RemoteUsageSource / CommandCodeUsage / UsageWindow 等
- `src/shared/defaults.ts` — monitoring 默认源
- `src/shared/ipc-channels.ts` — monitor:* 通道
- `src/main/store/key-store.ts` — usageCredentials 字段
- `src/main/index.ts` — 注册 monitor IPC handlers
- `src/preload/index.ts` — 桥接方法
- `src/shared/env.d.ts` — MoaAPI 类型
- `src/renderer/src/App.tsx` — viewMode + 工具栏 tab
- `src/renderer/src/components/Sidebar.tsx` — 云监控入口

无新 npm 依赖。

## 验证

- `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
- `npm run build`
- 手动：登录 → 拉取成功并展示汇总/额度/明细；登出 → 空态；伪造过期 token → session_expired 提示；断网 → 错误条+重试；自动刷新启用时 10 分钟自动拉一次

## 实施顺序

1. 数据层：types / defaults / ipc-channels / key-store
2. 主进程：commandCode.ts + index.ts handlers
3. 桥接：preload / env.d.ts
4. UI：入口（Sidebar/App）→ CloudMonitorView
5. 验证：tsc + build + 手动测试