# MoA Desktop

> Mixture of Agents (MoA) 桌面客户端 — 本地 API 代理 + 全功能聊天面板。

一个混合模型桌面客户端。核心是 OpenAI 兼容的 API 代理服务器（端口 28888），以 MoA 方式并行调用多个子模型后聚合输出，附带全功能聊天面板和用量统计管理界面。

详见 [产品设计文档](产品设计文档_v1.md)。

## 技术栈

- **框架**: Electron 33+ / React 18 / TypeScript
- **样式**: Tailwind CSS v3 + Shadcn/ui
- **状态**: Zustand
- **存储**: sql.js / electron-store
- **代理**: Express
- **打包**: electron-builder

## 开发

```bash
npm install
npm run dev
```
