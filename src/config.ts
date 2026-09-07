/**
 * 统一配置模块
 *
 * 整合环境变量加载、API 配置、排除模式等所有配置项
 *
 * 加载策略：
 * - 开发环境 (NODE_ENV !== "production"): 加载项目根目录的 .env 文件
 * - 生产环境 (NODE_ENV === "production"): 加载 ~/.contextweaver/.env 文件
 *
 * 此模块必须在应用启动时最先导入，以确保环境变量在其他模块加载前可用。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

// 环境变量加载

const isDev = process.env.NODE_ENV === 'dev';

// MCP 模式检测：通过命令行参数判断（contextweaver mcp）
export const isMcpMode = process.argv.includes('mcp');

function loadEnv(): void {
  // 可能的 .env 文件路径（按优先级排序）
  const candidates = isDev
    ? [
        path.join(process.cwd(), '.env'), // 1. 当前目录（开发用）
        path.join(os.homedir(), '.contextweaver', '.env'), // 2. 用户配置目录（回退）
      ]
    : [
        path.join(os.homedir(), '.contextweaver', '.env'), // 生产环境只用用户配置
      ];

  // 找到第一个存在的文件
  const envPath = candidates.find((p) => fs.existsSync(p));

  if (envPath) {
    const result = dotenv.config({ path: envPath, quiet: true });
    if (result.error) {
      // 环境变量加载失败是致命错误，此时 logger 尚未初始化，只能用 console
      console.error(`[config] 加载环境变量失败: ${result.error.message}`);
      process.exit(1);
    }
  }
  // 所有路径都不存在时静默跳过，允许无 .env 文件运行
}

// 立即执行加载
loadEnv();

// API 配置类型定义

export interface EmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxConcurrency: number;
  /** 向量维度 */
  dimensions: number;
  /** 单条文本最大字符数（超出会拆分） */
  maxInputChars: number;
  /** 单次请求最大字符预算（用于动态分批） */
  maxBatchChars: number;
  /** 是否自动预拆分超长文本 */
  autoSplitLongText: boolean;
}

export interface RerankerConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  topN: number;
}

// API 配置获取

/**
 * 环境变量检查结果
 */
export interface EnvCheckResult {
  isValid: boolean;
  missingVars: string[];
}

/**
 * 默认的 API Key 占位符（未修改则视为未配置）
 */
const DEFAULT_API_KEY_PLACEHOLDER = 'your-api-key-here';

/**
 * Embedding 模型上下文窗口默认值（tokens）
 */
const DEFAULT_EMBEDDING_CONTEXT_TOKENS = 8192;

/**
 * token -> char 的保守换算比例
 * 目标：在未知 tokenizer 的情况下优先保证不超限
 */
const EMBEDDING_INPUT_CHAR_RATIO = 0.98;

/**
 * 单次请求字符预算默认倍数（相对单条输入）
 */
const EMBEDDING_BATCH_CHAR_MULTIPLIER = 3;

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) return null;
  return value;
}

