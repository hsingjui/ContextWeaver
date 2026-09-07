/**
 * Indexer Service - 向量索引编排层
 *
 * 负责协调 chunking → embedding → 写入 LanceDB 的完整流程
 * 核心特性：
 * - 自愈机制：检测 vector_index_hash != hash 的文件进行补索引
 * - 单调版本更新：先插入新版本再删除旧版本，避免缺失窗口
 * - 批量处理：优化 embedding API 调用
 */

import type Database from 'better-sqlite3';
import { type EmbeddingProvider, getEmbeddingClient } from '../api/embedding.js';
import type { ProcessedChunk } from '../chunking/types.js';
import {
  batchUpdateVectorIndexHash,
  clearVectorIndexHash,
  completeDeletions,
} from '../db/index.js';
import type { ProcessResult } from '../scanner/processor.js';
import {
  batchDeleteFileChunksFts,
  batchUpsertChunkFts,
  isChunksFtsInitialized,
} from '../search/fts.js';
import { logger } from '../utils/logger.js';
import { type ChunkRecord, getVectorStore, type VectorStore } from '../vectorStore/index.js';

// ===========================================
// 类型定义
// ===========================================

/** 索引统计 */
export interface IndexStats {
  indexed: number;
  deleted: number;
  errors: number;
  skipped: number;
}

/** 索引文件信息 */
interface FileToIndex {
  path: string;
  hash: string;
  chunks: ProcessedChunk[];
}

// ===========================================
// Indexer 类
// ===========================================

export class Indexer {
  private projectId: string;
  private vectorStore: VectorStore | null = null;
  private embeddingClient: EmbeddingProvider;
  private vectorDim: number;

  constructor(projectId: string, vectorDim = 1024) {
    this.projectId = projectId;
    this.vectorDim = vectorDim;
    this.embeddingClient = getEmbeddingClient();
  }

  /**
   * 初始化
   */
  async init(): Promise<void> {
    this.vectorStore = await getVectorStore(this.projectId, this.vectorDim);
  }

