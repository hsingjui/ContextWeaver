/**
 * VectorStore - LanceDB 适配层
 * 
 * 负责 chunks 表的管理，支持：
 * - 单调版本更新（先插后删）避免缺失窗口
 * - 批量插入和查询
 * - 文件级删除
 */

import * as lancedb from "@lancedb/lancedb";
import path from "path";
import os from "os";
import fs from "fs";

const BASE_DIR = path.join(os.homedir(), ".contextweaver");

// ===========================================
// 类型定义
// ===========================================

/** Chunk 记录（存储在 LanceDB 中） */
export interface ChunkRecord {
    /** 主键: file_path#file_hash#chunk_index */
    chunk_id: string;
    /** 相对路径 */
    file_path: string;
    /** 文件内容 hash */
    file_hash: string;
    /** 文件内序号 */
    chunk_index: number;
    /** embedding 向量 */
    vector: number[];
    /** 展示用代码 */
    display_code: string;
    /** 向量化文本（用于生成 embedding） */
    vector_text: string;
    /** 语言 */
    language: string;
    /** 面包屑路径 */
    breadcrumb: string;
    /** 语义起始偏移量 */
    start_index: number;
    /** 语义结束偏移量 */
    end_index: number;
    /** rawSpan.start */
    raw_start: number;
    /** rawSpan.end */
    raw_end: number;
    /** vectorSpan.start */
    vec_start: number;
    /** vectorSpan.end */
    vec_end: number;
}

/** 向量搜索结果 */
export interface SearchResult extends ChunkRecord {
    _distance: number;
}

// ===========================================
// VectorStore 类
// ===========================================

export class VectorStore {
    private db: lancedb.Connection | null = null;
    private table: lancedb.Table | null = null;
    private projectId: string;
    private dbPath: string;
    private vectorDim: number;

    constructor(projectId: string, vectorDim = 1024) {
        this.projectId = projectId;
        this.dbPath = path.join(BASE_DIR, projectId, "vectors.lance");
        this.vectorDim = vectorDim;
    }

    /**
     * 初始化连接
     */
    async init(): Promise<void> {
        if (this.db) return;

        // 确保目录存在
        const projectDir = path.join(BASE_DIR, this.projectId);
        if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
        }

        this.db = await lancedb.connect(this.dbPath);

