# ContextWeaver

<p align="center">
  <strong>🧵 为 AI Agent 精心编织的代码库上下文引擎</strong>
</p>

<p align="center">
  <em>Semantic Code Retrieval for AI Agents — Hybrid Search • Graph Expansion • Token-Aware Packing</em>
</p>

---

**ContextWeaver** 是一个专为 AI 代码助手设计的语义检索引擎，采用混合搜索（向量 + 词法）、智能上下文扩展和 Token 感知打包策略，为 LLM 提供精准、相关且上下文完整的代码片段。

<p align="center">
  <img src="docs/architecture.png" alt="ContextWeaver 架构概览" width="800" />
</p>

## ✨ 核心特性

### 🔍 混合检索引擎
- **向量召回 (Vector Retrieval)**：基于语义相似度的深度理解
- **词法召回 (Lexical/FTS)**：精确匹配函数名、类名等技术术语
- **RRF 融合 (Reciprocal Rank Fusion)**：智能融合多路召回结果

### 🧠 AST 语义分片
- **Tree-sitter 解析**：支持 TypeScript、JavaScript、Python、Go、Java、Rust 六大语言
- **Dual-Text 策略**：`displayCode` 用于展示，`vectorText` 用于 Embedding
- **Gap-Aware 合并**：智能处理代码间隙，保持语义完整性
- **Breadcrumb 注入**：向量文本包含层级路径，提升检索召回率

### 📊 三阶段上下文扩展
- **E1 邻居扩展**：同文件前后相邻 chunks，保证代码块完整性
- **E2 面包屑补全**：同一类/函数下的其他方法，理解整体结构
- **E3 Import 解析**：跨文件依赖追踪（可配置开关）

### 🎯 智能截断策略 (Smart TopK)
- **Anchor & Floor**：动态阈值 + 绝对下限双保险
- **Delta Guard**：防止 Top1 outlier 场景的误判
- **Safe Harbor**：前 N 个结果只检查下限，保证基本召回

### 🔌 MCP 原生支持
- **MCP Server 模式**：一键启动 Model Context Protocol 服务端
- **意图与术语分离**：LLM 友好的 API 设计
- **自动索引**：首次查询自动触发索引，增量更新透明无感

## 📦 快速开始

### 环境要求

- Node.js >= 20
- pnpm (推荐) 或 npm

### 安装

```bash
# 全局安装
npm install -g @hsingjui/contextweaver

# 或使用 pnpm
pnpm add -g @hsingjui/contextweaver
```

### 初始化配置

```bash
# 初始化配置文件（创建 ~/.contextweaver/.env）
contextweaver init
# 或简写
cw init
```

编辑 `~/.contextweaver/.env`，填入你的 API Key：

```bash
# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_BATCH_SIZE=10
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 忽略模式（可选，逗号分隔）
# IGNORE_PATTERNS=.venv,node_modules
```

### 索引代码库

```bash
# 在代码库根目录执行
contextweaver index

# 指定路径
contextweaver index /path/to/your/project

# 强制重新索引
contextweaver index --force
```

### 本地搜索

```bash
# 语义搜索
cw search --information-request "用户认证流程是如何实现的？"

# 带精确术语
cw search --information-request "数据库连接逻辑" --technical-terms "DatabasePool,Connection"
```

### 启动 MCP 服务器

```bash
# 启动 MCP 服务端（供 Claude 等 AI 助手使用）
contextweaver mcp
```

## 🔧 MCP 集成配置

### Claude Desktop 配置

在 Claude Desktop 的配置文件中添加：

```json
{
  "mcpServers": {
    "contextweaver": {
      "command": "contextweaver",
      "args": ["mcp"]
    }
  }
}
```

### MCP 工具说明

ContextWeaver 提供一个核心 MCP 工具：`codebase-retrieval`

#### 参数说明

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `repo_path` | string | ✅ | 代码库根目录的绝对路径 |
| `information_request` | string | ✅ | 自然语言形式的语义意图描述 |
| `technical_terms` | string[] | ❌ | 精确技术术语（类名、函数名等） |

#### 设计理念

- **意图与术语分离**：`information_request` 描述「做什么」，`technical_terms` 过滤「叫什么」
- **同文件上下文优先**：默认提供同文件上下文，跨文件探索由 Agent 自主发起
- **回归代理本能**：工具只负责定位，跨文件探索由 Agent 按需触发

## 🏗️ 架构设计

