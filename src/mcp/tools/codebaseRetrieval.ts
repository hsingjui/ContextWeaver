/**
 * codebase-retrieval MCP Tool
 * 
 * 极简主义 (Zen Design) 代码检索工具
 * 
 * 设计理念：
 * - 意图与术语分离：LLM 只需区分"语义意图"和"精确术语"
 * - 黄金默认值：提供同文件上下文，禁止跨文件抓取
 * - 回归代理本能：工具只负责定位，跨文件探索由 Agent 自主发起
 */

import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";
// 注意：SearchService 和 scan 改为延迟导入，避免在 MCP 启动时就加载 native 模块
import type { SearchConfig, ContextPack, Segment } from "../../search/types.js";
import { generateProjectId } from "../../db/index.js";
import { logger } from "../../utils/logger.js";

// 工具 Schema (暴露给 LLM)

export const codebaseRetrievalSchema = z.object({
    repo_path: z
        .string()
        .describe("The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')"),
    information_request: z
        .string()
        .describe("The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')"),
    technical_terms: z
        .array(z.string())
        .optional()
        .describe("HARD FILTERS. Precise identifiers to narrow down results. Only use symbols KNOWN to exist to avoid false negatives."),
});

export type CodebaseRetrievalInput = z.infer<typeof codebaseRetrievalSchema>;

// 默认配置 (Zen Config)

/**
 * MCP 工具专用配置覆盖
 * 
 * 目标：提供足够看懂当前文件的上下文，但不跨文件
 */
const ZEN_CONFIG_OVERRIDE: Partial<SearchConfig> = {
    // E1: 邻居扩展 - 前后看 2 个 chunk，保证代码块完整性
    neighborHops: 2,

    // E2: 面包屑补全 - 必须开启，保证能看到当前方法所属的 Class/Function 定义
    breadcrumbExpandLimit: 3,

    // E3: Import 扩展 - 强制关闭！
    // 理由：跨文件是 Agent 的决策，不要预加载，防止 Token 爆炸
    importFilesPerSeed: 0,
    chunksPerImportFile: 0,
};

// ===========================================
// 自动索引逻辑
// ===========================================

const BASE_DIR = path.join(os.homedir(), ".contextweaver");

/**
 * 确保默认 .env 文件存在
 * 
 * 如果 ~/.contextweaver/.env 不存在，则创建包含默认配置的文件
 */
async function ensureDefaultEnvFile(): Promise<void> {
    const configDir = BASE_DIR;
    const envFile = path.join(configDir, ".env");

    // 检查文件是否已存在
    if (fs.existsSync(envFile)) {
        return;
    }

    // 创建配置目录
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
        logger.info({ configDir }, "创建配置目录");
    }

    // 写入默认配置
    const defaultEnvContent = `# ContextWeaver 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules
`;

    fs.writeFileSync(envFile, defaultEnvContent);
    logger.info({ envFile }, "已创建默认 .env 配置文件");
}

/**
 * 检测代码库是否已初始化（数据库是否存在）
 */
function isProjectIndexed(projectId: string): boolean {
    const dbPath = path.join(BASE_DIR, projectId, "index.db");
    return fs.existsSync(dbPath);
}

/**
 * 确保代码库已索引
 * 
 * 策略：
 * - 如果代码库未初始化（数据库不存在），执行完整索引
 * - 如果已初始化，执行增量索引（只索引变更的文件）
 * 
 * @param repoPath 代码库路径
 * @param projectId 项目 ID
 */
async function ensureIndexed(repoPath: string, projectId: string): Promise<void> {
    const wasIndexed = isProjectIndexed(projectId);

    // 延迟导入 scan 函数（避免 MCP 启动时加载 native 模块）
    const { scan } = await import("../../scanner/index.js");

    if (!wasIndexed) {
        logger.info({ repoPath, projectId: projectId.slice(0, 10) }, "代码库未初始化，开始首次索引...");
    } else {
        logger.debug({ projectId: projectId.slice(0, 10) }, "执行增量索引...");
    }

    const startTime = Date.now();
    const stats = await scan(repoPath, { vectorIndex: true });
    const elapsed = Date.now() - startTime;

    logger.info({
        projectId: projectId.slice(0, 10),
        isFirstTime: !wasIndexed,
        totalFiles: stats.totalFiles,
        added: stats.added,
        modified: stats.modified,
        deleted: stats.deleted,
        vectorIndex: stats.vectorIndex,
        elapsedMs: elapsed,
    }, "索引完成");
}

// 工具处理函数

/**
 * 处理 codebase-retrieval 工具调用
 */
