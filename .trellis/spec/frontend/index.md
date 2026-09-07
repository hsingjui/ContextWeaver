# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

**本项目没有前端代码。** ContextWeaver 是纯后端 TypeScript 项目：Node.js CLI
（`src/index.ts`）+ MCP stdio server（`src/mcp/server.ts`），无 Web/UI 层，
package.json 中无任何前端依赖（无 React/Vue/构建前端产物）。

该目录保留作为 Trellis 双 layer（backend/frontend）脚手架的占位。若未来引入
前端（如 Web UI / VSCode 扩展），再按实际技术栈填充以下文件。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Component/page/hook organization | N/A — no frontend |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | N/A — no frontend |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | N/A — no frontend |
| [State Management](./state-management.md) | Local state, global state, server state | N/A — no frontend |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | N/A — no frontend |
| [Type Safety](./type-safety.md) | Type patterns, validation | N/A — no frontend |

---

## Backend-Only Development Rules (applies to ALL code in this repo)

子代理在本仓库写任何代码都遵循 backend 规范：

- TypeScript 严格模式 + ESM，`import type`（verbatimModuleSyntax）。
- 日志/错误消息用中文；标识符用英文。
- 相对导入带 `.js` 后缀。
- 新功能优先 CLI 命令（cac）或 MCP 工具（`src/mcp/tools/`），不要引入前端框架。