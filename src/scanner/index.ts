import path from 'node:path';
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
 * 进度回调函数类型
 *
 * @param current 当前进度值
 * @param total 总进度值（可选，未知时为 undefined）
 * @param message 人可读的进度消息（可选）
 */
export type ProgressCallback = (current: number, total?: number, message?: string) => void;

/**
 * 扫描选项
 */
export interface ScanOptions {
  /** 强制重新扫描所有文件 */
  force?: boolean;
  /** 是否进行向量索引（默认 true） */
  vectorIndex?: boolean;
  /** 进度回调 */
  onProgress?: ProgressCallback;
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

    // 处理文件（使用全局并发队列，避免批次栅栏导致吞吐下降）
    const results = await processFiles(rootPath, filePaths, knownFiles);

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
      // 需要重新处理这些文件以获取完整的 chunks（unchanged 状态的 chunks 是空的）
      const healingPathSet = new Set(getFilesNeedingVectorIndex(db));
      const healingFilePaths = results
        .filter((r) => r.status === 'unchanged' && healingPathSet.has(r.relPath))
        .map((r) => r.absPath);

      // 仅在确实存在向量层工作时报告进度，避免“无事可做”也显示准备阶段
      const hasVectorWorkCandidates =
        needsVectorIndex.length > 0 || deletedPaths.length > 0 || healingFilePaths.length > 0;
      if (hasVectorWorkCandidates) {
        options.onProgress?.(45, 100, '正在准备向量索引...');
      }

      let healingFiles: ProcessResult[] = [];
      if (healingFilePaths.length > 0) {
        // 重新处理这些文件（传入空的 knownFiles 强制重新读取和分片）
        const processedHealingFiles = await processFiles(rootPath, healingFilePaths, new Map());
        const healingIndexableCount = processedHealingFiles.filter(
          (r) => (r.status === 'added' || r.status === 'modified') && r.chunks.length > 0,
        ).length;
        const healingSkippedCount = processedHealingFiles.filter(
          (r) => (r.status === 'added' || r.status === 'modified') && r.chunks.length === 0,
        ).length;

        if (healingIndexableCount > 0) {
          logger.info({ count: healingIndexableCount }, '自愈：发现需要补索引的文件');
        }
        if (healingSkippedCount > 0) {
          logger.info({ count: healingSkippedCount }, '自愈：文件无可索引 chunk，标记为跳过');
        }

        // 将状态改为 modified 确保 indexer 会处理
        healingFiles = processedHealingFiles
          .filter((r) => r.status === 'added' || r.status === 'modified')
          .map((r) => ({ ...r, status: 'modified' as const }));
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
        // 报告向量更新阶段开始（包含新增/修改/删除/自愈收敛）
        const embeddingFileCount = allToIndex.filter(
          (r) => (r.status === 'added' || r.status === 'modified') && r.chunks.length > 0,
        ).length;
        if (embeddingFileCount > 0) {
          options.onProgress?.(45, 100, `正在生成向量嵌入... (${embeddingFileCount} 个文件)`);
        } else {
          options.onProgress?.(45, 100, '正在同步向量索引状态...');
        }

        // 传递进度回调给 indexer（embedding API 调用是真正的耗时操作）
        const indexStats = await indexer.indexFiles(db, allToIndex, (completed, total) => {
          // 将 embedding 批次进度映射到 45-99 区间（保留 100 给最终完成）
          const progress = 45 + Math.floor((completed / total) * 54);
          options.onProgress?.(progress, 100, `正在生成向量嵌入... (${completed}/${total} 批次)`);
        });
        stats.vectorIndex = {
          indexed: indexStats.indexed,
          deleted: indexStats.deleted,
          errors: indexStats.errors,
        };
      }
    }

    // 报告完成
    options.onProgress?.(100, 100, '索引完成');

    return stats;
  } finally {
    // 确保关闭所有连接
    closeDb(db);
    closeAllIndexers();
    await closeAllVectorStores();
  }
}