export async function handleCodebaseRetrieval(
    args: CodebaseRetrievalInput,
    configOverride: Partial<SearchConfig> = ZEN_CONFIG_OVERRIDE
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { repo_path, information_request, technical_terms } = args;

    logger.info({
        repo_path,
        information_request,
        technical_terms,
    }, "MCP codebase-retrieval 调用开始");

    // 0. 检查必需的环境变量是否已配置（Embedding + Reranker 都是必需的）
    const { checkEmbeddingEnv, checkRerankerEnv } = await import("../../config.js");
    const embeddingCheck = checkEmbeddingEnv();
    const rerankerCheck = checkRerankerEnv();
    const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

    if (allMissingVars.length > 0) {
        logger.warn({ missingVars: allMissingVars }, "MCP 环境变量未配置");
        // 自动创建默认 .env 文件
        await ensureDefaultEnvFile();
        return formatEnvMissingResponse(allMissingVars);
    }

    // 1. 生成项目 ID（与 CLI 保持一致：路径 + 目录创建时间）
    const projectId = generateProjectId(repo_path);

    // 2. 确保代码库已索引（自动初始化 + 增量更新）
    await ensureIndexed(repo_path, projectId);

    // 3. 合并查询
    // - information_request 驱动语义向量搜索
    // - technical_terms 增强词法（FTS）匹配
    const query = [
        information_request,
        ...(technical_terms || []),
    ].filter(Boolean).join(" ");

    logger.info({
        projectId: projectId.slice(0, 10),
        query,
        zenConfig: configOverride,
    }, "MCP 查询构建");

    // 4. 延迟导入 SearchService（避免 MCP 启动时加载 native 模块）
    const { SearchService } = await import("../../search/SearchService.js");

    // 5. 创建 SearchService 实例（使用 Zen Config）
    const service = new SearchService(projectId, repo_path, configOverride);
    await service.init();
    logger.debug("SearchService 初始化完成");

    // 6. 执行搜索
    const contextPack = await service.buildContextPack(query);

    // 详细日志：seeds 信息
    if (contextPack.seeds.length > 0) {
        logger.info({
            seeds: contextPack.seeds.map(s => ({
                file: s.filePath,
                chunk: s.chunkIndex,
                score: s.score.toFixed(4),
                source: s.source,
            })),
        }, "MCP 搜索 seeds");
    } else {
        logger.warn("MCP 搜索无 seeds 命中");
    }

    // 详细日志：扩展结果
    if (contextPack.expanded.length > 0) {
        logger.debug({
            expandedCount: contextPack.expanded.length,
            expanded: contextPack.expanded.slice(0, 5).map(e => ({
                file: e.filePath,
                chunk: e.chunkIndex,
                score: e.score.toFixed(4),
            })),
        }, "MCP 扩展结果 (前5)");
    }

    // 详细日志：打包后的文件段落
    logger.info({
        seedCount: contextPack.seeds.length,
        expandedCount: contextPack.expanded.length,
        fileCount: contextPack.files.length,
        totalSegments: contextPack.files.reduce((acc, f) => acc + f.segments.length, 0),
        files: contextPack.files.map(f => ({
            path: f.filePath,
            segments: f.segments.length,
            lines: f.segments.map(s => `L${s.startLine}-${s.endLine}`),
        })),
        timingMs: contextPack.debug?.timingMs,
    }, "MCP codebase-retrieval 完成");

    // 7. 格式化输出
    return formatMcpResponse(contextPack, information_request);
}

// 响应格式化

/**
 * 格式化为 MCP 响应格式
 */
function formatMcpResponse(
    pack: ContextPack,
    originalRequest: string
): { content: Array<{ type: "text"; text: string }> } {
    const { files, seeds } = pack;

    // 构建文件内容块
    const fileBlocks = files.map(file => {
        const segments = file.segments
            .map(seg => formatSegment(seg))
            .join("\n\n");
        return segments;
    }).join("\n\n---\n\n");

    // 构建摘要
    const summary = [
        `Found ${seeds.length} relevant code blocks for: "${originalRequest}"`,
        `Files: ${files.length}`,
        `Total segments: ${files.reduce((acc, f) => acc + f.segments.length, 0)}`,
    ].join(" | ");

    const text = `${summary}\n\n${fileBlocks}`;

    return {
        content: [
            {
                type: "text",
                text,
            },
        ],
    };
}

/**
 * 格式化单个代码段
 */
function formatSegment(seg: Segment): string {
    const lang = detectLanguage(seg.filePath);
    const header = `## ${seg.filePath} (L${seg.startLine}-${seg.endLine})`;
    const breadcrumb = seg.breadcrumb ? `> ${seg.breadcrumb}` : "";
    const code = "```" + lang + "\n" + seg.text + "\n```";

    return [header, breadcrumb, code].filter(Boolean).join("\n");
}

/**
 * 根据文件扩展名检测语言
 */
function detectLanguage(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const langMap: Record<string, string> = {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        py: "python",
        rs: "rust",
        go: "go",
        java: "java",
        c: "c",
        cpp: "cpp",
        h: "c",
        hpp: "cpp",
        cs: "csharp",
        rb: "ruby",
        php: "php",
        swift: "swift",
        kt: "kotlin",
        scala: "scala",
        sql: "sql",
        sh: "bash",
        bash: "bash",
        zsh: "bash",
        json: "json",
        yaml: "yaml",
        yml: "yaml",
        xml: "xml",
        html: "html",
        css: "css",
        scss: "scss",
        less: "less",
        md: "markdown",
        toml: "toml",
    };
    return langMap[ext] || ext || "plaintext";
}

/**
 * 格式化环境变量缺失的响应
 * 
 * 当用户未配置必需的环境变量时，返回友好的提示信息
 */
function formatEnvMissingResponse(
    missingVars: string[]
): { content: Array<{ type: "text"; text: string }> } {
    const configPath = "~/.contextweaver/.env";

    const text = `## ⚠️ 配置缺失

ContextWeaver 需要配置 Embedding API 才能工作。

### 缺失的环境变量
${missingVars.map(v => `- \`${v}\``).join("\n")}

### 配置步骤

已自动创建配置文件：\`${configPath}\`

请编辑该文件，填写你的 API Key：

\`\`\`bash
# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here  # ← 替换为你的 API Key

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here      # ← 替换为你的 API Key
\`\`\`

保存文件后重新调用此工具即可。
`;

    return {
        content: [
            {
                type: "text",
                text,
            },
        ],
    };
}
