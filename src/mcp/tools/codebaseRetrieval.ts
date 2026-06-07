/**
 * codebase-retrieval MCP Tool
 *
 * 代码检索工具
 *
 * 设计理念：
 * - 意图与术语分离：LLM 只需区分"语义意图"和"精确术语"
 * - 回归代理本能：工具只负责定位，跨文件探索由 Agent 自主发起
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { generateProjectId } from '../../db/index.js';
// 注意：SearchService 和 scan 改为延迟导入，避免在 MCP 启动时就加载 native 模块
import type { ScanStats } from '../../scanner/index.js';
import type { ContextPack, Segment } from '../../search/types.js';
import { logger } from '../../utils/logger.js';

// 工具 Schema (暴露给 LLM)

export const codebaseRetrievalSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  information_request: z
    .string()
    .describe(
      "The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')",
    ),
  technical_terms: z
    .array(z.string())
    .optional()
    .describe(
      'HARD FILTERS. Precise identifiers to narrow down results. Only use symbols KNOWN to exist to avoid false negatives.',
    ),
});

export type CodebaseRetrievalInput = z.infer<typeof codebaseRetrievalSchema>;

// ===========================================
// 自动索引逻辑
// ===========================================

const BASE_DIR = path.join(os.homedir(), '.contextweaver');
const INDEX_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 确保默认 .env 文件存在
 *
 * 如果 ~/.contextweaver/.env 不存在，则创建包含默认配置的文件
 */
async function ensureDefaultEnvFile(): Promise<void> {
  const configDir = BASE_DIR;
  const envFile = path.join(configDir, '.env');

  // 检查文件是否已存在
  if (fs.existsSync(envFile)) {
    return;
  }

  // 创建配置目录
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    logger.info({ configDir }, '创建配置目录');
  }

  // 写入默认配置
  const defaultEnvContent = `# ContextWeaver 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024

# Voyage 兼容配置（可选）
# EMBEDDINGS_PROVIDER=voyage
# EMBEDDINGS_BASE_URL=https://api.voyageai.com/v1/embeddings
# EMBEDDINGS_MODEL=voyage-code-3
# EMBEDDINGS_OUTPUT_DIMENSION=1024
# EMBEDDINGS_TRUNCATION=true

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules
`;

  fs.writeFileSync(envFile, defaultEnvContent);
  logger.info({ envFile }, '已创建默认 .env 配置文件');
}

/**
 * 检测代码库是否已初始化（数据库是否存在）
 */
function isProjectIndexed(projectId: string): boolean {
  const dbPath = path.join(BASE_DIR, projectId, 'index.db');
  return fs.existsSync(dbPath);
}

/**
 * 确保代码库已索引
 *
 * 策略：
 * - 如果代码库未初始化（数据库不存在），执行完整索引
 * - 如果已初始化，执行增量索引（只索引变更的文件）
 * - 使用文件锁防止多进程竞态
 *
 * @param repoPath 代码库路径
 * @param projectId 项目 ID
 * @param onProgress 可选的进度回调
 */
async function ensureIndexed(
  repoPath: string,
  projectId: string,
  onProgress?: (current: number, total?: number, message?: string) => void,
): Promise<ScanStats> {
  // 延迟导入锁和 scan 函数（避免 MCP 启动时加载 native 模块）
  const { withLock } = await import('../../utils/lock.js');
  const { scan } = await import('../../scanner/index.js');

  return withLock(projectId, 'index', async () => {
    const wasIndexed = isProjectIndexed(projectId);

    if (!wasIndexed) {
      logger.info(
        { repoPath, projectId: projectId.slice(0, 10) },
        '代码库未初始化，开始首次索引...',
      );
      onProgress?.(0, 100, '代码库未索引，开始首次索引...');
    } else {
      logger.debug({ projectId: projectId.slice(0, 10) }, '执行增量索引...');
    }

    const startTime = Date.now();
    const stats = await scan(repoPath, { vectorIndex: true, onProgress });
    const elapsed = Date.now() - startTime;

    logger.info(
      {
        projectId: projectId.slice(0, 10),
        isFirstTime: !wasIndexed,
        totalFiles: stats.totalFiles,
        added: stats.added,
        modified: stats.modified,
        deleted: stats.deleted,
        vectorIndex: stats.vectorIndex,
        elapsedMs: elapsed,
      },
      '索引完成',
    );

    return stats;
  }, INDEX_LOCK_TIMEOUT_MS);
}

// 工具处理函数

/** 进度回调类型 */
export type ProgressCallback = (current: number, total?: number, message?: string) => void;

/**
 * 处理 codebase-retrieval 工具调用
 *
 * @param args 工具输入参数
 * @param onProgress 可选的进度回调（用于 MCP 进度通知）
 */
