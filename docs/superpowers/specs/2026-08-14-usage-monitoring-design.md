# 用量监控功能设计

- 日期：2026-08-14
- 状态：已确认（v1）
- 项目：MOA Desktop

## 背景与目标

MoA Desktop 目前只记录每次请求的 token 总量（`request_logs` 表），但：
- `cost` 恒为 0 —— 定价系统（`settings.pricing` + 设置页「定价覆盖」UI）已存在但无人消费
- 无模型维度 —— 无法按模型/厂商统计
- 聚合模型、标题生成的 usage 未采集
- 无任何历史用量展示界面

目标：记账式用量统计（按日/周/月汇总、按模型拆分、费用计算）+ 实时仪表盘（顶部统计条 + 桌面悬浮窗）。

明确不做（YAGNI）：预算告警、历史数据回填、CSV 导出、多货币实时汇率。

## 现状盘点

| 项 | 状态 |
|---|---|
| `request_logs` 表（timestamp/mode/sub_count/tokens/duration/success） | ✅ 已建表，main/index.ts:405 每次请求写入 |
| `settings.pricing: Record<modelId, PricingConfig>`（input/output/cacheRead/cacheCreation，USD/1K tokens） | ✅ 已定义 + 设置页 UI |
| `currency: 'USD' \| 'CNY'` | ✅ 已定义 + 设置页 UI |
| 子模型 tokenUsage 解析 | ✅ subModelCaller.ts:64 |
| 聚合模型 usage | ❌ callAggregator 未解析 |
| 标题生成 usage | ❌ generateTitle 丢弃 tokenUsage |
| cost 计算 | ❌ 恒 0 |
| 模型维度 | ❌ request_logs 无 model 信息 |
| 用量查询/展示 | ❌ 无 IPC、无 UI |

## 架构决策

### D1 成本计算与定价优先级

新文件 `src/main/moa/usage.ts`：
- `computeCost(modelId, promptTokens, completionTokens): number`
- 优先级：用户覆盖 `settings.pricing[modelId]` > 内置默认价格表（前缀匹配）> 0
- 币种：内部以 USD 计算存储，显示时按 `settings.currency` 换算（CNY 汇率固定 7.2 折算，不做实时汇率）

### D2 模型维度存储

`request_logs` 加 `models TEXT` 列（JSON 数组，每次模型调用一项）：

```json
[
  { "modelId": "gpt-4o", "role": "sub", "prompt": 1200, "completion": 800, "cost": 0.021 },
  { "modelId": "deepseek-chat", "role": "agg", "prompt": 3000, "completion": 1500, "cost": 0.0018 }
]
```

`role`: `'sub' | 'agg' | 'title'`。`prompt_tokens`/`completion_tokens` 列保留为合计值（兼容现有代码）。

DB 迁移：`ALTER TABLE request_logs ADD COLUMN models TEXT`，try/catch 包裹（仿 `title_edited` 先例，database.ts:51）。

历史数据不迁移：旧记录无模型维度，按模型统计从新记录开始。

### D3 内置默认价格表

新文件 `src/shared/pricing.ts`：
- 约 20 个常见模型：GPT-4o / GPT-4o-mini / o1 / o1-mini / Claude 3.5 Sonnet / Claude 3.7 Sonnet / Claude Haiku / DeepSeek-chat / DeepSeek-reasoner / Gemini 1.5 Pro / Flash / Qwen 系列 / Llama 3.x 等
- **模型 ID 前缀匹配**：`gpt-4o` 覆盖 `gpt-4o-2024-08-06`、`gpt-4o-mini` 等变体（最长前缀优先）
- 单位 $/1K tokens（与 `PricingConfig` 一致），USD 基准

### D4 采集补全

1. `callAggregator`（moaEngine.ts:62）：补解析 `data.usage`，返回 `{ content, usage, success, error }`
2. `generateTitle`（titleGenerator.ts:66）：返回类型改为 `{ title: string | null, tokenUsage? }`（内部已走 `callSubModel`，数据现成）
3. `executeMoAWithEvents`：聚合调用后把 agg usage 并入返回（`MoaResponse` 加 `aggregatorUsage?`）
4. main/index.ts:405 日志写入：计算每项 cost，写全 `models` JSON，`cost` 列写合计（不再写死 0）；标题生成调用（main/index.ts:329 附近）也追加一条 `role: 'title'` 的日志

### D5 查询 IPC