  /**
   * 处理扫描结果，更新向量索引
   *
   * @param db SQLite 数据库实例
   * @param results 文件处理结果
   * @param onProgress 可选的进度回调 (indexed, total) => void
   */
  async indexFiles(
    db: Database.Database,
    results: ProcessResult[],
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<IndexStats> {
    if (!this.vectorStore) {
      await this.init();
    }

    const stats: IndexStats = {
      indexed: 0,
      deleted: 0,
      errors: 0,
      skipped: 0,
    };

    // 分类处理结果
    const toIndex: FileToIndex[] = [];
    const toDelete: string[] = [];
    const noChunkSettled: Array<{ path: string; hash: string }> = [];

    for (const result of results) {
      switch (result.status) {
        case 'added':
        case 'modified':
          if (result.chunks.length > 0) {
            toIndex.push({
              path: result.relPath,
              hash: result.hash,
              chunks: result.chunks,
            });
          } else {
            // chunks 为空（解析失败或空文件）
            // 仅 modified 文件可能有旧向量记录需要清除，added 文件从未存在过向量记录
            if (result.status === 'modified') {
              toDelete.push(result.relPath);
            }
            noChunkSettled.push({
              path: result.relPath,
              hash: result.hash,
            });
            stats.skipped++;
          }
          break;

        case 'deleted':
          toDelete.push(result.relPath);
          break;

        case 'unchanged':
          stats.skipped++;
          break;

        case 'skipped':
        case 'error':
          stats.skipped++;
          break;
      }
    }

    // 处理删除
    if (toDelete.length > 0) {
      await this.deleteFiles(db, toDelete);
      stats.deleted = toDelete.length;
    }

    // chunks 为空的文件视为已收敛：标记 vector_index_hash=hash
    // 避免这些文件在下一轮被持续判定为“需要自愈”
    if (noChunkSettled.length > 0) {
      batchUpdateVectorIndexHash(db, noChunkSettled);
      logger.debug({ count: noChunkSettled.length }, '无可索引 chunk，标记向量索引状态为已收敛');
    }

    // 批量处理需要索引的文件
    // ponytail: 单文件不拆提交；超大文件的内存上限由 MAX_FILE_SIZE_BYTES 控制，必要时再做文件内暂存。
    const batches: FileToIndex[][] = [];
    let batch: FileToIndex[] = [];
    let chunkCount = 0;
    for (const file of toIndex) {
      if (batch.length > 0 && (batch.length >= 50 || chunkCount + file.chunks.length > 1000)) {
        batches.push(batch);
        batch = [];
        chunkCount = 0;
      }
      batch.push(file);
      chunkCount += file.chunks.length;
    }
    if (batch.length > 0) batches.push(batch);

    const total = batches.reduce(
      (sum, files) =>
        sum + Math.ceil(files.reduce((count, file) => count + file.chunks.length, 0) / 20),
      0,
    );
    let completed = 0;
    for (const files of batches) {
      const result = await this.batchIndex(db, files, (current) =>
        onProgress?.(completed + current, total),
      );
      stats.indexed += result.success;
      stats.errors += result.errors;
      completed += Math.ceil(files.reduce((count, file) => count + file.chunks.length, 0) / 20);
    }

    logger.info(
      {
        indexed: stats.indexed,
        vectorRecordsDeleted: stats.deleted,
        errors: stats.errors,
        skipped: stats.skipped,
      },
      '向量索引完成',
    );

    return stats;
  }

  /**
   * 批量索引文件（性能优化版）
   *
   * 优化策略：
   * 1. Embedding 已批量化（原有）
   * 2. LanceDB 写入批量化：N 次 upsertFile → 1 次 batchUpsertFiles
   * 3. FTS 写入批量化：N 次删除+插入 → 1 次批量删除 + 1 次批量插入
   * 4. 日志汇总化：逐文件日志 → 汇总日志
   */
  private async batchIndex(
    db: Database.Database,
    files: FileToIndex[],
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<{ success: number; errors: number }> {
    if (files.length === 0) {
      return { success: 0, errors: 0 };
    }

    // ===== 阶段 1: 收集所有需要 embedding 的文本 =====
    const allTexts: string[] = [];
    const globalIndexByFileChunk: number[][] = [];

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];
      globalIndexByFileChunk[fileIdx] = [];
      for (let chunkIdx = 0; chunkIdx < file.chunks.length; chunkIdx++) {
        const globalIdx = allTexts.length;
        allTexts.push(file.chunks[chunkIdx].vectorText);
        globalIndexByFileChunk[fileIdx][chunkIdx] = globalIdx;
      }
    }

    if (allTexts.length === 0) {
      return { success: 0, errors: 0 };
    }

    // ===== 阶段 2: 批量获取 embeddings =====
    logger.info({ count: allTexts.length, files: files.length }, '开始批量 Embedding');

    let embeddings: number[][];
    try {
      // 传递进度回调给 embedBatch，让它在每个 API 批次完成时报告进度
      const results = await this.embeddingClient.embedBatch(allTexts, 20, onProgress);
      embeddings = results.map((r) => r.embedding);
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      logger.error({ error: error.message, stack: error.stack }, 'Embedding 失败');
      clearVectorIndexHash(
        db,
        files.map((f) => f.path),
      );
      if (this.embeddingClient.getConfig().provider === 'local') throw err;
      return { success: 0, errors: files.length };
    }

    // ===== 阶段 3: 组装所有 ChunkRecords =====
    const filesToUpsert: Array<{ path: string; hash: string; records: ChunkRecord[] }> = [];
    const allFtsChunks: Array<{
      chunkId: string;
      filePath: string;
      chunkIndex: number;
      breadcrumb: string;
      content: string;
    }> = [];
    const successFiles: Array<{ path: string; hash: string }> = [];
    const errorFiles: string[] = [];

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];

