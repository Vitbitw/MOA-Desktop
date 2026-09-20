# test-e2e

不启动完整应用即可验证关键逻辑的脚本，全部通过 npm 脚本运行：

| 命令 | 脚本 | 作用 |
| --- | --- | --- |
| `npm run test:all` | （串行跑下表全部 13 个测试脚本） | 一键全量回归：任一失败即退出码 1（`test:monitor` 含在内） |
| `npm run test:sse` | `sse-parser.cjs` | SSE 解析器：多行 data / event 透传 / 多工具调用增量 / 末帧 usage / finish_reason |
| `npm run test:throttle` | `stream-throttle.cjs` | 节流推送器：窗口合并、终态 flush+dispose 语义 |
| `npm run test:stream` | `stream-call.cjs` | 通用流式调用层 streamChat：三档超时 / 回退链 / 200 直回 JSON 抢救 / abort / extraBody 透传 / tool_calls 增量 |
| `npm run test:engine` | `engine-events.cjs` | MoA 引擎事件语义：子模型增量/终态、聚合分块、abort 短路、fallback |
| `npm run test:gateway` | `gateway-stream.cjs` | /v1/chat/completions 网关：MoA 真流式帧、direct 逐字节透传、abort 链路、UI 事件广播、记账（硬门槛 119 断言） |
| `npm run test:store` | `gateway-store.cjs` | 渲染端 gatewayStore 单槽位状态机：占位/合并/迟到丢弃/dismiss/aggRunning 收口/订阅解绑 |
| `npm run test:anthropic` | `anthropic-adapter.cjs` | Anthropic ↔ OpenAI 双向转换纯函数：请求转换矩阵、工具块、stop_reason 映射、SSE 事件状态机 |
| `npm run test:anthropic-env` | `anthropic-endpoint.cjs` | POST /v1/messages 端到端（真实网关 + mock 上游）：流式/非流式、tools、tool_use 块、abort、direct、compare、截断映射 |
| `npm run test:usage-window` | `usage-window.cjs` | 云端额度窗口纯函数：倒计时文案 / 重置后旧快照判定 / 待补拉筛选与闭环（5h/7d 到点自动刷新） |
| `npm run test:monitor` | `monitor-behavior.cjs` | 云监控采集纯函数：游标分页 / 页大小探针 / 记录与 charts 解析 / 聚合 / 失败分层 / 月度额度窗口计算 |
| `npm run test:cloud-cache` | `cloud-monitor-cache.cjs` | 云监控页面快照缓存：get/patch/clear 语义（局部更新不丢字段、登出清空）+ 挂载拉取判定（新鲜/过期/自动刷新关闭） |
| `npm run test:snapshot-store` | `monitor-snapshot-store.cjs` | 云监控用量快照持久化：save/get 往返、同源覆盖与源间隔离、clear、损坏 JSON 与 DB 抛错降级 |
| `npm run test:expert-team` | `expert-team.cjs` | 主席团专家团：LLM 输出宽容解析 / 生成模型解析与错误路径 / 席位映射与自动扩充缩减 |
| `npm run test:arch-persist` | `architecture-persist.cjs` | MoA 协作架构持久化（**唯一启动完整应用的测试**：需图形会话，不纳入 `test:all`）：切换即改即存 / 重启保持 + UI 同步 / 生成专家团写入不清架构 |
| `npm run db:inspect` | `db-inspect.cjs` | 只读诊断本地 SQLite：`cc_usage_records` 采集批次、按模型汇总、监控设置 |

## monitor-behavior.cjs

- 不依赖 Electron 运行时：用 esbuild 把抽取到的 TS 片段转成 CJS 后 `new Function` 执行
- 抽取依赖 `commandCode.ts` 中函数的**函数体形状**（见脚本顶部 `parts` 数组）。改动这些函数时若形状变化过大，脚本会以 `抽取失败: <name>` 明确报错，而不是静默跳过断言
- 断言里的数字（如 `USAGE_MAX_PAGES`）从源码常量读取，改常量不会造成假失败
- 返回码：全部通过 `0`，有失败 `1`

## db-inspect.cjs

- **只读**：先把 DB 复制到临时文件再打开，不会写回应用数据库
- DB 路径顺序：命令行参数 > `MOA_DB` 环境变量 > Electron userData 默认位置（Windows `%APPDATA%\moa-desktop`、macOS `~/Library/Application Support/moa-desktop`、Linux `~/.config/moa-desktop`）

## architecture-persist.cjs

- **唯一会启动完整应用的测试**（其余脚本均为纯 Node 逻辑验证）：真实 Electron 主进程 + 渲染进程 + 隔离临时 userData（`os.tmpdir()` 下建目录，结束即删；`MOA_ARCH_E2E_KEEP=1` 保留现场排障），全程不触碰用户数据
- 依赖 `out/` 构建产物（先 `npm run build`）；运行期间主窗口会短暂出现；网关端口被占用时自动顺延，不与正在运行的应用冲突
- 覆盖：架构切换即改即存（点击 → 主进程落库，无需点「保存配置」）、重启保持 + 设置面板 UI 同步（按钮高亮 / 「AI 生成专家团」面板出现）、生成专家团写入链路（仅 subModels）不清掉 architecture
- 返回码：全部通过 `0`，有失败 `1`（失败时打印实际值与步骤快照）

## 目录约定

本目录曾被 `.gitignore` 的 `test-*/` 规则忽略，现以 `!test-e2e/` 例外纳入版本控制。
**新增测试脚本一律提交版本控制**，并在本 README 登记（命令 | 脚本 | 作用），同时更新 `package.json` 的 `test:*` 与 `test:all` 串联。
目录内 8 月的旧脚本（`harness.js`、`stub.js`、`probe-*.js` 及其 transcript）是历史实验产物，未纳入版本控制，不参与上述命令。
