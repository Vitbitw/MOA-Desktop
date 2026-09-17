# test-e2e

不启动完整应用即可验证关键逻辑的脚本，全部通过 npm 脚本运行：

| 命令 | 脚本 | 作用 |
| --- | --- | --- |
| `npm run test:monitor` | `monitor-behavior.cjs` | 从 `src/main/monitoring/commandCode.ts` 抽取纯函数（游标分页 / 页大小探针 / 记录与 charts 解析 / 聚合 / 失败分层），注入假 `ccGet` 做行为断言 |
| `npm run db:inspect` | `db-inspect.cjs` | 只读诊断本地 SQLite：`cc_usage_records` 采集批次、按模型汇总、监控设置 |

## monitor-behavior.cjs

- 不依赖 Electron 运行时：用 esbuild 把抽取到的 TS 片段转成 CJS 后 `new Function` 执行
- 抽取依赖 `commandCode.ts` 中函数的**函数体形状**（见脚本顶部 `parts` 数组）。改动这些函数时若形状变化过大，脚本会以 `抽取失败: <name>` 明确报错，而不是静默跳过断言
- 断言里的数字（如 `USAGE_MAX_PAGES`）从源码常量读取，改常量不会造成假失败
- 返回码：全部通过 `0`，有失败 `1`

## db-inspect.cjs

- **只读**：先把 DB 复制到临时文件再打开，不会写回应用数据库
- DB 路径顺序：命令行参数 > `MOA_DB` 环境变量 > Electron userData 默认位置（Windows `%APPDATA%\moa-desktop`、macOS `~/Library/Application Support/moa-desktop`、Linux `~/.config/moa-desktop`）

## 目录约定

本目录曾被 `.gitignore` 的 `test-*/` 规则忽略，现以 `!test-e2e/` 例外纳入版本控制。
目录内 8 月的旧脚本（`harness.js`、`stub.js`、`probe-*.js` 及其 transcript）是历史实验产物，未纳入版本控制，不参与上述命令。
