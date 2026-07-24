# MoA Desktop

**Mixture of Agents (MoA) 桌面客户端** — 一个本地化的多模型聚合聊天桌面应用。通过并行调用多个子模型，再由聚合模型综合各子模型输出，产生更高质量的答案。

---

## 功能特性

- **🧠 智能聚合模式 A** — 并行调用多个子模型 → 聚合模型综合输出最终答案
- **📊 原始对比模式 D** — 同时查看多个模型的原始输出，手动比较
- **🔌 本地 API 代理** — 内置 Express 服务器 (port 28888)，兼容 OpenAI API 格式
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
│   ├── proxy/         # Express API 代理 (port 28888)
│   │   └── server.ts  # /v1/chat/completions, /health, passthrough
│   ├── db/            # sql.js 持久化
│   │   ├── database.ts # WASM SQLite 封装 + 自动保存
│   │   └── schema.ts   # 5 表定义
│   ├── moa/           # MoA 聚合引擎
│   │   ├── moaEngine.ts       # 编排器
│   │   ├── subModelCaller.ts  # 并行子模型调用
│   │   ├── aggregationPrompt.ts # 聚合提示词
│   │   └── moaConfig.ts       # 配置持久化
│   ├── providers/     # 厂商管理
│   │   └── providerManager.ts # CRUD + 模板 + 模型缓存
│   └── store/         # 加密 Key 存储 (electron-store)
│       └── key-store.ts
├── preload/
│   └── index.ts       # 12 IPC 桥接 (contextBridge)
├── renderer/          # React 18 UI
│   ├── src/
│   │   ├── components/  # 8 个 UI 组件
│   │   ├── store/       # Zustand 状态管理
│   │   └── lib/         # 工具函数
│   └── index.html
└── shared/            # 跨进程类型
    ├── types.ts
    ├── defaults.ts
    ├── ipc-channels.ts
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
4. 切换到 **MoA** Tab，选择子模型和聚合模型（可选）
5. 回到 **对话** Tab，选择模式开始聊天

### API 代理

内置代理地址：`http://127.0.0.1:28888`

- `GET /health` — 健康检查
- `GET /v1/models` — 模型列表
- `POST /v1/chat/completions` — 聊天补全（支持 stream）

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

MIT