function parseBoolean(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

/**
 * 检查 Embedding 相关环境变量是否已配置（不抛出错误）
 * @returns 检查结果，包含是否有效和缺失的变量列表
 */
export function checkEmbeddingEnv(): EnvCheckResult {
  const missingVars: string[] = [];

  const apiKey = process.env.EMBEDDINGS_API_KEY;
  if (!apiKey || apiKey === DEFAULT_API_KEY_PLACEHOLDER) {
    missingVars.push('EMBEDDINGS_API_KEY');
  }
  if (!process.env.EMBEDDINGS_BASE_URL) {
    missingVars.push('EMBEDDINGS_BASE_URL');
  }
  if (!process.env.EMBEDDINGS_MODEL) {
    missingVars.push('EMBEDDINGS_MODEL');
  }

  return {
    isValid: missingVars.length === 0,
    missingVars,
  };
}

/**
 * 检查 Reranker 相关环境变量是否已配置（不抛出错误）
 * @returns 检查结果，包含是否有效和缺失的变量列表
 */
export function checkRerankerEnv(): EnvCheckResult {
  const missingVars: string[] = [];

  const apiKey = process.env.RERANK_API_KEY;
  if (!apiKey || apiKey === DEFAULT_API_KEY_PLACEHOLDER) {
    missingVars.push('RERANK_API_KEY');
  }
  if (!process.env.RERANK_BASE_URL) {
    missingVars.push('RERANK_BASE_URL');
  }
  if (!process.env.RERANK_MODEL) {
    missingVars.push('RERANK_MODEL');
  }

  return {
    isValid: missingVars.length === 0,
    missingVars,
  };
}

/**
 * 获取 Embedding 配置
 * @throws 如果必需的配置项缺失
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  const apiKey = process.env.EMBEDDINGS_API_KEY;
  const baseUrl = process.env.EMBEDDINGS_BASE_URL;
  const model = process.env.EMBEDDINGS_MODEL;
  const maxConcurrency = parseInt(process.env.EMBEDDINGS_MAX_CONCURRENCY || '10', 10);
  const maxContextTokens = parsePositiveInt(process.env.EMBEDDINGS_MAX_CONTEXT_TOKENS);
  const autoSplitLongText = parseBoolean(process.env.EMBEDDINGS_AUTO_SPLIT_LONG_TEXT);

  if (!apiKey) {
    throw new Error('EMBEDDINGS_API_KEY 环境变量未设置');
  }
  if (!baseUrl) {
    throw new Error('EMBEDDINGS_BASE_URL 环境变量未设置');
  }
  if (!model) {
    throw new Error('EMBEDDINGS_MODEL 环境变量未设置');
  }

  const dimensions = parseInt(process.env.EMBEDDINGS_DIMENSIONS || '1024', 10);
  const contextTokens = maxContextTokens ?? DEFAULT_EMBEDDING_CONTEXT_TOKENS;
  const maxInputChars = Math.max(500, Math.floor(contextTokens * EMBEDDING_INPUT_CHAR_RATIO));
  const maxBatchChars = Math.max(maxInputChars, maxInputChars * EMBEDDING_BATCH_CHAR_MULTIPLIER);

  return {
    apiKey,
    baseUrl,
    model,
    maxConcurrency: Number.isNaN(maxConcurrency) ? 4 : maxConcurrency,
    dimensions: Number.isNaN(dimensions) ? 1024 : dimensions,
    maxInputChars,
    maxBatchChars,
    autoSplitLongText: autoSplitLongText ?? true,
  };
}

/**
 * 获取 Reranker 配置
 * @throws 如果必需的配置项缺失
 */
export function getRerankerConfig(): RerankerConfig {
  const apiKey = process.env.RERANK_API_KEY;
  const baseUrl = process.env.RERANK_BASE_URL;
  const model = process.env.RERANK_MODEL;
  const topN = parseInt(process.env.RERANK_TOP_N || '10', 10);

  if (!apiKey) {
    throw new Error('RERANK_API_KEY 环境变量未设置');
  }
  if (!baseUrl) {
    throw new Error('RERANK_BASE_URL 环境变量未设置');
  }
  if (!model) {
    throw new Error('RERANK_MODEL 环境变量未设置');
  }

  return {
    apiKey,
    baseUrl,
    model,
    topN: Number.isNaN(topN) ? 10 : topN,
  };
}

// 排除模式配置

/**
 * 默认排除列表：目录模式（剪枝遍历）+ 会命中扩展名白名单的文件模式，
 * 其余噪音由 isAllowedExtension 白名单拦截。
 */
const DEFAULT_EXCLUDE_PATTERNS = [
  // --- 1. 依赖与环境 ---
  'node_modules',
  'bower_components',
  'venv',
  '.env.*', // 保险：防密泄露，白名单变动时兑底

  // --- 2. 点开头目录一律剪枝（缓存/工具/构建产物），含源码的例外保留 ---
  '.*/',
  '!.github/',
  '!.storybook/',
  '!.circleci/',
  '!.devcontainer/',

  // --- 3. 锁文件 (Token 杀手) ---
  'package-lock.json',
  'pnpm-lock.yaml',

  // --- 4. 构建产物与缓存 (非点开头) ---
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  '*.egg-info',

  // --- 5. 白名单内的文件模式 ---
  '*.min.js',
  '*.min.css',
  '*.generated.ts',
  '*.generated.js',
  '*.pb.go',
  '*.pb.ts',

  // --- 6. 测试/评测噪音 (保留 *.test.ts，但剔除这些) ---
  'benchmarks',
  '__snapshots__',
  'test/fixtures',
  'tests/fixtures',
  '__fixtures__',
  'test/data',
  'tests/data',
  'testdata',
  'test-data',
  'testutils',
  'mock',
  'mocks',
  '__mocks__',
  'stub',
  'stubs',

  // --- 7. 第三方与生成文件 ---
  'vendor',
  'vendors',
  'third_party',
  'thirdparty',
  '3rdparty',
  'external',
  'externals',
  'generated',
  'gen',
  'auto-generated',

  // --- 8. 临时目录 ---
  'tmp',
];

/**
 * 获取默认排除模式列表
 *
 * IGNORE_PATTERNS 环境变量由 filter.ts 在最后加载（优先级最高，可覆盖默认模式和项目忽略文件）
 * @returns 排除模式数组
 */
export function getExcludePatterns(): string[] {
  return [...DEFAULT_EXCLUDE_PATTERNS];
}

export { isDev };
