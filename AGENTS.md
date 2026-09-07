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
<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
