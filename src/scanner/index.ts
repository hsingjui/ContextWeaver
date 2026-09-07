import { getEmbeddingConfig } from '../config.js';
import {
  batchDelete,
  batchUpdateMtime,
  batchUpsert,
  closeDb,
  type FileMeta,
  generateProjectId,
  getAllFileMeta,
  getDependencyEdges,
  getPendingDeletions,
  getStoredIndexFingerprint,
  initDb,
  invalidateIndex,
  setStoredEmbeddingDimensions,
} from '../db/index.js';
import { ensureDependencyGraph } from '../indexer/DependencyIndexer.js';
import { closeIndexer, getIndexer } from '../indexer/index.js';
import { isLocalModelInstalled } from '../models/index.js';
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
  projectId?: string;
  extraExcludePatterns?: string[];
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
  const projectId = options.projectId ?? generateProjectId(rootPath);
  const config = options.vectorIndex === false ? undefined : getEmbeddingConfig();
  if (config?.provider === 'local' && !(await isLocalModelInstalled(config.model))) {
    throw new Error(
      `本地模型 ${config.model} 未安装，请先运行: contextweaver model install ${config.model}`,
    );
  }

  const db = initDb(projectId);
  try {
    const filter = await initFilter(rootPath, options.extraExcludePatterns);
    // 先验证扫描成功，再修改任何索引状态。
    const filePaths = await crawl(rootPath, filter);
    const scannedPaths = new Set(filePaths);
    const indexer = config ? await getIndexer(projectId, config.dimensions) : undefined;
    if (config && indexer) {
      const fingerprint = sha256(
        JSON.stringify({
          embedding:
            config.provider === 'local'
              ? {
                  provider: config.provider,
                  model: config.model,
                  revision: config.revision,
                  dtype: config.dtype,
                  dimensions: config.dimensions,
                  documentInputSpaceVersion: config.documentInputSpaceVersion,
                }
              : {
                  provider: config.provider,
                  model: config.model,
                  baseUrl: config.baseUrl,
                  dimensions: config.dimensions,
                  maxContextTokens: config.maxInputChars,
                  autoSplitLongText: config.autoSplitLongText,
                },
          splitter: SPLITTER_CONFIG,
          maxFileSize: getMaxFileSize(),
          // 修改 grammar、分块或 vectorText 语义时递增。
          indexVersion: 3,
        }),
      );
      if (getStoredIndexFingerprint(db) !== fingerprint) {
        // 配置空间变化时不能混用旧向量；清理成功后才提交新指纹。
        await indexer.clear();
        db.transaction(() => {
          db.exec(
            "DELETE FROM chunks_fts; DELETE FROM symbol_occurrences; DELETE FROM fts_short_tokens WHERE kind = 'chunk'; DELETE FROM fts_short_records WHERE kind = 'chunk'; DELETE FROM fts_short_tokens_meta WHERE kind = 'chunk'",
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
    const dependencyChangedPaths = new Set<string>();
    // 删除 target 前先保留已知 reverse dependents；目标消失后这些 importer 需要重新解析。
    for (const edge of getDependencyEdges(db, deletedPaths, 'reverse')) {
      if (scannedPaths.has(edge.fromPath)) dependencyChangedPaths.add(edge.fromPath);
    }
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
          const needsIndex =
            options.force ||
            (indexer &&
              (known.vectorIndexHash !== known.hash || known.symbolIndexHash !== known.hash));
          batchKnown.set(file, needsIndex ? { ...known, hash: '', mtime: -1 } : known);
        }
      }
      const results = await processFiles(rootPath, batch, batchKnown, (done, total) => {
        const progress = Math.floor(
          ((i + (batch.length * done) / total) / filePaths.length) * 99,
        );
        options.onProgress?.(progress, 100, '正在扫描文件...');
      });
      const toUpsert: FileMeta[] = [];
      const toUpdateMtime: Array<{ path: string; mtime: number; size: number }> = [];
      const skippedPaths: string[] = [];
      for (const result of results) {
        const known = knownFiles.get(result.relPath);
        switch (result.status) {
          case 'added':
          case 'modified':
            if (!known || known.hash !== result.hash) dependencyChangedPaths.add(result.relPath);
            stats[known?.hash === result.hash ? 'unchanged' : result.status]++;
            toUpsert.push({
              path: result.relPath,
              hash: result.hash,
              mtime: result.mtime,
              size: result.size,
              content: result.content,
              language: result.language,
              vectorIndexHash: null,
              symbolIndexHash: null,
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
            if (known) {
              skippedPaths.push(result.relPath);
            }
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
    // Dependency edges are derived from indexed source content. A graph-version marker
    // triggers the one-time upgrade rebuild; otherwise a no-op scan skips the O(repo) pass.
    await ensureDependencyGraph(db, Array.from(dependencyChangedPaths));

    const failed = stats.errors + (stats.vectorIndex?.errors ?? 0);
    options.onProgress?.(100, 100, failed ? '索引完成（部分失败，可重试）' : '索引完成');
    return stats;
  } finally {
    closeDb(db);
    closeIndexer(projectId);
    await closeVectorStore(projectId);
  }
}