        // 获取或创建 chunks 表
        const tableNames = await this.db.tableNames();
        if (tableNames.includes("chunks")) {
            this.table = await this.db.openTable("chunks");
        }
        // 表不存在时，首次插入会自动创建
    }

    /**
     * 确保表存在（首次插入时调用）
     */
    private async ensureTable(records: ChunkRecord[]): Promise<void> {
        if (this.table) return;
        if (!this.db) throw new Error("VectorStore not initialized");
        if (records.length === 0) return;

        // 创建表并插入初始数据
        // 注意：LanceDB 期望 Record<string, unknown>[]，但 ChunkRecord 没有索引签名
        // 运行时两者等价，使用类型断言绕过 TypeScript 的严格检查
        this.table = await this.db.createTable("chunks", records as unknown as Record<string, unknown>[]);
    }

    /**
     * 单调版本更新：先插入新版本，再删除旧版本
     * 
     * 这保证了：
     * - 最坏情况（崩溃）是新旧版本共存（不缺失）
     * - 正常情况下旧版本被清理
     */
    async upsertFile(filePath: string, newHash: string, records: ChunkRecord[]): Promise<void> {
        if (!this.db) throw new Error("VectorStore not initialized");

        if (records.length === 0) {
            // 如果没有新 chunks，也要删除旧版本（文件可能变成空/无法解析）
            await this.deleteFile(filePath);
            return;
        }

        // 1. 插入新版本
        if (!this.table) {
            await this.ensureTable(records);
        } else {
            await this.table.add(records as unknown as Record<string, unknown>[]);
        }

        // 2. 删除旧版本（file_hash != newHash）
        if (this.table) {
            await this.table.delete(`file_path = '${this.escapeString(filePath)}' AND file_hash != '${this.escapeString(newHash)}'`);
        }
    }

    /**
     * 批量 upsert 多个文件（性能优化版，带分批机制）
     * 
     * 流程：
     * 1. 将文件分成小批次（每批最多 BATCH_FILES 个文件或 BATCH_RECORDS 条记录）
     * 2. 每批执行：插入新 records → 删除旧版本
     * 
     * 分批是必要的，因为 LanceDB native 模块在处理超大数据时可能崩溃
     * 
     * @param files 文件列表，每个包含 path、hash 和 records
     */
    async batchUpsertFiles(files: Array<{ path: string; hash: string; records: ChunkRecord[] }>): Promise<void> {
        if (!this.db) throw new Error("VectorStore not initialized");
        if (files.length === 0) return;

        // 分批参数（经验值，避免 native 模块崩溃）
        const BATCH_FILES = 50;      // 每批最多 50 个文件
        const BATCH_RECORDS = 5000;  // 每批最多 5000 条 records

        // 构建批次
        const batches: Array<typeof files> = [];
        let currentBatch: typeof files = [];
        let currentRecordCount = 0;

        for (const file of files) {
            // 检查是否需要开始新批次
            if (currentBatch.length >= BATCH_FILES ||
                currentRecordCount + file.records.length > BATCH_RECORDS) {
                if (currentBatch.length > 0) {
                    batches.push(currentBatch);
                }
                currentBatch = [];
                currentRecordCount = 0;
            }
            currentBatch.push(file);
            currentRecordCount += file.records.length;
        }
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        // 逐批处理
        for (const batch of batches) {
            // 收集本批次的所有 records
            const batchRecords: ChunkRecord[] = [];
            for (const file of batch) {
                batchRecords.push(...file.records);
            }

            if (batchRecords.length === 0) {
                // 本批次没有 chunks，只删除旧版本
                const pathsToDelete = batch.map(f => f.path);
                await this.deleteFiles(pathsToDelete);
                continue;
            }

            // 1. 批量插入本批次的 records
            if (!this.table) {
                await this.ensureTable(batchRecords);
            } else {
                await this.table.add(batchRecords as unknown as Record<string, unknown>[]);
            }

            // 2. 批量删除本批次的旧版本
            if (this.table && batch.length > 0) {
                const deleteConditions = batch
                    .map(f => `(file_path = '${this.escapeString(f.path)}' AND file_hash != '${this.escapeString(f.hash)}')`)
                    .join(' OR ');
                await this.table.delete(deleteConditions);
            }
        }
    }

    /**
     * 删除文件的所有 chunks
     */
    async deleteFile(filePath: string): Promise<void> {
        if (!this.table) return;
        await this.table.delete(`file_path = '${this.escapeString(filePath)}'`);
    }

    /**
     * 批量删除文件（性能优化：单次 DELETE 替代 N 次循环）
     */
    async deleteFiles(filePaths: string[]): Promise<void> {
        if (!this.table || filePaths.length === 0) return;

        // 使用单条 DELETE + OR 条件，将 N 次往返优化为 1 次
        const conditions = filePaths
            .map(p => `file_path = '${this.escapeString(p)}'`)
            .join(' OR ');
        await this.table.delete(conditions);
    }

    /**
     * 向量搜索
     */
    async search(
        queryVector: number[],
        limit = 10,
        filter?: string
    ): Promise<SearchResult[]> {
        if (!this.table) return [];

        let query = this.table.vectorSearch(queryVector).limit(limit);

        if (filter) {
            query = query.where(filter);
        }

        const results = await query.toArray();
        return results as SearchResult[];
    }

    /**
     * 获取文件的所有 chunks（按 chunk_index 排序）
     */
    async getFileChunks(filePath: string): Promise<ChunkRecord[]> {
        if (!this.table) return [];

        const results = await this.table
            .query()
            .where(`file_path = '${this.escapeString(filePath)}'`)
            .toArray();

        // 按 chunk_index 排序，确保返回顺序稳定
        const chunks = results as ChunkRecord[];
        return chunks.sort((a, b) => a.chunk_index - b.chunk_index);
    }

    /**
     * 批量获取多个文件的 chunks（性能优化：单次查询替代 N 次循环）
     * 
     * 适用于 GraphExpander 扩展、词法召回等需要批量获取的场景
     * @returns Map<filePath, ChunkRecord[]>，每个文件的 chunks 已按 chunk_index 排序
     */
    async getFilesChunks(filePaths: string[]): Promise<Map<string, ChunkRecord[]>> {
        const result = new Map<string, ChunkRecord[]>();
        if (!this.table || filePaths.length === 0) return result;

        // 单次查询所有文件
        const conditions = filePaths
            .map(p => `file_path = '${this.escapeString(p)}'`)
            .join(' OR ');

        const rows = await this.table
            .query()
            .where(conditions)
            .toArray();

        // 按文件分组
        for (const row of rows as ChunkRecord[]) {
            let arr = result.get(row.file_path);
            if (!arr) {
                arr = [];
                result.set(row.file_path, arr);
            }
            arr.push(row);
        }

        // 每个文件内按 chunk_index 排序
        for (const arr of result.values()) {
            arr.sort((a, b) => a.chunk_index - b.chunk_index);
        }

        return result;
    }

    /**
     * 获取表的总记录数
     */
    async count(): Promise<number> {
        if (!this.table) return 0;
        return await this.table.countRows();
    }

    /**
     * 清空所有数据
     */
    async clear(): Promise<void> {
        if (!this.db) return;

        try {
            await this.db.dropTable("chunks");
            this.table = null;
        } catch {
            // 表不存在，忽略
        }
    }

    /**
     * 获取向量维度
     */
    getVectorDim(): number {
        return this.vectorDim;
    }

    /**
     * 转义字符串（防止 SQL 注入）
     */
    private escapeString(str: string): string {
        return str.replace(/'/g, "''");
    }

    /**
     * 关闭连接
     */
    async close(): Promise<void> {
        this.db = null;
        this.table = null;
    }
}

// ===========================================
// 工厂函数
// ===========================================

const vectorStores = new Map<string, VectorStore>();

/**
 * 获取或创建 VectorStore 实例
 */
export async function getVectorStore(projectId: string, vectorDim = 1024): Promise<VectorStore> {
    let store = vectorStores.get(projectId);
    if (!store) {
        store = new VectorStore(projectId, vectorDim);
        await store.init();
        vectorStores.set(projectId, store);
    }
    return store;
}

/**
 * 关闭所有 VectorStore 连接
 */
export async function closeAllVectorStores(): Promise<void> {
    for (const store of vectorStores.values()) {
        await store.close();
    }
    vectorStores.clear();
}
