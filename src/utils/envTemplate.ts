/**
 * .env 配置文件内容生成与解析
 *
 * CLI init 向导与 MCP 端自动补建默认配置共用此模块，保持模板单一来源。
 */

import { DEFAULT_LOCAL_MODEL_ID, type LocalModelId } from '../models/index.js';

export interface EnvRemoteEmbeddingAnswers {
  /** 省略时兼容旧版调用，按 remote 生成。 */
  provider?: 'remote';
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions: string;
}

export interface EnvLocalEmbeddingAnswers {
  provider: 'local';
  model: LocalModelId;
}

export type EnvEmbeddingAnswers = EnvRemoteEmbeddingAnswers | EnvLocalEmbeddingAnswers;

export interface EnvRerankerAnswers {
  baseUrl: string;
  model: string;
  apiKey: string;
  topN: string;
}

export interface EnvAnswers {
  embedding: EnvEmbeddingAnswers;
  /** null = 跳过 Reranker，写入占位值并附注释提醒 */
  reranker?: EnvRerankerAnswers | null;
}

/** 生成 .env 文件内容 */
export function buildEnvContent(answers: EnvAnswers): string {
  const { embedding, reranker } = answers;
  const lines: string[] = ['# ContextWeaver 环境变量配置文件', ''];

  if (embedding.provider === 'local') {
    lines.push(
      '# ===== Embedding 配置（ContextWeaver 内置本地模型）=====',
      'EMBEDDINGS_PROVIDER=local',
      `EMBEDDINGS_MODEL=${embedding.model}`,
      'EMBEDDINGS_MAX_CONCURRENCY=1',
      `# 模型不会由 init 自动下载，请显式运行：contextweaver model install ${embedding.model}`,
      '',
    );
  } else {
    lines.push(
      '# ===== Embedding 配置（远程 OpenAI 兼容 API）=====',
      'EMBEDDINGS_PROVIDER=remote',
      `EMBEDDINGS_API_KEY=${embedding.apiKey}`,
      `EMBEDDINGS_BASE_URL=${embedding.baseUrl}`,
      `EMBEDDINGS_MODEL=${embedding.model}`,
      'EMBEDDINGS_MAX_CONCURRENCY=10',
      `EMBEDDINGS_DIMENSIONS=${embedding.dimensions}`,
      '# 可选：模型上下文窗口（token），用于内部动态推导字符预算（默认 8192）',
      '# EMBEDDINGS_MAX_CONTEXT_TOKENS=8192',
      '# 可选：是否自动预拆分超长文本（默认 true；如需保留原文本语义可设为 false）',
      '# EMBEDDINGS_AUTO_SPLIT_LONG_TEXT=true',
      '',
    );
  }

  if (reranker) {
    lines.push(
      '# ===== Reranker 配置（检索必需）=====',
      `RERANK_API_KEY=${reranker.apiKey}`,
      `RERANK_BASE_URL=${reranker.baseUrl}`,
      `RERANK_MODEL=${reranker.model}`,
      `RERANK_TOP_N=${reranker.topN}`,
      '',
    );
  } else {
    lines.push(
      '# ===== Reranker 配置（检索必需，尚未配置）=====',
      '# 检索需要 Reranker，重新运行 contextweaver init 可补全以下配置',
      'RERANK_API_KEY=your-api-key-here',
      'RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank',
      'RERANK_MODEL=BAAI/bge-reranker-v2-m3',
      'RERANK_TOP_N=20',
      '',
    );
  }

  lines.push(
    '# ===== 索引忽略模式（可选）=====',
    '# 逗号分隔，gitignore 语法，默认已包含常见忽略项；优先级最高，可用 ! 取反默认项',
    '# IGNORE_PATTERNS=.venv,node_modules',
    '',
  );

  return lines.join('\n');
}

/** 默认模板（本地 EmbeddingGemma，供 init 与 MCP 自动补建使用） */
export function buildDefaultEnvContent(): string {
  return buildEnvContent({
    embedding: { provider: 'local', model: DEFAULT_LOCAL_MODEL_ID },
    reranker: {
      apiKey: 'your-api-key-here',
      baseUrl: 'https://api.siliconflow.cn/v1/rerank',
      model: 'BAAI/bge-reranker-v2-m3',
      topN: '20',
    },
  });
}

/** 解析 .env 文本中的 KEY=VALUE（跳过注释与空行，供配置摘要展示用） */
export function parseEnvVars(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}