`src/shared/ipc-channels.ts` 新增：
- `usage:summary`（handle）：`{ range: 'today' | 'week' | 'month' | 'all', groupBy: 'model' | 'provider' | 'mode' }` → `{ requests, successRate, promptTokens, completionTokens, cost, rows: [...] }`。`models` JSON 拆行聚合（SQLite JSON 函数在 sql.js 中不可靠，改用 JS 内存聚合：先查范围内全部日志行，JS 里拆 models 聚合）
- `usage:today`（handle）：今日合计（顶部条/悬浮窗启动拉取）
- `usage:updated`（事件）：请求完成时主进程推送（顶部条/悬浮窗即时刷新，无轮询）

### D6 UI

#### 账单视图 UsageView（新组件）
- 侧边栏底部加「用量」入口，点击主区切到账单视图（与聊天/监控同级视图切换）
- 顶部时间范围 Tab：今日 / 本周 / 本月 / 全部
- 汇总卡片：请求数 · 成功率 · ↑输入 tokens · ↓输出 tokens · 总成本
- 明细表：按模型拆分（模型 / 请求数 / tokens / 成本 / 占比），下方模式分布（A / D / 直通）
- 货币跟随 `settings.currency`；成本为 0 的模型标「未定价」

#### 顶部实时统计条
- MonitorView 顶部常驻：`今日 ↑12.3k ↓8.1k $0.42`，点击跳转用量页
- 数据源：`usage:updated` 事件 + 启动拉一次 `usage:today`

#### 桌面悬浮窗
- 主进程创建 `BrowserWindow`：frameless、`alwaysOnTop`、`transparent`、`skipTaskbar`，约 90×100
- 两行显示：第一行「今日 ↑/↓/$」，第二行「总计 ↑/↓/$」（全部时间累计）
- 运行中显示脉冲动画（`usage:updated` 事件驱动）
- 可拖动（`-webkit-app-region: drag`），右键菜单：打开用量页 / 隐藏 / 退出
- 设置（display 区）加开关「显示桌面用量悬浮窗」，位置记忆存 settingsStore

### D7 错误处理与边界

- 价格缺失 → cost 0 + 明细表「未定价」标注
- 无数据 → 空态提示
- 悬浮窗：IPC 事件失败不崩溃；主窗口关闭时销毁；窗口位置越界自动拉回屏幕内
- 汇总查询时 `models` 为 NULL 的旧记录：按汇总列计入 totals，不进入模型拆分行

## 文件清单

新增：
- `src/main/moa/usage.ts` — 成本计算 + 用量记录工具
- `src/shared/pricing.ts` — 内置价格表 + 前缀匹配
- `src/renderer/src/components/UsageView.tsx` — 账单视图
- `src/renderer/src/components/UsageOverlay.tsx` — 悬浮窗渲染（独立 HTML 入口 `src/renderer/usage.html`）
- `src/renderer/src/components/UsageBar.tsx` — 顶部实时统计条

修改：
- `src/main/db/schema.ts` — request_logs 加 models 列
- `src/main/db/database.ts` — 迁移（ALTER TABLE try/catch）
- `src/main/moa/moaEngine.ts` — callAggregator 解析 usage；MoaResponse 加 aggregatorUsage
- `src/main/title/titleGenerator.ts` — 返回 tokenUsage
- `src/main/index.ts` — 日志写入扩展（models + cost）；标题日志；usage IPC + 事件
- `src/shared/ipc-channels.ts` — usage 通道
- `src/shared/types.ts` — 相关类型
- `src/renderer/src/components/Sidebar.tsx` — 用量入口
- `src/renderer/src/components/MonitorView.tsx` — 顶部统计条
- `src/renderer/src/components/SettingsPanel.tsx` — 悬浮窗开关
- `src/renderer/src/store/settingsStore.ts` — 悬浮窗设置字段
- `electron.vite.config.ts` — 悬浮窗渲染入口

无新 npm 依赖。

## 验证

- `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`（electron-vite 构建不查类型，必须单独跑）
- `npm run build`
- 手动：发一轮 A 模式请求 → 查 request_logs 的 models JSON 与 cost 正确；聚合/标题调用计入；账单视图按模型/时间筛选正确；悬浮窗拖动、右键菜单、开关生效

## 实施顺序

1. 数据层：usage.ts + pricing.ts + schema/db 迁移 + moaEngine/titleGenerator 采集 + index.ts 写入
2. 查询层：IPC 通道 + 聚合实现
3. UI：UsageBar → UsageView → Sidebar 入口 → 悬浮窗 + 设置开关
4. 验证：tsc + build + 手动测试