export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalInput,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { repo_path, information_request, technical_terms } = args;

  logger.info(
    {
      repo_path,
      information_request,
      technical_terms,
    },
    'MCP codebase-retrieval 调用开始',
  );

  // 0. 检查必需的环境变量是否已配置（Embedding + Reranker 都是必需的）
  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../../config.js');
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (allMissingVars.length > 0) {
    logger.warn({ missingVars: allMissingVars }, 'MCP 环境变量未配置');
    // 自动创建默认 .env 文件
    await ensureDefaultEnvFile();
    return formatEnvMissingResponse(allMissingVars);
  }

  // 1. 生成项目 ID（与 CLI 保持一致：路径 + 目录创建时间）
  const projectId = generateProjectId(repo_path);

  // 2. 确保代码库已索引（自动初始化 + 增量更新）
  const indexStats = await ensureIndexed(repo_path, projectId, onProgress);
  if (indexStats.vectorIndex && indexStats.vectorIndex.errors > 0) {
    logger.warn(
      {
        projectId: projectId.slice(0, 10),
        vectorIndex: indexStats.vectorIndex,
      },
      '向量索引失败，返回重建索引提示',
    );
    return formatVectorIndexFailedResponse(repo_path, indexStats);
  }

  // 3. 合并查询
  // - 保留既有行为：technical_terms 继续增强 semantic / lexical query
  // - 同时 technical_terms 也会传入 SearchService 走独立 fixed-string exact 召回
  const query = [information_request, ...(technical_terms || [])].filter(Boolean).join(' ');

  logger.info(
    {
      projectId: projectId.slice(0, 10),
      query,
      technical_terms,
    },
    'MCP 查询构建',
  );

  // 4. 延迟导入 SearchService（避免 MCP 启动时加载 native 模块）
  const { SearchService } = await import('../../search/SearchService.js');

  // 5. 创建 SearchService 实例
  const service = new SearchService(projectId, repo_path);
  await service.init();
  logger.debug('SearchService 初始化完成');

  // 6. 执行搜索
  const contextPack = await service.buildContextPack(query, technical_terms ?? []);

  // 详细日志：seeds 信息
  if (contextPack.seeds.length > 0) {
    logger.info(
      {
        exactSeedCount: contextPack.debug?.exactSeedCount ?? contextPack.seeds.filter((s) => s.source === 'exact').length,
        lexicalSeedCount: contextPack.seeds.filter((s) => s.source === 'lexical').length,
        vectorSeedCount: contextPack.seeds.filter((s) => s.source === 'vector').length,
        exactCandidateCount: contextPack.debug?.exactCandidateCount,
        exactScanChunkCount: contextPack.debug?.exactScanChunkCount,
        exactScanElapsedMs: contextPack.debug?.exactScanElapsedMs,
        exactHitsTruncated: contextPack.debug?.exactHitsTruncated,
        missingExactTechnicalTerms: contextPack.missingExactTechnicalTerms,
        skippedTechnicalTerms: contextPack.debug?.skippedTechnicalTerms,
        seeds: contextPack.seeds.map((s) => ({
          file: s.filePath,
          chunk: s.chunkIndex,
          score: s.score.toFixed(4),
          source: s.source,
        })),
      },
      'MCP 搜索 seeds',
    );
  } else {
    logger.warn('MCP 搜索无 seeds 命中');
  }

  // 详细日志：扩展结果
  if (contextPack.expanded.length > 0) {
    logger.debug(
      {
        expandedCount: contextPack.expanded.length,
        expanded: contextPack.expanded.slice(0, 5).map((e) => ({
          file: e.filePath,
          chunk: e.chunkIndex,
          score: e.score.toFixed(4),
        })),
      },
      'MCP 扩展结果 (前5)',
    );
  }

  // 详细日志：打包后的文件段落
  logger.info(
    {
      seedCount: contextPack.seeds.length,
      expandedCount: contextPack.expanded.length,
      fileCount: contextPack.files.length,
      totalSegments: contextPack.files.reduce((acc, f) => acc + f.segments.length, 0),
      files: contextPack.files.map((f) => ({
        path: f.filePath,
        segments: f.segments.length,
        lines: f.segments.map((s) => `L${s.startLine}-${s.endLine}`),
      })),
      timingMs: contextPack.debug?.timingMs,
      exactSeedCount: contextPack.debug?.exactSeedCount,
      exactCandidateCount: contextPack.debug?.exactCandidateCount,
      exactScanChunkCount: contextPack.debug?.exactScanChunkCount,
      exactScanElapsedMs: contextPack.debug?.exactScanElapsedMs,
      exactHitsTruncated: contextPack.debug?.exactHitsTruncated,
      missingExactTechnicalTerms: contextPack.missingExactTechnicalTerms,
      skippedTechnicalTerms: contextPack.debug?.skippedTechnicalTerms,
    },
    'MCP codebase-retrieval 完成',
  );

  // 7. 格式化输出
  return formatMcpResponse(contextPack);
}

