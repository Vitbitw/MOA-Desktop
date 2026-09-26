# MoA Desktop

**Mixture of Agents (MoA) 桌面客户端** — 一个本地化的多模型聚合聊天桌面应用。多路子模型并行作答，按协作架构由聚合模型融合（选举模式）或主模型参考专家意见亲自作答（主席团模式），用多份模型的智慧产出更高质量的答案；内置 OpenAI / Anthropic 双协议网关，把 MoA 能力开放给任意第三方客户端。

---

## 功能特性

### MoA 引擎

- **🧠 双协作架构**（设置页一键切换，网关可独立配置）
  - **选举模式** — 多个子模型并行产出完整答案 → 聚合模型融合提炼出最终答案
  - **主席团模式** — 子模型以专家身份（专家名 + 完整角色介绍）给出专业意见 → 主模型参考全部意见与完整多轮对话历史亲自作答
- **🪄 专家团 AI 生成**（主席团）— 描述任务需求，由 LLM 规划整个专家团队（推荐人数 + 每位专家的角色名与角色描述）；细分程度三档（偏少 / 正常 / 较多）；信息不足时最多追问 3 轮澄清；生成结果直接写入席位卡片，可逐项编辑
- **🎛️ 席位自由编排** — 每个子模型占一个席位：下拉直换模型（保留角色配置）、自定义专家名与角色介绍、席位自动扩充 / 缩减
- **📊 原始对比模式** — 跳过聚合，并排查看各子模型的原始输出
- **⚡ 流式呈现** — 子模型面板与最终答案实时流式输出，附 token 用量与耗时

### MoA 网关

- **🔌 双协议兼容** — OpenAI 兼容（`/v1/chat/completions`）与 Anthropic Messages 兼容（`/v1/messages`，Claude Code 等客户端可直连）
- **出口模式可选** — 默认聚合：第三方客户端无论发什么，始终返回一份融合后的最终答案（协作架构跟随 MoA 配置或网关单独指定）；可切换**单模型直通**，由指定模型直接作答
- **生产级细节** — 可选 API Key 鉴权、并发上限（默认 3）、请求记录（全量 / 仅统计）、透明模式（extended 时响应附加子模型执行明细 `x_moa_sub_models`）；embeddings / images / audio / moderations 等其余端点透传给第一个可用厂商
- **📡 实时监控** — 网关代理轮次在「监控」视图实时可见，帮助菜单一键复制网关地址

### 成本与用量

- **📈 本地用量统计** — 每次 MoA 请求的 token 与费用落库，按今日 / 本周 / 本月 / 全部 × 按模型 / 厂商 / 模式多维统计
- **🪟 桌面用量悬浮窗** — 置顶小徽章，随时查看今日 ↑/↓ tokens 与费用，位置可记忆
- **🔍 官方定价探查** — 抓取厂商官方定价页 → LLM 提取结构化定价（输入 / 输出 / 缓存读写单价、峰谷时段价、币种自动折算为 USD）；页面哈希缓存避免重复解析；支持按间隔自动刷新
- **💰 费用优先级** — 手动覆盖 > 官方探查 > 内置默认 > 0
- **☁️ 云端用量监控** — 内建 Command Code / 小米 MiMo / DeepSeek 三类云账号源：应用内登录后拉取余额、额度窗口（5 小时 / 7 天 / 月度）、订阅套餐与到期时间；Command Code 支持后台自动采集与本地累计（不受服务端记录条数上限影响）。**每源可添加多个账号**（Plan 账号 / 按量账号各配各的登录凭据），凭据、快照、本地累计、采集状态全部按账号隔离，切换与登出互不串号

### 平台与体验

- **🏭 多厂商** — 内置 38 家厂商模板（OpenAI / Anthropic / Gemini / DeepSeek / 硅基流动 / 智谱 / Kimi / Groq / OpenRouter 等），亦支持自定义地址；**每个厂商可挂多个账号**（各自的 API Key / 计费通道 / 订阅费），调用与成本记账走「当前账号」，用量按账号快照分组，切换账号不会把历史账算到别的账号头上
- **🌐 网络代理** — 主进程全部外发请求（模型调用、定价探查、用量拉取）统一走可配置代理，含超时与自动重试
- **💬 对话体验** — Markdown 流式渲染（代码高亮 / 表格 / KaTeX 公式）、SQLite 对话历史（搜索 / 重命名 / 删除）、AI 自动生成对话标题（首条消息 / 首条回复 / 手动 / 每 N 轮）
- **🔑 安全存储** — API Key / 登录凭据使用 electron-store + OS 原生 safeStorage 加密
- **🌙 主题** — 暗色 / 亮色跟随系统，手动切换可持久化

