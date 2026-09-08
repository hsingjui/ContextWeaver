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
import { generateProjectId, migrateProjectIndex } from '../../db/index.js';
// 注意：SearchService 和 scan 改为延迟导入，避免在 MCP 启动时就加载 native 模块
import type { ContextPack, Segment } from '../../search/types.js';
import { buildDefaultEnvContent } from '../../utils/envTemplate.js';
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
async function ensureDefaultEnvFile(): Promise<boolean> {
  const configDir = BASE_DIR;
  const envFile = path.join(configDir, '.env');

  // 检查文件是否已存在
  if (fs.existsSync(envFile)) {
    return false;
  }

  // 创建配置目录
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    logger.info({ configDir }, '创建配置目录');
  }

  // 写入默认配置（模板统一由 utils/envTemplate 生成，与 CLI init 共用）
  fs.writeFileSync(envFile, buildDefaultEnvContent());
  logger.info({ envFile }, '已创建默认 .env 配置文件');
  return true;
}

/**
 * 检测代码库是否已初始化（数据库是否存在）
 */
function isProjectIndexed(projectId: string): boolean {
  migrateProjectIndex(projectId);
  const dbPath = path.join(BASE_DIR, 'index', projectId, 'index.db');
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
): Promise<void> {
  // 延迟导入锁和 scan 函数（避免 MCP 启动时加载 native 模块）
  const { withLock } = await import('../../utils/lock.js');
  const { scan } = await import('../../scanner/index.js');

  await withLock(
    projectId,
    'index',
    async () => {
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
      const stats = await scan(repoPath, {
        vectorIndex: true,
        onProgress,
      });
      const errors = stats.errors + (stats.vectorIndex?.errors ?? 0);
      if (errors > 0) throw new Error(`索引有 ${errors} 个文件失败，请重试以补全索引`);
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
    },
    INDEX_LOCK_TIMEOUT_MS,
  );
}

// 工具处理函数

/** 进度回调类型 */
export type ProgressCallback = (current: number, total?: number, message?: string) => void;

async function assertRetrievalEnvironment(): Promise<void> {
  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../../config.js');
  const missingVars = [...checkEmbeddingEnv().missingVars, ...checkRerankerEnv().missingVars];
  if (missingVars.length > 0) {
    throw new Error(`Missing retrieval environment variables: ${missingVars.join(', ')}`);
  }
}

/** CLI/MCP 内部使用：确保检索环境与索引已就绪。 */
export async function prepareCodebaseRetrieval(
  repoPath: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  await assertRetrievalEnvironment();
  await ensureIndexed(repoPath, generateProjectId(repoPath), onProgress);
}

/**
 * 在索引已就绪的前提下执行一次结构化检索。
 * 仅供同一 CLI 进程的批量模式复用，不作为 package API 暴露。
 */
export async function retrieveIndexedCodebase(args: CodebaseRetrievalInput): Promise<ContextPack> {
  const { repo_path, information_request, technical_terms } = args;
  // 环境校验由 prepareCodebaseRetrieval 统一完成（本函数所有调用方均先经 prepare）
  const projectId = generateProjectId(repo_path);

  const query = [information_request, ...(technical_terms || [])].filter(Boolean).join(' ');
  logger.info({ projectId: projectId.slice(0, 10), query }, '检索查询构建');

  const { SearchService } = await import('../../search/SearchService.js');
  const service = new SearchService(projectId, repo_path);
  await service.init();
  logger.debug('SearchService 初始化完成');

  const contextPack = await service.buildContextPack(query);

  if (contextPack.seeds.length > 0) {
    logger.info(
      {
        seeds: contextPack.seeds.map((seed) => ({
          file: seed.filePath,
          chunk: seed.chunkIndex,
          score: seed.score.toFixed(4),
          source: seed.source,
        })),
      },
      '检索 seeds',
    );
  } else {
    logger.warn('检索无 seeds 命中');
  }

  if (contextPack.expanded.length > 0) {
    logger.debug(
      {
        expandedCount: contextPack.expanded.length,
        expanded: contextPack.expanded.slice(0, 5).map((item) => ({
          file: item.filePath,
          chunk: item.chunkIndex,
          score: item.score.toFixed(4),
        })),
      },
      '检索扩展结果 (前5)',
    );
  }

  logger.info(
    {
      seedCount: contextPack.seeds.length,
      expandedCount: contextPack.expanded.length,
      fileCount: contextPack.files.length,
      totalSegments: contextPack.files.reduce((acc, file) => acc + file.segments.length, 0),
      files: contextPack.files.map((file) => ({
        path: file.filePath,
        segments: file.segments.length,
        lines: file.segments.map((segment) => `L${segment.startLine}-${segment.endLine}`),
      })),
      timingMs: contextPack.debug?.timingMs,
    },
    '代码库检索完成',
  );

  return contextPack;
}