      try {
        const records: ChunkRecord[] = [];

        for (let chunkIdx = 0; chunkIdx < file.chunks.length; chunkIdx++) {
          const chunk = file.chunks[chunkIdx];
          const globalIdx = globalIndexByFileChunk[fileIdx][chunkIdx];

          if (globalIdx === undefined) {
            throw new Error(`找不到 chunk 的 embedding: ${file.path}#${chunkIdx}`);
          }

          const record: ChunkRecord = {
            chunk_id: `${file.path}#${file.hash}#${chunkIdx}`,
            file_path: file.path,
            file_hash: file.hash,
            chunk_index: chunkIdx,
            vector: embeddings[globalIdx],
            display_code: chunk.displayCode,
            vector_text: chunk.vectorText,
            language: chunk.metadata.language,
            breadcrumb: chunk.metadata.contextPath.join(' > '),
            start_index: chunk.metadata.startIndex,
            end_index: chunk.metadata.endIndex,
            raw_start: chunk.metadata.rawSpan.start,
            raw_end: chunk.metadata.rawSpan.end,
            vec_start: chunk.metadata.vectorSpan.start,
            vec_end: chunk.metadata.vectorSpan.end,
          };

          records.push(record);

          // 收集 FTS 数据
          allFtsChunks.push({
            chunkId: record.chunk_id,
            filePath: record.file_path,
            chunkIndex: record.chunk_index,
            breadcrumb: record.breadcrumb,
            content: `${record.breadcrumb}\n${record.display_code}`,
          });
        }

        filesToUpsert.push({ path: file.path, hash: file.hash, records });
        successFiles.push({ path: file.path, hash: file.hash });
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error(
          { path: file.path, error: error.message, stack: error.stack },
          '组装 ChunkRecord 失败',
        );
        errorFiles.push(file.path);
      }
    }

    // ===== 阶段 4: 批量写入 LanceDB =====
    if (filesToUpsert.length > 0) {
      try {
        await this.vectorStore?.batchUpsertFiles(filesToUpsert);
        logger.info(
          { files: filesToUpsert.length, chunks: allFtsChunks.length },
          'LanceDB 批量写入完成',
        );
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error({ error: error.message, stack: error.stack }, 'LanceDB 批量写入失败');
        // 所有文件都失败
        clearVectorIndexHash(
          db,
          files.map((f) => f.path),
        );
        return { success: 0, errors: files.length };
      }
    }

    // FTS 替换和收敛标记同事务提交；失败时保留旧 FTS 并允许下一轮重试。
    try {
      db.transaction(() => {
        batchUpsertChunkFts(
          db,
          allFtsChunks,
          filesToUpsert.map((file) => file.path),
        );
        batchUpdateVectorIndexHash(db, successFiles);
      })();
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'FTS 更新失败，保留待索引状态');
      clearVectorIndexHash(
        db,
        files.map((file) => file.path),
      );
      return { success: 0, errors: files.length };
    }

    // 汇总日志
    logger.info({ success: successFiles.length, errors: errorFiles.length }, '批量索引完成');

    return { success: successFiles.length, errors: errorFiles.length };
  }

  /**
   * 删除文件的向量和 FTS 索引
   */
  private async deleteFiles(db: Database.Database, paths: string[]): Promise<void> {
    if (!this.vectorStore) return;

    // 删除向量索引
    await this.vectorStore.deleteFiles(paths);

    // 清理成功后才移除持久化删除标记。
    db.transaction(() => {
      if (isChunksFtsInitialized(db)) batchDeleteFileChunksFts(db, paths);
      completeDeletions(db, paths);
    })();

    logger.debug({ count: paths.length }, '删除文件索引');
  }

  /**
   * 向量搜索
   */
  async search(queryVector: number[], limit = 10, filter?: string) {
    if (!this.vectorStore) {
      await this.init();
    }
    return this.vectorStore?.search(queryVector, limit, filter);
  }

  /**
   * 文本搜索（先 embedding 再向量搜索）
   */
  async textSearch(query: string, limit = 10, filter?: string) {
    const queryVector = await this.embeddingClient.embed(query);
    return this.search(queryVector, limit, filter);
  }

  /**
   * 清空索引
   */
  async clear(): Promise<void> {
    if (!this.vectorStore) {
      await this.init();
    }
    await this.vectorStore?.clear();
  }

  /**
   * 获取索引统计
   */
  async getStats(): Promise<{ totalChunks: number }> {
    if (!this.vectorStore) {
      await this.init();
    }
    const count = (await this.vectorStore?.count()) ?? 0;
    return { totalChunks: count };
  }
}

// ===========================================
// 工厂函数
// ===========================================

const indexers = new Map<string, Indexer>();

/**
 * 获取或创建 Indexer 实例
 */
export async function getIndexer(projectId: string, vectorDim = 1024): Promise<Indexer> {
  let indexer = indexers.get(projectId);
  if (!indexer) {
    indexer = new Indexer(projectId, vectorDim);
    await indexer.init();
    indexers.set(projectId, indexer);
  }
  return indexer;
}

/**
 * 关闭所有 Indexer
 */
export function closeAllIndexers(): void {
  indexers.clear();
}

export function closeIndexer(projectId: string): void {
  indexers.delete(projectId);
}
