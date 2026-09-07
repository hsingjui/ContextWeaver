# Directory Structure

> How backend code is organized in this project.

---

## Overview

ContextWeaver 是纯后端 TypeScript 项目（Node.js CLI + MCP server，ESM）。所有源码位于 `src/`，
每个功能模块是一个目录，通过该目录下的 `index.ts`（barrel 文件）对外导出公共 API。
模块之间只允许通过 barrel 文件导入，禁止跨目录深层相对路径导入。

---

## Directory Layout

```
src/
├── index.ts            # CLI 入口 (cac)，必须最先 import './config.js'
├── config.ts           # 统一配置：env 加载、API 配置、忽略模式（最先加载）
├── api/                # 外部 HTTP API 客户端（embedding / reranker）
├── chunking/           # AST 语义分片（tree-sitter）：SemanticSplitter、ParserPool、LanguageSpec、SourceAdapter
├── db/                 # SQLite 数据访问（better-sqlite3），FTS5 表定义在 search/fts.ts
├── indexer/            # 向量索引编排：chunking → embedding → LanceDB
├── mcp/                # MCP server（server.ts）+ tools/（每个 MCP 工具一个文件）
├── scanner/            # 文件系统扫描：crawler、filter、processor、语言检测、hash
├── search/             # 混合搜索：SearchService、fts、ContextPacker、CoverageSelector、GraphExpander
│   └── resolvers/      # 跨文件 import 解析器（每种语言一个文件）
├── utils/              # 通用工具：logger、进程锁、字节↔字符编码
└── vectorStore/        # LanceDB 适配层

tests/                  # node:test 测试（tests/*.test.ts）
benchmarks/retrieval/   # 检索基准测试 harness
docs/                   # 文档与架构图
```

## Module Organization

- 每个功能域一个目录，目录内 `index.ts` 只重新导出公共符号（如 `src/scanner/index.ts`）。
- 依赖方向保持单向：`scanner → db/indexer/vectorStore`，`search → db/vectorStore/indexer`。
- 跨模块共享的配置放 `src/config.ts`，搜索参数默认值放 `src/search/config.ts`。
- 新的 MCP 工具进 `src/mcp/tools/`，并在 `src/mcp/tools/index.ts` 注册。

## Naming Conventions

- 文件名：小写 kebab-case（`embedding.ts`、`codebaseRetrieval.ts`）；一个文件一个主类时用
  PascalCase（`SemanticSplitter.ts`、`SearchService.ts`、`ContextPacker.ts`、`JsTsResolver.ts`）。
- 目录名：单数小写（`src/db`、`src/search`），工具目录 `src/mcp/tools`。
- 类型名：PascalCase；接口不加 `I` 前缀。
- 相对导入必须带 `.js` 后缀（ESM + `verbatimModuleSyntax`），例如 `from '../config.js'`。

## Examples

- 模块 barrel 模式：`src/scanner/index.ts` 聚合导出 scan/ScanStats/ProgressCallback。
- 分语言解析器组织：`src/search/resolvers/` 每语言一个文件 + `index.ts` 工厂分发。