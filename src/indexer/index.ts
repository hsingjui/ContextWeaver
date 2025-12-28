/**
 * Indexer Service - 向量索引编排层
 * 
 * 负责协调 chunking → embedding → 写入 LanceDB 的完整流程
 * 核心特性：
 * - 自愈机制：检测 vector_index_hash != hash 的文件进行补索引
 * - 单调版本更新：先插入新版本再删除旧版本，避免缺失窗口
 * - 批量处理：优化 embedding API 调用
 */

import Database from "better-sqlite3";
import { VectorStore, getVectorStore, type ChunkRecord } from "../vectorStore/index.js";
import { EmbeddingClient, getEmbeddingClient } from "../api/embedding.js";
import { batchUpdateVectorIndexHash, clearVectorIndexHash } from "../db/index.js";
import { batchUpsertChunkFts, batchDeleteFileChunksFts, isChunksFtsInitialized } from "../search/fts.js";
import type { ProcessedChunk } from "../chunking/types.js";
import type { ProcessResult } from "../scanner/processor.js";
import { logger } from "../utils/logger.js";

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
    private embeddingClient: EmbeddingClient;
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
     */
    async indexFiles(db: Database.Database, results: ProcessResult[]): Promise<IndexStats> {
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

        for (const result of results) {
            switch (result.status) {
                case "added":
                case "modified":
                    if (result.chunks.length > 0) {
                        toIndex.push({
                            path: result.relPath,
                            hash: result.hash,
                            chunks: result.chunks,
                        });
                    } else {
                        // chunks 为空（解析失败或空文件），清除向量但不标记为错误
                        toDelete.push(result.relPath);
                        stats.skipped++;
                    }
                    break;

                case "deleted":
                    toDelete.push(result.relPath);
                    break;

                case "unchanged":
                    stats.skipped++;
                    break;

                case "skipped":
                case "error":
                    stats.skipped++;
                    break;
            }
        }

        // 处理删除
        if (toDelete.length > 0) {
            await this.deleteFiles(db, toDelete);
            stats.deleted = toDelete.length;
        }

        // 批量处理需要索引的文件
        if (toIndex.length > 0) {
            const indexResult = await this.batchIndex(db, toIndex);
            stats.indexed = indexResult.success;
            stats.errors = indexResult.errors;
        }

        logger.info(
            { indexed: stats.indexed, deleted: stats.deleted, errors: stats.errors, skipped: stats.skipped },
            "向量索引完成"
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
        files: FileToIndex[]
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
        logger.info({ count: allTexts.length, files: files.length }, "开始批量 Embedding");
        let embeddings: number[][];
        try {
            const results = await this.embeddingClient.embedBatch(allTexts);
            embeddings = results.map(r => r.embedding);
        } catch (err: any) {
            logger.error({ error: err.message, stack: err.stack }, "Embedding 失败");
            clearVectorIndexHash(db, files.map(f => f.path));
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
                        breadcrumb: chunk.metadata.contextPath.join(" > "),
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
                        content: record.breadcrumb + '\n' + record.display_code,
                    });
                }

                filesToUpsert.push({ path: file.path, hash: file.hash, records });
                successFiles.push({ path: file.path, hash: file.hash });
            } catch (err: any) {
                logger.error({ path: file.path, error: err.message, stack: err.stack }, "组装 ChunkRecord 失败");
                errorFiles.push(file.path);
            }
        }

        // ===== 阶段 4: 批量写入 LanceDB =====
        if (filesToUpsert.length > 0) {
            try {
                await this.vectorStore!.batchUpsertFiles(filesToUpsert);
                logger.info({ files: filesToUpsert.length, chunks: allFtsChunks.length }, "LanceDB 批量写入完成");
            } catch (err: any) {
                logger.error({ error: err.message, stack: err.stack }, "LanceDB 批量写入失败");
                // 所有文件都失败
                clearVectorIndexHash(db, files.map(f => f.path));
                return { success: 0, errors: files.length };
            }
        }

        // ===== 阶段 5: 批量更新 FTS 索引 =====
        if (isChunksFtsInitialized(db) && allFtsChunks.length > 0) {
            try {
                // 批量删除旧 FTS 记录
                const pathsToDelete = filesToUpsert.map(f => f.path);
                batchDeleteFileChunksFts(db, pathsToDelete);
                // 批量插入新 FTS 记录
                batchUpsertChunkFts(db, allFtsChunks);
                logger.info({ files: pathsToDelete.length, chunks: allFtsChunks.length }, "FTS 批量更新完成");
            } catch (err: any) {
                logger.warn({ error: err.message }, "FTS 批量更新失败（向量索引已成功）");
            }
        }

        // ===== 阶段 6: 更新 SQLite 元数据 =====
        if (successFiles.length > 0) {
            batchUpdateVectorIndexHash(db, successFiles);
        }

        // 汇总日志
        logger.info(
            { success: successFiles.length, errors: errorFiles.length },
            "批量索引完成"
        );

        return { success: successFiles.length, errors: errorFiles.length };
    }

    /**
     * 删除文件的向量和 FTS 索引
     */
    private async deleteFiles(db: Database.Database, paths: string[]): Promise<void> {
        if (!this.vectorStore) return;

        // 删除向量索引
        await this.vectorStore.deleteFiles(paths);

        // 删除 chunk FTS 索引
        if (isChunksFtsInitialized(db)) {
            batchDeleteFileChunksFts(db, paths);
        }

        logger.debug({ count: paths.length }, "删除文件索引");
    }

    /**
     * 向量搜索
     */
    async search(queryVector: number[], limit = 10, filter?: string) {
        if (!this.vectorStore) {
            await this.init();
        }
        return this.vectorStore!.search(queryVector, limit, filter);
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
        await this.vectorStore!.clear();
    }

    /**
     * 获取索引统计
     */
    async getStats(): Promise<{ totalChunks: number }> {
        if (!this.vectorStore) {
            await this.init();
        }
        const count = await this.vectorStore!.count();
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