```mermaid
flowchart TB
    subgraph Interface["CLI / MCP Interface"]
        CLI[contextweaver CLI]
        MCP[MCP Server]
    end

    subgraph Search["SearchService"]
        VR[Vector Retrieval]
        LR[Lexical Retrieval]
        RRF[RRF Fusion + Rerank]
        VR --> RRF
        LR --> RRF
    end

    subgraph Expand["Context Expansion"]
        GE[GraphExpander]
        CP[ContextPacker]
        GE --> CP
    end

    subgraph Storage["Storage Layer"]
        VS[(VectorStore<br/>LanceDB)]
        DB[(SQLite<br/>FTS5)]
    end

    subgraph Index["Indexing Pipeline"]
        CR[Crawler<br/>fdir] --> SS[SemanticSplitter<br/>Tree-sitter] --> IX[Indexer<br/>Batch Embedding]
    end

    Interface --> Search
    RRF --> GE
    Search <--> Storage
    Expand <--> Storage
    Index --> Storage
```

### 核心模块说明

| 模块 | 职责 |
|------|------|
| **SearchService** | 混合搜索核心，协调向量/词法召回、RRF 融合、Rerank 精排 |
| **GraphExpander** | 上下文扩展器，执行 E1/E2/E3 三阶段扩展策略 |
| **ContextPacker** | 上下文打包器，负责段落合并和 Token 预算控制 |
| **VectorStore** | LanceDB 适配层，管理向量索引的增删改查 |
| **SQLite (FTS5)** | 元数据存储 + 全文搜索索引 |
| **SemanticSplitter** | AST 语义分片器，基于 Tree-sitter 解析 |

## 📁 项目结构

```
contextweaver/
├── src/
│   ├── index.ts              # CLI 入口
│   ├── config.ts             # 配置管理（环境变量）
│   ├── api/                  # 外部 API 封装
│   │   ├── embed.ts          # Embedding API
│   │   └── rerank.ts         # Reranker API
│   ├── chunking/             # 语义分片
│   │   ├── SemanticSplitter.ts   # AST 语义分片器
│   │   ├── SourceAdapter.ts      # 源码适配器
│   │   ├── LanguageSpec.ts       # 语言规范定义
│   │   └── ParserPool.ts         # Tree-sitter 解析器池
│   ├── scanner/              # 文件扫描
│   │   ├── crawler.ts        # 文件系统遍历
│   │   ├── processor.ts      # 文件处理
│   │   └── filter.ts         # 过滤规则
│   ├── indexer/              # 索引器
│   │   └── index.ts          # 批量索引逻辑
│   ├── vectorStore/          # 向量存储
│   │   └── index.ts          # LanceDB 适配层
│   ├── db/                   # 数据库
│   │   └── index.ts          # SQLite + FTS5
│   ├── search/               # 搜索服务
│   │   ├── SearchService.ts  # 核心搜索服务
│   │   ├── GraphExpander.ts  # 上下文扩展器
│   │   ├── ContextPacker.ts  # 上下文打包器
│   │   ├── fts.ts            # 全文搜索
│   │   ├── config.ts         # 搜索配置
│   │   ├── types.ts          # 类型定义
│   │   └── resolvers/        # 多语言 Import 解析器
│   │       ├── JsTsResolver.ts
│   │       ├── PythonResolver.ts
│   │       ├── GoResolver.ts
│   │       ├── JavaResolver.ts
│   │       └── RustResolver.ts
│   ├── mcp/                  # MCP 服务端
│   │   ├── server.ts         # MCP 服务器实现
│   │   ├── main.ts           # MCP 入口
│   │   └── tools/
│   │       └── codebaseRetrieval.ts  # 代码检索工具
│   └── utils/                # 工具函数
│       └── logger.ts         # 日志系统
├── package.json
└── tsconfig.json
```

## ⚙️ 配置详解

### 环境变量

| 变量名 | 必需 | 默认值 | 描述 |
|--------|------|--------|------|
| `EMBEDDINGS_API_KEY` | ✅ | - | Embedding API 密钥 |
| `EMBEDDINGS_BASE_URL` | ✅ | - | Embedding API 地址 |
| `EMBEDDINGS_MODEL` | ✅ | - | Embedding 模型名称 |
| `EMBEDDINGS_MAX_CONCURRENCY` | ❌ | 10 | Embedding 并发数 |
| `EMBEDDINGS_BATCH_SIZE` | ❌ | 10 | Embedding 单请求批次大小（input 条数） |
| `EMBEDDINGS_DIMENSIONS` | ❌ | 1024 | 向量维度 |
| `RERANK_API_KEY` | ✅ | - | Reranker API 密钥 |
| `RERANK_BASE_URL` | ✅ | - | Reranker API 地址 |
| `RERANK_MODEL` | ✅ | - | Reranker 模型名称 |
| `RERANK_TOP_N` | ❌ | 20 | Rerank 返回数量 |
| `IGNORE_PATTERNS` | ❌ | - | 额外忽略模式 |

