/**
 * ContextPacker - 上下文打包器
 * 
 * 负责将多个 ScoredChunk 合并、切片，并按预算裁剪，
 * 最终输出适合 LLM 消费的上下文包。
 */

import { initDb } from "../db/index.js";
import type { SearchConfig, ScoredChunk, Segment } from "./types.js";

export class ContextPacker {
    private projectId: string;
    private config: SearchConfig;

    constructor(projectId: string, config: SearchConfig) {
        this.projectId = projectId;
        this.config = config;
    }

    /**
     * 打包：合并 chunks → 按文件聚合段落 → 预算裁剪
     */
    async pack(chunks: ScoredChunk[]): Promise<Array<{ filePath: string; segments: Segment[] }>> {
        if (chunks.length === 0) return [];

        // 1. 按文件分组
        const byFile = this.groupByFile(chunks);

        // 2. 每个文件内合并区间 + 从原文件切片
        const db = initDb(this.projectId);
        const result: Array<{ filePath: string; segments: Segment[] }> = [];
        let totalChars = 0;

        // 按文件最高得分排序
        const sortedFiles = Object.entries(byFile)
            .map(([filePath, fileChunks]) => ({
                filePath,
                chunks: fileChunks,
                maxScore: Math.max(...fileChunks.map(c => c.score)),
            }))
            .sort((a, b) => b.maxScore - a.maxScore);

        // 性能优化：批量读取所有文件内容（N 次 SELECT → 1 次）
        const allFilePaths = sortedFiles.map(f => f.filePath);
        const placeholders = allFilePaths.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT path, content FROM files WHERE path IN (${placeholders})`
        ).all(...allFilePaths) as Array<{ path: string; content: string }>;
        const contentMap = new Map(rows.map(r => [r.path, r.content]));

        for (const { filePath, chunks: fileChunks } of sortedFiles) {
            // 从批量结果中获取文件内容
            const content = contentMap.get(filePath);
            if (!content) continue;

            // 合并区间
            const segments = this.mergeAndSlice(fileChunks, content);

            // 每文件最多 N 段
            const topSegments = segments
                .sort((a, b) => b.score - a.score)
                .slice(0, this.config.maxSegmentsPerFile)
                .sort((a, b) => a.rawStart - b.rawStart); // 按位置排序输出

            // 预算检查
            const budgetedSegments: Segment[] = [];
            for (const seg of topSegments) {
                if (totalChars + seg.text.length > this.config.maxTotalChars) {
                    // 预算用尽，停止添加
                    break;
                }
                totalChars += seg.text.length;
                budgetedSegments.push(seg);
            }

            if (budgetedSegments.length > 0) {
                result.push({ filePath, segments: budgetedSegments });
            }

            // 预算用尽
            if (totalChars >= this.config.maxTotalChars) break;
        }

        return result;
    }

    /**
     * 按文件分组
     */
    private groupByFile(chunks: ScoredChunk[]): Record<string, ScoredChunk[]> {
        const byFile: Record<string, ScoredChunk[]> = {};
        for (const chunk of chunks) {
            const key = chunk.filePath;
            if (!byFile[key]) byFile[key] = [];
            byFile[key].push(chunk);
        }
        return byFile;
    }

    /**
     * 合并重叠区间 + 从原文件切片
     */
    private mergeAndSlice(chunks: ScoredChunk[], content: string): Segment[] {
        if (chunks.length === 0) return [];

        // 按 raw_start 排序
        const sorted = [...chunks].sort((a, b) => a.record.raw_start - b.record.raw_start);

        // 线性合并区间
        const intervals: Array<{
            start: number;
            end: number;
            score: number;
            breadcrumb: string;
            chunks: ScoredChunk[];
        }> = [];

        for (const chunk of sorted) {
            const start = chunk.record.raw_start;
            const end = chunk.record.raw_end;
            const last = intervals[intervals.length - 1];

            if (last && start <= last.end) {
                // 重叠，合并
                last.end = Math.max(last.end, end);
                last.score = Math.max(last.score, chunk.score);
                last.chunks.push(chunk);
            } else {
                // 新区间
                intervals.push({
                    start,
                    end,
                    score: chunk.score,
                    breadcrumb: chunk.record.breadcrumb,
                    chunks: [chunk],
                });
            }
        }

        // 从原文件切片，并计算行号
        return intervals.map(iv => {
            const startLine = this.offsetToLine(content, iv.start);
            const endLine = this.offsetToLine(content, iv.end);
            return {
                filePath: chunks[0].filePath,
                rawStart: iv.start,
                rawEnd: iv.end,
                startLine,
                endLine,
                score: iv.score,
                breadcrumb: iv.breadcrumb,
                text: content.slice(iv.start, iv.end),
            };
        });
    }

    /**
     * 将字符偏移量转换为行号（1-indexed）
     */
    private offsetToLine(content: string, offset: number): number {
        let line = 1;
        for (let i = 0; i < offset && i < content.length; i++) {
            if (content[i] === '\n') {
                line++;
            }
        }
        return line;
    }
}
