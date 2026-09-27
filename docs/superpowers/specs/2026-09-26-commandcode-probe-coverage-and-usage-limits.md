# Command Code 探查覆盖率 + Usage limits 提取（设计说明）

日期：2026-09-26
报障：① 定价探查后大量模型行无价（143 行中 65 行空价）；② Usage limits（5h/周/月请求数）从未探到。

## 现象与根因（实证）

对用户机器上 app_settings 的 probedPricing 与 /models 列表逐条核对：

| 类别 | 数量 | 根因 |
| --- | --- | --- |
| 探到但匹配不上 | 47 行 | 探查条目用计划页**显示名**（`Kimi K3`），UI 模型行用 `/models` **规范 ID**（`moonshotai/Kimi-K3`）；`startsWith` 前缀匹配失败 → 该行空价 + 同一模型出现两行（显示名行有价、ID 行无价） |
| 真缺（premium） | 18 行 | Claude/GPT 系列不在 GOAT 计划页上；全站 `commandcode.ai/models` 页有全部 82 个模型的价格 |
| Usage limits | 0 条 | 额度区块（请求数表 + Monthly credits 表）位于计划页深处，探查片段（原 12k 字符上限）覆盖不到，且**从未写过提取逻辑** |

## 修复

### 1. pattern 规范化（`canonicalizePattern`，probe.ts）

探查条目落库前把显示名映射到所绑厂商 `/models` 的模型 ID，无法对应则保留原样：

- 匹配顺序：精确 → 变体归一化相等（原文形态 + 剥尾部括注形态，如 `(latest)`/`(exp)`）→ 词序列连续子序列（取剩余词最少者，`Tencent Hy3` → `tencent/hy3-paid` 剩 1 词）。
- 专用规范化 `canonNorm`：括号视作分隔符（`(exp)` 的 `exp` 参与匹配）、双向字母/数字边界拆词（`27B` ↔ `27 B`），与 `keywordVariants` 的拆词形态对称。
- 真实数据验证：74 条探查 pattern → **73 条映射成功**（1 条 `Jev` 是计划页特有模型、不在 /models，保留原样为预期行为）；两个历史坑作为回归断言固化：`DeepSeek V4 Flash Vision (exp)` 必须落 `…-vision-exp`（不落 v4-flash）、`Qwen 3.8 27B` 必须映射（字母数字拆词）。
- 收敛效果：显示名 + ID 形态条目归一化去重（13 组重复落点各留 1 条）。

### 2. Usage limits 提取（额度区块独立 LLM 提取 + 合并）

- 定位：锚 `Requests / 5 hours`（前留 400 字符带上下文）与 `Monthly credits`（前留 200 字符），各向后切 5,500 字符；锚缺失（非计划页/改版）→ 跳过，不影响定价主流程。实测 goat 页两表（~2,200 + ~3,300 字符）均在窗口内完整覆盖（含促销串 `$60 through Sep 28th`）。
- 提取：独立 prompt（`buildCreditsPrompt`）输出 `{pattern, fiveHour, weekly, monthly, monthlyCredits}`；数值须来自页面，`Free` 等非数字省略。
- 合并：`mergeCreditsIntoEntries` 按规范化 pattern 匹配**已存在**条目（额度不产生独立条目），usageLimits 三窗口与 monthlyCredits 独立更新、负值/非数字跳过；返回更新条目数（日志用）。
- 语义：Usage limits 是**官方估算的每模型请求数/窗口**（按套餐额度与模型单价折算），不是 token 数。

### 3. 套餐外模型补价（`fetchAllModelsPricing`，缺省开启）

CC 源在计划页流程后，对「已探查落点未覆盖的 /models ID」（当前 22 个：Claude 系 9、GPT 系 8、Gemini 系 3、其他 2）抓全站 `commandcode.ai/models`，按缺失模型位置切片后定向提取（复用 `buildFillPrompt`）；上限 `ALL_MODELS_FILL_MAX = 60`。源级开关可在设置页关闭（仅 CC 源显示）。

### 4. UI（SettingsPanel.tsx）

- `probedPatternMatches`：精确/前缀/宽松归一化三段匹配（与主进程口径一致），历史旧形态条目（显示名）兜底仍可命中。
- 定价表在「缓存写」后并入两列（不下方另开表）：**月额度**（Monthly credits，按显示货币格式化）与 **Usage limits**（`5 小时 / 每周 / 每月` 请求数，tooltip 标注口径）。均为只读；列按源级条件显示（≥1 条目含该值才加列），峰谷展开行与空表 colSpan 随列数自适应。
- 源设置行新增「补全套餐外模型定价」开关。

## 数据模型

```ts
interface ProbedUsageLimits { fiveHour?: number; weekly?: number; monthly?: number }  // 请求数/窗口
interface ProbedPricingEntry { …; monthlyCredits?: number; usageLimits?: ProbedUsageLimits; … }
interface PricingProbeSource { …; fetchAllModelsPricing?: boolean }  // 缺省 true，仅 CC 源生效
```

## 验证

- `test:probe-cc` 81 断言（新增 4 组：canonicalizePattern 18 条、buildProbedEntries 收敛、mergeCreditsIntoEntries、额度区块定位/prompt）；`test:all` 全绿。
- 真实页面离线验证：cc-goat.html → `htmlToText` → `locateCreditsFragment`，片段含全部 4 个表头、请求数表与月额度表完整。
- 实机重探未跑（需应用内点「强制探查」+ LLM 调用，留待用户实机核对；headless 部分已覆盖切片完整性这一关键前置条件）。

## 约束（未来改动注意）

- 探查 pattern 一律经 `canonicalizePattern` 落库；**勿绕过 `buildProbedEntries` 直接写 pattern**，否则重现「显示名行有价、ID 行空价」。
- 额度区块定位依赖锚句 `Requests / 5 hours` / `Monthly credits`；页面改版须同步 `CREDITS_ANCHOR_*`（纯文本形态，`htmlToText` 已压平空白）。
- 页面哈希缓存只跟踪计划页（含额度区块）；`models` 页价格变化不触发重探，需「强制探查」。
- 额度提取失败只记日志不 fail（增强项，坏页面不应拖垮定价主流程）。
