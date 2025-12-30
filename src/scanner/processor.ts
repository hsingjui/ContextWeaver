import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  getParser,
  isLanguageSupported,
  type ProcessedChunk,
  SemanticSplitter,
} from '../chunking/index.js';
import { readFileWithEncoding } from '../utils/encoding.js';
import { sha256 } from './hash.js';
import { getLanguage } from './language.js';

/**
 * 大文件阈值（字节）
 */
const MAX_FILE_SIZE = 100 * 1024; // 500KB

/**
 * 需要兜底分片支持的目标语言集合
 * 这些语言的文件即使 AST 解析失败也会使用行分片保证可检索
 */
const FALLBACK_LANGS = new Set(['python', 'go', 'rust', 'java', 'markdown', 'json']);

/**
 * 检查 JSON 文件是否应该跳过索引
 *
 * 跳过条件：
 * 1. lock 文件（*-lock.json, package-lock.json）
 * 2. node_modules 目录下的文件
 *
 * @param relPath 相对路径
 * @returns 是否应该跳过
 */
function shouldSkipJson(relPath: string): boolean {
  // Skip lock files
  if (relPath.endsWith('-lock.json') || relPath.endsWith('package-lock.json')) {
    return true;
  }
  // Skip node_modules (handle both Unix and Windows path separators)
  if (relPath.includes('node_modules/') || relPath.includes('node_modules\\')) {
    return true;
  }
  return false;
}

/**
 * 自适应并发度
 *
 * 基于 CPU 核心数动态调整并发度：
 * - 保留 1 个核心给系统和其他进程
 * - 最小并发度为 4（保证 I/O 密集型任务效率）
 * - 最大并发度为 32（避免过多上下文切换开销）
 */
function getAdaptiveConcurrency(): number {
  const cpuCount = os.cpus().length;
  const concurrency = Math.max(4, Math.min(cpuCount - 1, 32));
  return concurrency;
}

/**
 * 分片器单例
 */
const splitter = new SemanticSplitter({
  maxChunkSize: 500,
  minChunkSize: 50,
  chunkOverlap: 40, // 混合检索(BM25+向量+rerank)下的保守 overlap
});

/**
 * 文件处理结果
 */
export interface ProcessResult {
  absPath: string;
  relPath: string;
  hash: string;
  content: string | null;
  chunks: ProcessedChunk[];
  language: string;
  mtime: number;
  size: number;
  status: 'added' | 'modified' | 'unchanged' | 'deleted' | 'skipped' | 'error';
  error?: string;
}

/**
 * 已知文件元数据
 */
export interface KnownFileMeta {
  mtime: number;
  hash: string;
  size: number;
}

/**
 * 处理单个文件
 */
async function processFile(
  absPath: string,
  relPath: string,
  known?: KnownFileMeta,
): Promise<ProcessResult> {
  const language = getLanguage(relPath);

  try {
    const stat = await fs.stat(absPath);
    const mtime = stat.mtimeMs;
    const size = stat.size;

    // 检查大文件
    if (size > MAX_FILE_SIZE) {
      return {
        absPath,
        relPath,
        hash: '',
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'skipped',
        error: `File too large (${size} bytes > ${MAX_FILE_SIZE} bytes)`,
      };
    }

    // 快速跳过：如果 mtime 和 size 都没变，则认为文件未修改
    if (known && known.mtime === mtime && known.size === size) {
      return {
        absPath,
        relPath,
        hash: known.hash,
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'unchanged',
      };
    }

    // 读取文件内容（自动检测编码并转换为 UTF-8）
    const { content, originalEncoding } = await readFileWithEncoding(absPath);

    // 二进制检测：检查 NULL 字节
    if (content.includes('\0')) {
      return {
        absPath,
        relPath,
        hash: '',
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'skipped',
        error: `Binary file detected (original encoding: ${originalEncoding})`,
      };
    }

    // 计算哈希
    const hash = sha256(content);

    // 如果已知 hash 且相同，则认为未修改（mtime 可能由于某些原因变了）
    if (known && known.hash === hash) {
      return {
        absPath,
        relPath,
        hash,
        content,
        chunks: [],
        language,
        mtime,
        size,
        status: 'unchanged',
      };
    }

    // ===== JSON 文件特殊处理 =====
    if (language === 'json' && shouldSkipJson(relPath)) {
      return {
        absPath,
        relPath,
        hash,
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'skipped',
        error: 'Lock file or node_modules JSON',
      };
    }

    // 语义分片
    let chunks: ProcessedChunk[] = [];

    // 1. 尝试 AST 分片（如果语言支持）
    if (isLanguageSupported(language)) {
      try {
        const parser = await getParser(language);
        if (parser) {
          const tree = parser.parse(content);
          chunks = splitter.split(tree, content, relPath, language);
        }
      } catch (err) {
        const error = err as { message?: string };
        // AST 分片失败，记录警告
        console.warn(`[Chunking] AST failed for ${relPath}: ${error.message}`);
      }
    }

    // 兜底分片：对 FALLBACK_LANGS 语言，如果 AST 分片失败或返回空，使用行分片
    if (chunks.length === 0 && FALLBACK_LANGS.has(language)) {
      chunks = splitter.splitPlainText(content, relPath, language);
    }

    return {
      absPath,
      relPath,
      hash,
      content,
      chunks,
      language,
      mtime,
      size,
      status: known ? 'modified' : 'added',
    };
  } catch (err) {
    const error = err as { message?: string };
    return {
      absPath,
      relPath,
      hash: '',
      content: null,
      chunks: [],
      language,
      mtime: 0,
      size: 0,
      status: 'error',
      error: error.message,
    };
  }
}

/**
 * 批量处理文件
 */
export async function processFiles(
  rootPath: string,
  filePaths: string[],
  knownFiles: Map<string, KnownFileMeta>,
): Promise<ProcessResult[]> {
  const concurrency = getAdaptiveConcurrency();
  const limit = pLimit(concurrency);

  const tasks = filePaths.map((filePath) => {
    // 标准化路径分隔符为 /，确保跨平台一致性
    const relPath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const known = knownFiles.get(relPath);
    return limit(() => processFile(filePath, relPath, known));
  });

  return Promise.all(tasks);
}