### 搜索配置参数

```typescript
interface SearchConfig {
  // === 召回阶段 ===
  vectorTopK: number;        // 向量召回数量（默认 30）
  vectorTopM: number;        // 送入融合的向量结果数（默认 30）
  ftsTopKFiles: number;      // FTS 召回文件数（默认 15）
  lexChunksPerFile: number;  // 每文件词法 chunks 数（默认 3）
  lexTotalChunks: number;    // 词法总 chunks 数（默认 30）

  // === 融合阶段 ===
  rrfK0: number;             // RRF 平滑常数（默认 60）
  wVec: number;              // 向量权重（默认 1.0）
  wLex: number;              // 词法权重（默认 0.5）
  fusedTopM: number;         // 融合后送 rerank 数量（默认 40）

  // === Rerank ===
  rerankTopN: number;        // Rerank 后保留数量（默认 10）
  maxRerankChars: number;    // Rerank 文本最大字符数（默认 1200）

  // === 扩展策略 ===
  neighborHops: number;      // E1 邻居跳数（默认 2）
  breadcrumbExpandLimit: number;  // E2 面包屑补全数（默认 3）
  importFilesPerSeed: number;     // E3 每 seed 导入文件数（默认 0）
  chunksPerImportFile: number;    // E3 每导入文件 chunks（默认 0）

  // === Smart TopK ===
  enableSmartTopK: boolean;  // 启用智能截断（默认 true）
  smartTopScoreRatio: number;     // 动态阈值比例（默认 0.5）
  smartMinScore: number;          // 绝对下限（默认 0.25）
  smartMinK: number;              // Safe Harbor 数量（默认 2）
  smartMaxK: number;              // 硬上限（默认 15）
}
```

## 🌍 多语言支持

ContextWeaver 通过 Tree-sitter 原生支持以下编程语言的 AST 解析：

| 语言 | AST 解析 | Import 解析 | 文件扩展名 |
|------|----------|-------------|-----------|
| TypeScript | ✅ | ✅ | `.ts`, `.tsx` |
| JavaScript | ✅ | ✅ | `.js`, `.jsx`, `.mjs` |
| Python | ✅ | ✅ | `.py` |
| Go | ✅ | ✅ | `.go` |
| Java | ✅ | ✅ | `.java` |
| Rust | ✅ | ✅ | `.rs` |

其他语言会采用基于行的 Fallback 分片策略，仍可正常索引和搜索。

## 🔄 工作流程

### 索引流程

```
1. Crawler     → 遍历文件系统，过滤忽略项
2. Processor   → 读取文件内容，计算 hash
3. Splitter    → AST 解析，语义分片
4. Indexer     → 批量 Embedding，写入向量库
5. FTS Index   → 更新全文搜索索引
```

### 搜索流程

```
1. Query Parse     → 解析查询，分离语义和术语
2. Hybrid Recall   → 向量 + 词法双路召回
3. RRF Fusion      → Reciprocal Rank Fusion 融合
4. Rerank          → 交叉编码器精排
5. Smart Cutoff    → 智能分数截断
6. Graph Expand    → 邻居/面包屑/导入扩展
7. Context Pack    → 段落合并，Token 预算
8. Format Output   → 格式化返回给 LLM
```

## 📊 性能特性

- **增量索引**：只处理变更文件，二次索引速度提升 10x+
- **批量 Embedding**：自适应批次大小，支持并发控制
- **速率限制恢复**：429 错误时自动退避，渐进恢复
- **连接池复用**：Tree-sitter 解析器池化复用
- **文件索引缓存**：GraphExpander 文件路径索引 lazy load

## 🐛 日志与调试

日志文件位置：`~/.contextweaver/logs/app.YYYY-MM-DD.log`

设置日志级别：

```bash
# 开启 debug 日志
LOG_LEVEL=debug contextweaver search --information-request "..."
```

## 📄 开源协议

本项目采用 MIT 许可证。

## 🙏 致谢

- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) - 高性能语法解析
- [LanceDB](https://lancedb.com/) - 嵌入式向量数据库
- [MCP](https://modelcontextprotocol.io/) - Model Context Protocol
- [SiliconFlow](https://siliconflow.cn/) - 推荐的 Embedding/Reranker API 服务

---

<p align="center">
  <sub>Made with ❤️ for AI-assisted coding</sub>
</p>