### 界面导航

| 视图 | 内容 |
|------|------|
| **对话** | 聊天主界面：模式切换、子模型面板、聚合答案 |
| **监控** | 网关代理轮次实时视图 + MoA 会话轮次的子模型输出面板 |
| **用量** | 本地 token / 费用统计（多维分组） |
| **云监控** | 云端账号用量：余额、额度窗口、订阅、模型明细与本地累计 |

设置页分区：**MoA**（席位 / 架构 / 生成专家团）、**厂商**、**网络代理**、**对话标题**、**显示设置**、**定价**。

## 技术架构

```
src/
├── main/                          # Electron 主进程
│   ├── index.ts                   # 窗口管理 + 应用菜单 + 生命周期
│   ├── config/appSettings.ts      # 应用设置读写 + 旧数据迁移
│   ├── db/                        # sql.js (WASM SQLite) 持久化
│   │   ├── database.ts            # 封装 + 自动保存
│   │   └── schema.ts              # 8 张表定义
│   ├── gateway/                   # MoA 网关（port 28888）
│   │   ├── server.ts              # OpenAI 兼容端点 + 鉴权 / 并发 / 事件广播
│   │   └── anthropicAdapter.ts    # Anthropic Messages ↔ OpenAI 双向转换
│   ├── ipc/handle.ts              # IPC 注册
│   ├── moa/                       # MoA 聚合引擎
│   │   ├── moaEngine.ts           # 编排器（选举 / 主席团）
│   │   ├── subModelCaller.ts      # 并行子模型调用
│   │   ├── expertTeamGenerator.ts # 专家团 AI 生成（三档细分 + 追问）
│   │   ├── aggregationPrompt.ts   # 聚合 / 主席团提示词
│   │   ├── streamChat.ts          # 流式调用（回退链 + 超时）
│   │   ├── sseReader.ts           # SSE 解析
│   │   ├── streamThrottle.ts      # 流式节流
│   │   ├── usage.ts               # token / 费用记录
│   │   └── moaConfig.ts           # MoA 配置持久化 + 迁移
│   ├── monitoring/                # 云端用量监控
│   │   ├── commandCode.ts         # Command Code 用量 / 订阅
│   │   ├── mimo.ts                # 小米 MiMo 余额 / 套餐
│   │   ├── deepseek.ts            # DeepSeek 余额 / 平台用量
│   │   ├── collector.ts           # 后台定时采集
│   │   ├── usageAccumulator.ts    # 本地累计（去重累积）
│   │   └── snapshotStore.ts       # 页面快照缓存
│   ├── pricing/probe.ts           # 官方定价探查（抓取 + LLM 提取 + 表尾补漏）
│   ├── providers/providerManager.ts # 厂商 CRUD + 模板 + 模型缓存
│   ├── store/key-store.ts         # 加密凭据存储
│   ├── title/titleGenerator.ts    # 对话标题 AI 生成
│   ├── usage/usageWindow.ts       # 桌面用量悬浮窗
│   ├── uiBridge.ts                # 主进程 → 渲染进程事件桥
│   └── local/fetchProxy.ts        # 代理感知 fetch（HTTP CONNECT 隧道，零依赖）
├── preload/
│   └── index.ts                   # IPC 调用 + 事件订阅 (contextBridge)
├── renderer/                      # React 18 UI
│   ├── src/
│   │   ├── components/            # 对话 / 监控 / 用量 / 云监控 / 设置等组件
│   │   ├── store/                 # Zustand 状态管理
│   │   ├── lib/                   # 工具函数（用量格式化 / 缓存等）
│   │   └── usage/
│   └── index.html
└── shared/                        # 跨进程共享
    ├── types.ts                   # 全部类型定义
    ├── defaults.ts                # 默认配置 + 38 家厂商模板 + 内置定价
    ├── ipc-channels.ts            # 通道常量
    ├── moaRoles.ts                # 旧角色模板（仅旧数据迁移用）
    ├── modelKey.ts                # 'providerId:modelId' 解析
    └── pricing.ts                 # 定价工具
```

## 快速开始

### 前置要求

