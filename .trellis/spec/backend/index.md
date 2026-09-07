# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

ContextWeaver 是纯后端 TypeScript 项目（Node.js CLI + MCP server）：语义检索引擎，混合搜索
（向量 + FTS5）、AST 语义分片（tree-sitter）、三阶段上下文扩展、Token 感知打包。
无前端代码。以下规范基于 `src/` 实际代码总结，子代理实现时必须匹配这些既有模式。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Filled |
| [Database Guidelines](./database-guidelines.md) | SQLite (better-sqlite3), schema, transactions | Filled |
| [Error Handling](./error-handling.md) | Error types, handling strategies | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Biome, tsc, node:test, forbidden patterns | Filled |
| [Logging Guidelines](./logging-guidelines.md) | pino, log levels, MCP stdio rules | Filled |

---

## Key Conventions (quick reference)

- ESM + `import type`（verbatimModuleSyntax），相对导入带 `.js` 后缀。
- 日志/错误消息用中文；标识符、类型、interface 用英文 PascalCase / camelCase。
- 每个功能目录一个 `index.ts` barrel 文件对外导出。
- 配置只从 `src/config.ts` 读取；所有模块在 `import './config.js'` 之后加载。
- 数据库访问经 `src/db/`，向量存取经 `src/vectorStore/`，二者由 `vector_index_hash` 对齐。