/**
 * 格式化向量索引失败响应
 */
function formatVectorIndexFailedResponse(
  repoPath: string,
  stats: ScanStats,
): { content: Array<{ type: 'text'; text: string }> } {
  const vectorIndex = stats.vectorIndex;
  const text = `## 向量索引失败

Embedding 阶段有 ${vectorIndex?.errors ?? 0} 个文件索引失败，本次检索未继续执行。

请修复 Embedding 配置或网络问题后重新创建索引：

\`\`\`bash
contextweaver index "${repoPath}" --force
\`\`\`
`;

  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

// 响应格式化

/**
 * 格式化为 MCP 响应格式
 */
function formatMcpResponse(pack: ContextPack): { content: Array<{ type: 'text'; text: string }> } {
  const { files, seeds } = pack;

  // 构建文件内容块
  const fileBlocks = files
    .map((file) => {
      const segments = file.segments.map((seg) => formatSegment(seg)).join('\n\n');
      return segments;
    })
    .join('\n\n---\n\n');

  const missingTermsLine =
    pack.missingExactTechnicalTerms && pack.missingExactTechnicalTerms.length > 0
      ? `Missing exact technical terms: ${pack.missingExactTechnicalTerms.join(', ')}`
      : undefined;

  const exactDebug = pack.debug;
  const skippedTerms = exactDebug?.skippedTechnicalTerms ?? [];
  const hasExactDebug =
    exactDebug !== undefined &&
    ((exactDebug.exactSeedCount ?? 0) > 0 ||
      (exactDebug.exactCandidateCount ?? 0) > 0 ||
      (exactDebug.exactScanChunkCount ?? 0) > 0 ||
      exactDebug.exactHitsTruncated === true ||
      (pack.missingExactTechnicalTerms?.length ?? 0) > 0 ||
      skippedTerms.length > 0);
  const exactSummaryItems =
    exactDebug && hasExactDebug
      ? [
          typeof exactDebug.exactSeedCount === 'number'
            ? `seeds=${exactDebug.exactSeedCount}`
            : undefined,
          typeof exactDebug.exactCandidateCount === 'number'
            ? `candidates=${exactDebug.exactCandidateCount}`
            : undefined,
          typeof exactDebug.exactScanChunkCount === 'number'
            ? `scanned=${exactDebug.exactScanChunkCount}`
            : undefined,
          typeof exactDebug.exactScanElapsedMs === 'number'
            ? `elapsed=${exactDebug.exactScanElapsedMs}ms`
            : undefined,
          typeof exactDebug.exactHitsTruncated === 'boolean'
            ? `truncated=${exactDebug.exactHitsTruncated}`
            : undefined,
        ].filter(Boolean)
      : [];
  const exactSummaryLine =
    exactSummaryItems.length > 0 ? `Exact: ${exactSummaryItems.join(', ')}` : undefined;
  const skippedTermsLine =
    skippedTerms.length > 0 ? `Skipped exact technical terms: ${skippedTerms.join(', ')}` : undefined;

  // 构建摘要
  const summary = [
    `Found ${seeds.length} relevant code blocks`,
    `Files: ${files.length}`,
    `Total segments: ${files.reduce((acc, f) => acc + f.segments.length, 0)}`,
    missingTermsLine,
    exactSummaryLine,
    skippedTermsLine,
  ]
    .filter(Boolean)
    .join(' | ');

  const text = `${summary}\n\n${fileBlocks}`;

  return {
    content: [
      {
        type: 'text',
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
  const breadcrumb = seg.breadcrumb ? `> ${seg.breadcrumb}` : '';
  const code = `\`\`\`${lang}\n${seg.text}\n\`\`\``;

  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

/**
 * 根据文件扩展名检测语言
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    toml: 'toml',
  };
  return langMap[ext] || ext || 'plaintext';
}

/**
 * 格式化环境变量缺失的响应
 *
 * 当用户未配置必需的环境变量时，返回友好的提示信息
 */
function formatEnvMissingResponse(missingVars: string[]): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const configPath = '~/.contextweaver/.env';

  const text = `## ⚠️ 配置缺失

ContextWeaver 需要配置 Embedding API 才能工作。

### 缺失的环境变量
${missingVars.map((v) => `- \`${v}\``).join('\n')}

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
        type: 'text',
        text,
      },
    ],
  };
}
