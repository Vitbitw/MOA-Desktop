# 防御边界规范（Defensive Boundary Policy）

- 日期：2026-09-17
- 状态：生效（B1–B4 已完成）
- 项目：MOA Desktop
- 适用范围：全部后续代码 + 存量分批清理

## 一句话原则

**信任内部、验证边界：每种防御在系统边界做一次、且只做一次；内部代码信任类型系统，不重复设防。**

## 背景（为什么立此规范）

当前代码库把三种不同性质的防御混在一起，难以区分：

| 类别 | 现状规模 | 处置 |
|---|---|---|
| ① 外部数据防御 | monitoring/（Command Code / DeepSeek / MiMo 平台接口）、pricing/probe（网页探测）逐字段校验 | **保留**——第三方数据形状不受控，是防崩溃的关键 |
| ② 自写自读的冗余 | `app_settings` 在 17 处各自 SELECT + JSON.parse + 逐字段校验 | **收敛**——统一入口 + 一次解析，消费方零校验 |
| ③ 复制粘贴的模板 | 22 个 IPC handler 同款 try/catch；renderer 12 处静默 catch | **收敛**——统一包装器 + 逐个审计 |

冗余防御的代价：同一道防线在多处重复维护（改一处漏一处）、防御代码淹没真实边界、读者误以为内部数据不可信。治理后全库防线从「143 处散落 catch + 17 处散装配置读取」收敛为「边界处的一次性防御」。

## 一、边界清单（必须防御，且只在此处防御）

| 边界 | 位置 | 防御形态 |
|---|---|---|
| 第三方 API 响应 | `src/main/monitoring/`、`src/main/pricing/probe.ts` | 解析函数内字段级校验（typeof / Array.isArray），非法记录整条丢弃 + 日志计数 |
| 浏览器注入脚本返回 | monitoring/（deepseek / commandCode 的 evaluate 结果） | 同上 |
| 网络层 | `src/main/proxy/server.ts`、`src/main/local/fetchProxy.ts` | socket / 流错误捕获、资源清理（destroy / cleanup）、半途失败标记流损坏 |
| DB 配置读取 | 统一 `readAppSettings()`（见 R1） | 一次 JSON.parse + 默认值合并；损坏时回退默认值 |
| DB 行数据 | 各查询点 | 行可能不存在（`?.` / null 检查合法）；字段形状信任 schema，不做字段级校验 |
| IPC 入口 | main 侧 handler（统一 `handleIpc` 包装，见 R2） | 包装器捕获错误 → `{success:false,error}`；参数形状信任 preload 类型声明 |
| 用户输入 | renderer 表单提交前 | 提交前校验一次 |

## 二、非边界（禁止防御）

1. **main 内部模块间调用**：TS 类型声明即契约，调用方不检查返回值形状。
2. **renderer 组件间 props**：类型保证，不做运行时检查。
3. **自己写入、自己读回的字段**：读回时整体 JSON.parse + 默认值合并一次即可，**禁止逐字段** `typeof` / `Number.isFinite` / `Array.isArray` 校验。
4. **上游已保证的值**：不再重复 `if (!x) return` / `x?.y`（防御性可选链）。
5. **IPC handler 内部**：不写 try/catch 模板（R2 包装器统一处理），除非有明确的恢复动作。

## 三、执行规则

### R1 配置读取统一入口

main 进程只有一个模块读写 `app_settings`：

```ts
// src/main/config/appSettings.ts
export function readAppSettings(): AppSettings {
  const row = getDatabase().queryOne<{ value: string }>(
    "SELECT value FROM moa_config WHERE key = 'app_settings'"
  )
  if (!row?.value) return DEFAULT_SETTINGS
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<AppSettings>) }
  } catch {
    return DEFAULT_SETTINGS // 配置损坏 → 恢复默认（防线收敛在这一处）
  }
}

export function writeAppSettings(settings: AppSettings): void { /* INSERT OR REPLACE */ }
```

规则：
- 17 处散装读取全部替换（index.ts ×6、probe.ts ×3、fetchProxy.ts ×2、proxy/server.ts ×2、moa/usage.ts ×2、collector.ts ×1、usageWindow.ts ×1）；
- 消费方直接取字段，**不再自行合并 DEFAULT_SETTINGS、不再校验**；
- 返回完整 `AppSettings`（浅合并，与现有语义一致）；写侧统一走 `writeAppSettings`。

### R2 IPC 统一包装

```ts
// src/main/ipc/handle.ts
export function handleIpc(channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { success: true, data: await fn(event, ...args) }
    } catch (err) {
      console.error(`[IPC] ${channel}:`, err)
      return { success: false, error: String(err) }
    }
  })
}
```

规则：
- 22 个同款模板 handler 收敛为 `handleIpc(IPC.X, ...)`，handler 内部只写业务逻辑；
- 特殊形态（裸返回：APP_GET_VERSION / MOA_GET_CONFIG / MOA_SET_CONFIG 等）保持现状，不强行改造；
- 原 `{success:true}`（无 data）改为返回 undefined 由包装器统一包装，renderer 侧 `res.data` 检查兼容。

### R3 catch 三准则

每个 catch 必须至少满足其一，否则删掉 try/catch、让错误冒泡到边界：

1. **有恢复动作**（重试 / 降级 / 清理 / 回退）；
2. **转译错误形态**（边界包装：如 R2 包装器、解析函数返回 null）；
3. **有意静默**（必须注释说明原因，如「状态读取失败不阻塞页面」——UI 非关键路径容错属此类）。

**禁止**：`catch (err) { console.error(...) }` 后无任何处理的「安慰型」catch——错误要么冒泡到边界统一记录，要么被转译。

### R4 可选链准则

- `a?.b` 表示「值合法地可缺失」（可选参数 / 可空字段 / 可能不存在的行）→ 保留；
- 表示「防自己代码出错」（上游类型已非空）→ 删除；
- 内部数据流里的长链 `a?.b?.c?.d` → 是「数据形状未收敛」的信号，应在解析边界收敛为确定类型。

### R5 外部解析函数形态（样板，保持）

- 一个数据源一个 parse 函数，校验集中其中，产出完整内部类型；
- 单条记录非法 → 丢弃该条 + 日志计数，不中断整批；
- 下游代码使用解析后的类型，零校验。

## 四、改造批次（按风险从低到高）

| 批次 | 内容 | 性质 | 验收 |
|---|---|---|---|
| B1 ✅ | 配置读取收敛：新建 `src/main/config/appSettings.ts`，替换 17 处散装读取 | 纯重构，行为不变 | tsc + build 通过 |
| B2 ✅ | IPC 包装器：新建 `src/main/ipc/handle.ts`（handleIpc / handleIpcRaw），收敛 24 个模板 handler | 纯重构，行为不变 | tsc + build 通过 |
| B3 ✅ | 内部冗余清理：防线内移到 mergeSettings（深合并 + 类型规范化），删除各消费点自读自防校验 | 删代码 | tsc + build 通过 |
| B4 ✅ | renderer 静默 catch 审计：12 处判定为「UI 容错，保留」并规范化注释 | 注释 | tsc + build 通过 |

依赖：B3 依赖 B1；B2、B4 独立。

## 五、红线

1. 边界清单（类别①）的字段校验**不允许**在改造中删减；
2. 每批独立完成并 `npx tsc --noEmit` + `npm run build` 通过后才进入下一批；
3. 发现行为差异立即回滚该批；
4. 新代码从落笔起即遵循本规范。
