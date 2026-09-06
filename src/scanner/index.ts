import { getEmbeddingConfig } from '../config.js';
import {
  batchDelete,
  batchUpdateMtime,
  batchUpsert,
  closeDb,
  type FileMeta,
  generateProjectId,
  getAllFileMeta,
  getPendingDeletions,
  getStoredIndexFingerprint,
  initDb,
  invalidateIndex,
  setStoredEmbeddingDimensions,
} from '../db/index.js';
import { closeIndexer, getIndexer } from '../indexer/index.js';
import { logger } from '../utils/logger.js';
import { closeVectorStore } from '../vectorStore/index.js';
import { crawl } from './crawler.js';
import { initFilter } from './filter.js';
import { sha256 } from './hash.js';
import { getMaxFileSize, type ProcessResult, processFiles, SPLITTER_CONFIG } from './processor.js';

export interface ScanStats {
  totalFiles: number;
  added: number;
  modified: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  errors: number;
  vectorIndex?: { indexed: number; deleted: number; errors: number };
}

/** total 未知时为 undefined。 */
export type ProgressCallback = (current: number, total?: number, message?: string) => void;

export interface ScanOptions {
  force?: boolean;
  vectorIndex?: boolean;
  onProgress?: ProgressCallback;
}

function deletedResult(relPath: string): ProcessResult {
  return {
    absPath: '',
    relPath,
    hash: '',
    content: null,
    chunks: [],
    language: '',
    mtime: 0,
    size: 0,
    status: 'deleted',
  };
}

/** 有限文件批次完成读取、分块、Embedding 和提交，不积累全仓库 chunks。 */
export async function scan(rootPath: string, options: ScanOptions = {}): Promise<ScanStats> {
  const projectId = generateProjectId(rootPath);
  const db = initDb(projectId);
  try {
    const filter = await initFilter(rootPath);
    // 先验证扫描成功，再修改任何索引状态。
    const filePaths = await crawl(rootPath, filter);
    const scannedPaths = new Set(filePaths);
    const config = options.vectorIndex === false ? undefined : getEmbeddingConfig();
    const indexer = config ? await getIndexer(projectId, config.dimensions) : undefined;
    if (config && indexer) {
      const fingerprint = sha256(
        JSON.stringify({
          model: config.model,
          baseUrl: config.baseUrl,
          dimensions: config.dimensions,
          splitter: SPLITTER_CONFIG,
          maxFileSize: getMaxFileSize(),
          // 修改 grammar、分块或 vectorText 语义时递增。
          indexVersion: 2,
        }),
      );
      if (getStoredIndexFingerprint(db) !== fingerprint) {
        // 配置空间变化时不能混用旧向量；清理成功后才提交新指纹。
        await indexer.clear();
        db.transaction(() => {
          db.exec(
            "DELETE FROM chunks_fts; DELETE FROM fts_short_tokens WHERE kind = 'chunk'; DELETE FROM fts_short_records WHERE kind = 'chunk'; DELETE FROM fts_short_tokens_meta WHERE kind = 'chunk'",
          );
          invalidateIndex(db, fingerprint);
          setStoredEmbeddingDimensions(db, config.dimensions);
        })();
      } else if (options.force) {
        invalidateIndex(db);
      }
    } else if (options.force) {
      invalidateIndex(db);
    }

    const knownFiles = getAllFileMeta(db);
    const deletedPaths = [...knownFiles.keys()].filter((file) => !scannedPaths.has(file));
    // 元数据删除和待清理标记原子提交；无向量模式也不会丢失后续清理任务。
    batchDelete(db, deletedPaths);
    const stats: ScanStats = {
      totalFiles: filePaths.length,
      added: 0,
      modified: 0,
      unchanged: 0,
      deleted: deletedPaths.length,
      skipped: 0,
      errors: 0,
      ...(indexer ? { vectorIndex: { indexed: 0, deleted: 0, errors: 0 } } : {}),
    };
    if (indexer && stats.vectorIndex) {
      const pending = getPendingDeletions(db);
      for (let i = 0; i < pending.length; i += 100) {
        const result = await indexer.indexFiles(db, pending.slice(i, i + 100).map(deletedResult));
        stats.vectorIndex.deleted += result.deleted;
      }
    }

    const batchSize = 100;
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const batch = filePaths.slice(i, i + batchSize);
      const batchKnown = new Map<string, { hash: string; mtime: number; size: number }>();
      for (const file of batch) {
        const known = knownFiles.get(file);
        if (known) {
          const needsIndex = options.force || (indexer && known.vectorIndexHash !== known.hash);
          batchKnown.set(file, needsIndex ? { ...known, hash: '', mtime: -1 } : known);
        }
      }
      const results = await processFiles(rootPath, batch, batchKnown);
      const toUpsert: FileMeta[] = [];
      const toUpdateMtime: Array<{ path: string; mtime: number; size: number }> = [];
      const skippedPaths: string[] = [];
      for (const result of results) {
        const known = knownFiles.get(result.relPath);
        switch (result.status) {
          case 'added':
          case 'modified':
            stats[known?.hash === result.hash ? 'unchanged' : result.status]++;
            toUpsert.push({
              path: result.relPath,
              hash: result.hash,
              mtime: result.mtime,
              size: result.size,
              content: result.content,
              language: result.language,
              vectorIndexHash: null,
            });
            break;
          case 'unchanged':
            stats.unchanged++;
            if (known?.mtime !== result.mtime || known?.size !== result.size) {
              toUpdateMtime.push({ path: result.relPath, mtime: result.mtime, size: result.size });
            }
            break;
          case 'skipped':
            stats.skipped++;
            if (known) skippedPaths.push(result.relPath);
            logger.debug({ path: result.relPath, reason: result.error }, '跳过文件');
            break;
          case 'error':
            stats.errors++;
            logger.error({ path: result.relPath, error: result.error }, '处理文件错误');
            break;
        }
      }
      batchUpsert(db, toUpsert);
      batchUpdateMtime(db, toUpdateMtime);
      batchDelete(db, skippedPaths);
      if (indexer && stats.vectorIndex && (toUpsert.length > 0 || skippedPaths.length > 0)) {
        const toIndex = results.filter(
          (result) => result.status === 'added' || result.status === 'modified',
        );
        const result = await indexer.indexFiles(
          db,
          [...toIndex, ...skippedPaths.map(deletedResult)],
          (done, total) => {
            const progress = Math.floor(
              ((i + (batch.length * done) / total) / filePaths.length) * 99,
            );
            options.onProgress?.(progress, 100, '正在更新索引...');
          },
        );
        stats.vectorIndex.indexed += result.indexed;
        stats.vectorIndex.deleted += result.deleted;
        stats.vectorIndex.errors += result.errors;
      }
      options.onProgress?.(
        Math.floor(((i + batch.length) / filePaths.length) * 99),
        100,
        '正在更新索引...',
      );
      // results 和本批 embeddings 在进入下一批前可回收。
    }
    const failed = stats.errors + (stats.vectorIndex?.errors ?? 0);
    options.onProgress?.(100, 100, failed ? '索引完成（部分失败，可重试）' : '索引完成');
    return stats;
  } finally {
    closeDb(db);
    closeIndexer(projectId);
    await closeVectorStore(projectId);
  }
}
