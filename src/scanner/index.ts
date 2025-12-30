import path from 'path';
import { getEmbeddingConfig } from '../config.js';
import {
  batchDelete,
  batchUpdateMtime,
  batchUpsert,
  clear,
  closeDb,
  type FileMeta,
  generateProjectId,
  getAllFileMeta,
  getAllPaths,
  getFilesNeedingVectorIndex,
  getStoredEmbeddingDimensions,
  initDb,
  setStoredEmbeddingDimensions,
} from '../db/index.js';
import { closeAllIndexers, getIndexer } from '../indexer/index.js';
import { logger } from '../utils/logger.js';
import { closeAllVectorStores } from '../vectorStore/index.js';
import { crawl } from './crawler.js';
import { initFilter } from './filter.js';
import { type ProcessResult, processFiles } from './processor.js';

/**
 * 扫描结果统计
 */
export interface ScanStats {
  totalFiles: number;
  added: number;
  modified: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  errors: number;
  /** 向量索引统计 */
  vectorIndex?: {
    indexed: number;
    deleted: number;
    errors: number;
  };
}

/**
 * 扫描选项
 */
export interface ScanOptions {
  /** 强制重新扫描所有文件 */
  force?: boolean;
  /** 是否进行向量索引（默认 true） */
  vectorIndex?: boolean;
  /** 进度回调 */
  onProgress?: (current: number, total: number) => void;
}

/**
 * 执行代码库扫描
 */
export async function scan(rootPath: string, options: ScanOptions = {}): Promise<ScanStats> {
  // 生成项目 ID
  const projectId = generateProjectId(rootPath);

  // 初始化数据库连接
  const db = initDb(projectId);

  try {
    // 初始化过滤器
    await initFilter(rootPath);

    // 检查 embedding dimensions 是否变化
    let forceReindex = options.force ?? false;
    if (options.vectorIndex !== false) {
      const currentDimensions = getEmbeddingConfig().dimensions;
      const storedDimensions = getStoredEmbeddingDimensions(db);

      if (storedDimensions !== null && storedDimensions !== currentDimensions) {
        logger.warn(
          { stored: storedDimensions, current: currentDimensions },
          'Embedding 维度变化，强制重新索引',
        );
        forceReindex = true;
      }

      // 更新存储的维度值
      setStoredEmbeddingDimensions(db, currentDimensions);
    }

    // 如果强制重新索引，清空数据库和向量索引
    if (forceReindex) {
      logger.info('强制重新索引...');
      clear(db);

      // 清空向量索引
      if (options.vectorIndex !== false) {
        const embeddingConfig = getEmbeddingConfig();
        const indexer = await getIndexer(projectId, embeddingConfig.dimensions);
        await indexer.clear();
      }
    }

    // 获取已知的文件元数据
    const knownFiles = getAllFileMeta(db);

    // 扫描文件系统
    const filePaths = await crawl(rootPath);
    // 使用 path.relative 确保跨平台兼容，并标准化为 / 分隔符
    const scannedPaths = new Set(
      filePaths.map((p) => path.relative(rootPath, p).replace(/\\/g, '/')),
    );

    // 处理文件
    let processedCount = 0;
    const results: ProcessResult[] = [];

    // 分批处理以支持进度回调
    const batchSize = 100;
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const batch = filePaths.slice(i, i + batchSize);
      const batchResults = await processFiles(rootPath, batch, knownFiles);
      results.push(...batchResults);

      processedCount += batch.length;
      options.onProgress?.(processedCount, filePaths.length);
    }

    // 准备数据库操作
    const toAdd: FileMeta[] = [];
    const toUpdateMtime: Array<{ path: string; mtime: number }> = [];
    const deletedPaths: string[] = [];

    for (const result of results) {
      switch (result.status) {
        case 'added':
        case 'modified':
          toAdd.push({
            path: result.relPath,
            hash: result.hash,
            mtime: result.mtime,
            size: result.size,
            content: result.content,
            language: result.language,
            vectorIndexHash: null, // 新文件/修改的文件需要重新索引
          });
          break;

        case 'unchanged':
          toUpdateMtime.push({ path: result.relPath, mtime: result.mtime });
          break;

        case 'skipped':
          logger.debug({ path: result.relPath, reason: result.error }, '跳过文件');
          break;

        case 'error':
          logger.error({ path: result.relPath, error: result.error }, '处理文件错误');
          break;
      }
    }

    // 处理已删除的文件
    const allIndexedPaths = getAllPaths(db);
    for (const indexedPath of allIndexedPaths) {
      // 标准化路径分隔符进行比较
      const normalizedIndexedPath = indexedPath.replace(/\\/g, '/');
      if (!scannedPaths.has(normalizedIndexedPath)) {
        deletedPaths.push(indexedPath);
      }
    }

    // 增量更新
    batchUpsert(db, toAdd);
    batchUpdateMtime(db, toUpdateMtime);
    batchDelete(db, deletedPaths);

    // 统计结果
    const stats: ScanStats = {
      totalFiles: filePaths.length,
      added: results.filter((r) => r.status === 'added').length,
      modified: results.filter((r) => r.status === 'modified').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
      deleted: deletedPaths.length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errors: results.filter((r) => r.status === 'error').length,
    };

    // ===== 向量索引 =====
    if (options.vectorIndex !== false) {
      const embeddingConfig = getEmbeddingConfig();
      const indexer = await getIndexer(projectId, embeddingConfig.dimensions);

      // 收集需要向量索引的文件：
      // 1. 新增/修改的文件
      // 2. 自愈机制：vector_index_hash != hash 的文件
      const needsVectorIndex = results.filter(
        (r) => r.status === 'added' || r.status === 'modified',
      );

      // 自愈：检查 unchanged 文件是否需要补索引
      const healingPathSet = new Set(getFilesNeedingVectorIndex(db));
      const healingFiles = results.filter(
        (r) => r.status === 'unchanged' && healingPathSet.has(r.relPath),
      );

      if (healingFiles.length > 0) {
        logger.info({ count: healingFiles.length }, '自愈：发现需要补索引的文件');
      }

      // 为 deleted 文件创建占位 ProcessResult
      const deletedResults: ProcessResult[] = deletedPaths.map((path) => ({
        absPath: '',
        relPath: path,
        hash: '',
        content: null,
        chunks: [],
        language: '',
        mtime: 0,
        size: 0,
        status: 'deleted' as const,
      }));

      const allToIndex = [...needsVectorIndex, ...healingFiles, ...deletedResults];

      if (allToIndex.length > 0) {
        const indexStats = await indexer.indexFiles(db, allToIndex);
        stats.vectorIndex = {
          indexed: indexStats.indexed,
          deleted: indexStats.deleted,
          errors: indexStats.errors,
        };
      }
    }

    return stats;
  } finally {
    // 确保关闭所有连接
    closeDb(db);
    closeAllIndexers();
    await closeAllVectorStores();
  }
}
