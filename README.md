# MoA Desktop

**Mixture of Agents (MoA) 桌面客户端** — 一个本地化的多模型聚合聊天桌面应用。并行调用多个子模型，由聚合模型融合（选举模式）或由主模型参考专家意见亲自作答（主席团模式），产生更高质量的答案。

---

## 功能特性

- **🧠 MoA 双架构** — 选举模式：多子模型并行出完整答案 → 聚合模型融合；主席团模式：子模型带角色（批判者/技术顾问/创意官等）出专家意见 → 主模型参考意见与完整多轮历史亲自作答。设置页一键切换
- **📊 原始对比模式 D** — 同时查看多个模型的原始输出，手动比较
- **🔍 官方定价探查** — 抓取厂商官方定价页并用大模型提取结构化定价（含峰谷/错峰时段价），支持按间隔自动刷新；费用优先级：手动覆盖 > 官方探查 > 内置默认
- **🔌 MoA 网关** — 内置 OpenAI 兼容接口 (port 28888)，把 MoA 聚合能力开放给第三方软件（Cline / Cursor / Cherry Studio 等）
- **🏭 多厂商管理** — 内置 OpenAI / DeepSeek / 硅基流动 / Groq 等模板，支持自定义厂商
- **💬 Markdown 渲染** — 流式消息展示，支持代码高亮、表格、数学公式
- **📚 对话历史** — SQLite 持久化存储，搜索、删除、重命名
- **🌙 暗色主题** — 跟随系统偏好，手动切换可持久化
- **🔑 API Key 加密** — 使用 electron-store + OS 原生 safeStorage

## 技术架构

```
src/
├── main/              # Electron 主进程
│   ├── index.ts       # 窗口管理 + IPC 注册 + 应用生命周期
│   ├── gateway/       # MoA 网关 (port 28888)
│   │   └── server.ts  # /v1/chat/completions, /health, passthrough
│   ├── db/            # sql.js 持久化
│   │   ├── database.ts # WASM SQLite 封装 + 自动保存
│   │   └── schema.ts   # 7 表定义
│   ├── moa/           # MoA 聚合引擎（选举/主席团双架构）
│   │   ├── moaEngine.ts       # 编排器
│   │   ├── subModelCaller.ts  # 并行子模型调用
│   │   ├── aggregationPrompt.ts # 聚合/主席团提示词
│   │   └── moaConfig.ts       # 配置持久化
│   ├── pricing/       # 官方定价探查
│   │   └── probe.ts   # 定价页抓取（HTTP+浏览器兜底）+ LLM 提取 + 表尾补漏
│   ├── providers/     # 厂商管理
│   │   └── providerManager.ts # CRUD + 模板 + 模型缓存
│   ├── store/         # 加密 Key 存储 (electron-store)
│       └── key-store.ts
│   └── local/         # 代理感知 fetch（网络代理/直连）
│       └── fetchProxy.ts
├── preload/
│   └── index.ts       # IPC 调用 + 事件订阅 (contextBridge)
├── renderer/          # React 18 UI
│   ├── src/
│   │   ├── components/  # 12 个 UI 组件
│   │   ├── store/       # Zustand 状态管理
│   │   └── lib/         # 工具函数
│   └── index.html
└── shared/            # 跨进程类型
    ├── types.ts
    ├── defaults.ts
    ├── ipc-channels.ts
    ├── moaRoles.ts      # 子模型角色模板（主进程与 UI 共享）
    └── env.d.ts
```

## 快速开始

### 前置要求

- Node.js ≥ 18
- npm ≥ 9

### 安装 & 运行

```bash
# 克隆或解压项目
cd Windows-moa

# 安装依赖
npm install

# 开发模式运行
npm run dev

# 生产构建
npm run build
```

### 配置

1. 启动后点击左侧 **厂商** Tab
2. 选择模板（OpenAI / DeepSeek 等）或输入自定义地址
3. 填写 API Key，获取模型列表
4. 切换到 **MoA** Tab，选择子模型和聚合模型（可选）；「协作架构」可切换主席团模式并为各子模型设置角色与自定义提示词
5. 回到 **对话** Tab，选择模式开始聊天

> 可选：**设置 → 定价** 配置官方定价页源，点击「探查并更新」由大模型自动维护定价（费用优先级：手动覆盖 > 官方探查 > 内置默认）。

### MoA 网关

让不支持 MoA 的第三方软件（Cline / Cursor / Cherry Studio 等）获得 MoA 效果：把软件里的 API 地址指向本机网关即可（帮助菜单可一键复制地址）。

内置网关地址：`http://127.0.0.1:28888`

- `GET /health` — 健康检查
- `GET /v1/models` — 模型列表
- `POST /v1/chat/completions` — 聊天补全（支持 stream）
- `POST /v1/embeddings` 等 — 其余端点透传给第一个可用厂商

## 构建打包

```bash
# 构建
npm run build

# 打包 Windows 安装包（需 electron-builder）
npx electron-builder --win
```

## 技术栈

| 层 | 技术 |
|-----|------|
| 桌面框架 | Electron 33 |
| 构建 | electron-vite + Vite 5 |
| 前端 | React 18 + TypeScript strict |
| 样式 | Tailwind CSS 3 + CSS 变量 |
| 状态 | Zustand |
| 持久化 | sql.js (WASM SQLite) |
| 密钥存储 | electron-store v8 |
| Markdown | react-markdown + remark-gfm |

## License

AGPL-3.0-or-later