/** 单次检索：自动刷新索引后执行。 */
export async function retrieveCodebase(
  args: CodebaseRetrievalInput,
  onProgress?: ProgressCallback,
): Promise<ContextPack> {
  await prepareCodebaseRetrieval(args.repo_path, onProgress);
  return retrieveIndexedCodebase(args);
}

/**
 * 处理 codebase-retrieval MCP 工具调用。
 */
export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalInput,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { repo_path, information_request, technical_terms } = args;

  logger.info(
    { repo_path, information_request, technical_terms },
    'MCP codebase-retrieval 调用开始',
  );

  const { checkEmbeddingEnv, checkRerankerEnv, getEmbeddingConfig } = await import(
    '../../config.js'
  );
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const embeddingConfig = embeddingCheck.isValid ? getEmbeddingConfig() : null;
  const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (allMissingVars.length > 0) {
    logger.warn({ missingVars: allMissingVars }, 'MCP 环境变量未配置');
    const configCreated = await ensureDefaultEnvFile();
    return formatEnvMissingResponse(allMissingVars, {
      configCreated,
      localModel: embeddingConfig?.provider === 'local' ? embeddingConfig.model : undefined,
      remoteEmbedding:
        embeddingConfig?.provider === 'remote' ||
        process.env.EMBEDDINGS_PROVIDER?.trim().toLowerCase() === 'remote',
    });
  }

  const contextPack = await retrieveCodebase(args, onProgress);
  return formatMcpResponse(contextPack);
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

  // 构建摘要
  const summary = [
    `Found ${seeds.length} relevant code blocks`,
    `Files: ${files.length}`,
    `Total segments: ${files.reduce((acc, f) => acc + f.segments.length, 0)}`,
  ].join(' | ');

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
interface EnvMissingContext {
  configCreated: boolean;
  localModel?: string;
  remoteEmbedding: boolean;
}

function formatEnvMissingResponse(
  missingVars: string[],
  context: EnvMissingContext,
): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const configPath = '~/.contextweaver/.env';
  const embeddingMissing = missingVars.some((name) => name.startsWith('EMBEDDINGS_'));
  const rerankerMissing = missingVars.some((name) => name.startsWith('RERANK_'));
  const actions: string[] = [];

  if (context.localModel) {
    actions.push(
      `- 若尚未安装当前本地模型，请运行 \`contextweaver model install ${context.localModel}\`。`,
    );
  } else if (context.remoteEmbedding && embeddingMissing) {
    actions.push('- 补全远程 Embedding 的 `EMBEDDINGS_*` 配置。');
  } else if (embeddingMissing) {
    actions.push('- 将 `EMBEDDINGS_PROVIDER` 设为 `local` 或 `remote`，并补全对应配置。');
  }
  if (rerankerMissing) actions.push('- 填写远程 Reranker 的 `RERANK_*` 配置。');
  actions.push('- 保存配置后重启 ContextWeaver MCP 服务，再重新调用此工具。');

  const text = `## 配置未完成

${context.remoteEmbedding ? '当前使用远程 Embedding。' : 'ContextWeaver 默认使用内置本地 Embedding，无需 Embedding API Key。'}完整检索仍需要远程 Reranker。

### 缺失的环境变量
${missingVars.map((v) => `- \`${v}\``).join('\n')}

### 配置文件

${context.configCreated ? '已自动创建默认配置文件' : '请编辑配置文件'}：\`${configPath}\`

### 下一步

${actions.join('\n')}
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
