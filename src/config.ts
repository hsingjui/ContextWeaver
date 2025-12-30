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

  return {
    apiKey,
    baseUrl,
    model,
    maxConcurrency: Number.isNaN(maxConcurrency) ? 4 : maxConcurrency,
    dimensions: Number.isNaN(dimensions) ? 1024 : dimensions,
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
 * 默认排除列表
 *
 * 策略：
 * 1. 绝对屏蔽高 Token 消耗且低语义价值的文件 (Lock files, Maps, Assets)
 * 2. 绝对屏蔽构建产物和依赖 (Dist, node_modules)
 * 3. 智能保留测试逻辑，但剔除测试数据
 */
const DEFAULT_EXCLUDE_PATTERNS = [
  // --- 1. 依赖与环境 (绝对黑名单) ---
  'node_modules',
  'bower_components',
  '.venv',
  'venv', // Python 虚拟环境
  '.env.*', // 环境变量文件 (.env.local, .env.production 等)

  // --- 2. 锁文件 (Token 杀手，且语义密度极低) ---
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'Cargo.lock',

  // --- 3. 版本控制与 IDE ---
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '.vs',

  // --- 4. 构建产物与缓存 ---
  // 通用构建输出
  'dist',
  'build',
  'out',
  'target',
  // 编译产物
  '*.pyc',
  '*.pyo',
  '*.pyd',
  '*.so',
  '*.dll',
  '*.exe',
  '*.bin',
  '*.wasm',
  // 现代前端框架产物
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  // Bundler 缓存
  '.turbo',
  '.parcel-cache',
  '.webpack',
  '.esbuild',
  '.rollup.cache',
  // 测试覆盖率
  'coverage',
  '.nyc_output',
  // Python 缓存
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.eggs',
  '*.egg-info',

  // --- 5. 纯噪音文件 (无文本语义) ---
  // 压缩文件与 SourceMap
  '*.min.js',
  '*.min.css',
  '*.map',
  // 图片与多媒体
  '*.svg',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.ico',
  '*.webp',
  '*.bmp',
  '*.pdf',
  '*.mp3',
  '*.mp4',
  '*.wav',
  '*.webm',
  '*.ogg',
  '*.flac',
  // 字体文件
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.otf',
  // 压缩包
  '*.zip',
  '*.tar',
  '*.gz',
  '*.rar',
  '*.7z',
  // 系统垃圾
  '.DS_Store',
  'Thumbs.db',

  // --- 6. 测试噪音 (保留 *.test.ts，但剔除这些) ---
  // Jest 快照
  '__snapshots__',
  '*.snap',
  // 测试夹具与数据
  'test/fixtures',
  'tests/fixtures',
  '__fixtures__',
  'test/data',
  'tests/data',
  'testdata',
  'test-data',
  'testutils',
  // Mock 数据
  'mock',
  'mocks',
  '__mocks__',
  'stub',
  'stubs',

  // --- 7. 第三方与生成文件 ---
  // 第三方依赖目录
  'vendor',
  'vendors',
  'third_party',
  'thirdparty',
  '3rdparty',
  'external',
  'externals',
  // 生成文件
  'generated',
  'gen',
  'auto-generated',
  '*.generated.ts',
  '*.generated.js',
  '*.pb.go',
  '*.pb.ts', // protobuf 生成

  // --- 8. 日志与临时文件 ---
  '*.log',
  '.cache',
  '.tmp',
  'tmp',
];

/**
 * 获取合并后的排除模式列表
 * @returns 排除模式数组
 */
export function getExcludePatterns(): string[] {
  const envPatterns = process.env.IGNORE_PATTERNS;
  const patterns = [...DEFAULT_EXCLUDE_PATTERNS];

  if (envPatterns) {
    // 解析逗号分隔的环境变量
    const additional = envPatterns
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    patterns.push(...additional);
  }

  return patterns;
}

export { isDev };