- Node.js ≥ 18
- npm ≥ 9

### 安装 & 运行

```bash
# 克隆项目
git clone https://github.com/Vitbitw/MOA-Desktop.git
cd MOA-Desktop

# 安装依赖
npm install

# 开发模式运行
npm run dev          # Windows 中文环境建议用 npm run dev:win（自动 chcp 65001）

# 生产构建
npm run build
```

### 初始配置

1. **厂商** Tab：选择内置模板（OpenAI / DeepSeek / 硅基流动等）或填自定义地址 → 填写 API Key → 拉取模型列表
2. **MoA** Tab：选择子模型与聚合模型（可选）；「协作架构」切换选举 / 主席团；主席团模式下为各席位设置专家名与角色介绍
3. **对话** Tab：选择模式开始聊天

> 主席团模式推荐流程：点击「AI 生成专家团」→ 描述任务需求 → 选择细分程度（偏少 / 正常 / 较多）→ 回答追问（可选）→ 生成后逐席位微调 → 开始对话。

> 可选：**设置 → 网络代理** 配置代理后，主进程全部外发请求自动走代理；**设置 → 定价** 配置官方定价页源，点击「探查并更新」由大模型自动维护定价。

### MoA 网关

让不支持 MoA 的第三方软件（Cline / Cursor / Cherry Studio / Claude Code 等）获得 MoA 效果：把软件里的 API 地址指向本机网关即可（帮助菜单可一键复制地址）。

内置网关地址：`http://127.0.0.1:28888`

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查（含活跃请求数 / 队列长度） |
| `GET /v1/models` | 模型列表 |
| `POST /v1/chat/completions` | OpenAI 兼容聊天补全（支持 stream） |
| `POST /v1/messages` | Anthropic Messages 兼容（Claude Code 直连） |
| `POST /v1/embeddings` 等 | 其余端点透传给第一个可用厂商 |

网关设置（设置页）：启用开关、出口模式（聚合 / 单模型直通）、监听地址 / 端口、并发上限、API Key 鉴权、请求记录（全量 / 仅统计）、透明模式（extended 时在响应中附加子模型执行明细）。

## 用量与成本

三套互补的数据：

1. **本地用量统计**（用量视图）— 本机历次 MoA 请求的 token / 费用，费用按定价层实时估算；可开启桌面悬浮窗常驻查看
2. **官方定价探查**（设置 → 定价）— 从厂商官方定价页提取最新单价（含峰谷时段价与币种折算），支持自动刷新；探查结果在页面未变更时直接复用缓存
3. **云端用量监控**（云监控视图）— 直接读取云账号的真实用量与额度（Command Code / 小米 MiMo / DeepSeek）：余额、5 小时 / 7 天 / 月度额度窗口、订阅状态与到期时间；Command Code 附带后台采集的本地累计明细

## 构建打包

```bash
# 构建
npm run build

# 打包安装包（需 electron-builder）
npx electron-builder --win     # Windows NSIS
npx electron-builder --mac     # macOS DMG
npx electron-builder --linux   # Linux AppImage
```

## 测试

`test-e2e/` 下为纯 Node 冒烟测试（stub 掉 Electron 依赖，无需启动应用）：

```bash
npm run test:all             # 全部用例
npm run test:expert-team     # 单项：专家团生成
npm run test:gateway         # 单项：网关流式
npm run test:arch-persist    # 单项：协作架构持久化
```

覆盖：SSE 解析、流式节流、引擎事件、网关（流式 / 存储 / Anthropic 适配）、用量窗口、云监控缓存、快照存储、专家团生成、定价探查状态、架构持久化等。详见 [test-e2e/README.md](test-e2e/README.md)。

## 技术栈

| 层 | 技术 |
|-----|------|
| 桌面框架 | Electron 33 |
| 构建 | electron-vite + Vite 5 |
| 前端 | React 18 + TypeScript strict |
| 样式 / 组件 | Tailwind CSS 3 + Radix UI |
| 状态 | Zustand |
| 持久化 | sql.js (WASM SQLite) |
| 密钥存储 | electron-store v8 + OS safeStorage |
| Markdown | react-markdown + remark-gfm + KaTeX |
| 网关 | Express 4（OpenAI / Anthropic 双协议） |
| 网络 | 自研代理感知 fetch（HTTP CONNECT 隧道，零依赖） |

## License

AGPL-3.0-or-later
