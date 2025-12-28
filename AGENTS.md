# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

ContextWeaver 是一个为 AI 代码助手设计的语义检索引擎，采用混合搜索（向量 + 词法）、智能上下文扩展和 Token 感知打包策略。

## Development Commands

```bash
# Build
pnpm build                    # 编译 TypeScript (tsup)

# Development
pnpm dev                      # Watch 模式开发

# Run locally
pnpm start                    # 运行编译后的 CLI
node dist/index.js            # 直接运行

# CLI usage
contextweaver init            # 初始化配置文件 (~/.contextweaver/.env)
contextweaver index [path]    # 索引代码库
contextweaver search          # 本地搜索
contextweaver mcp             # 启动 MCP 服务端
```

## Architecture

### Core Pipeline

```
索引: Crawler → Processor → SemanticSplitter → Indexer → VectorStore/SQLite
搜索: Query → Vector+FTS Recall → RRF Fusion → Rerank → GraphExpander → ContextPacker
```

### Key Modules

| Module | Location | Responsibility |
|--------|----------|----------------|
| **SearchService** | `src/search/SearchService.ts` | 混合搜索核心，协调向量/词法召回、RRF 融合、Rerank 精排 |
| **GraphExpander** | `src/search/GraphExpander.ts` | 三阶段上下文扩展 (E1 邻居/E2 面包屑/E3 导入) |
| **ContextPacker** | `src/search/ContextPacker.ts` | 段落合并和 Token 预算控制 |
| **SemanticSplitter** | `src/chunking/SemanticSplitter.ts` | AST 语义分片器 (Tree-sitter) |
| **VectorStore** | `src/vectorStore/index.ts` | LanceDB 适配层 |
| **Database** | `src/db/index.ts` | SQLite + FTS5 元数据和全文索引 |
| **MCP Server** | `src/mcp/server.ts` | Model Context Protocol 服务端实现 |

### Import Resolvers

跨文件依赖解析器位于 `src/search/resolvers/`，支持 JS/TS、Python、Go、Java、Rust。

### Configuration

- 环境变量配置: `~/.contextweaver/.env`
- 搜索参数配置: `src/search/config.ts`
- 日志文件: `~/.contextweaver/logs/app.YYYY-MM-DD.log`

## Code Conventions

- TypeScript ESM 模块 (`"type": "module"`)
- 使用 tsup 打包
- Node.js >= 20
- pnpm 作为包管理器

<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->
