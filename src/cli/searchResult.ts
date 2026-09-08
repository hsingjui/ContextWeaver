/**
 * CLI 机器输出契约（--json / --jsonl）
 *
 * CliSearchResultV1 是面向外部调用方（如 cw-benchmark）的稳定快照：
 * 只输出白名单字段，绝不透传内部 ScoredChunk.record（含 768 维 vector、
 * vector_text、display_code）等内部数据结构。版本号递增以支持未来演进。
 */

import { z } from 'zod';
import { codebaseRetrievalSchema } from '../mcp/tools/codebaseRetrieval.js';
import type { RetrievalPlan } from '../search/RetrievalPlan.js';
import type { ContextPack, RankedChunkTrace, ScoredChunk } from '../search/types.js';

/** --json / --jsonl 输出的稳定版检索结果（v1） */
export interface CliSearchResultV1 {
  version: 1;
  query: string;
  seeds: RankedChunkTrace[];
  expanded: RankedChunkTrace[];
  files: Array<{
    filePath: string;
    segments: Array<{
      rawStart: number;
      rawEnd: number;
      startLine: number;
      endLine: number;
      score: number;
      breadcrumb: string;
      text: string;
    }>;
  }>;
  /** 诊断信息（timing 等），均为轻量纯数据 */
  debug?: {
    wVec: number;
    wLex: number;
    wExact: number;
    wPath: number;
    timingMs: Record<string, number>;
    plan?: RetrievalPlan;
    facets?: string[];
    graphAnchorTerms?: string[];
    retrieval?: NonNullable<NonNullable<ContextPack['debug']>['retrieval']>;
    selection?: NonNullable<NonNullable<ContextPack['debug']>['selection']>;
  };
}

function snapshotChunk(chunk: ScoredChunk): RankedChunkTrace {
  return {
    filePath: chunk.filePath,
    chunkIndex: chunk.chunkIndex,
    score: chunk.score,
    source: chunk.source,
  };
}

/** 将内部 ContextPack 收敛为稳定的 CLI 输出快照。 */
export function toCliSearchResult(pack: ContextPack): CliSearchResultV1 {
  const result: CliSearchResultV1 = {
    version: 1,
    query: pack.query,
    seeds: pack.seeds.map(snapshotChunk),
    expanded: pack.expanded.map(snapshotChunk),
    files: pack.files.map((file) => ({
      filePath: file.filePath,
      segments: file.segments.map((segment) => ({
        rawStart: segment.rawStart,
        rawEnd: segment.rawEnd,
        startLine: segment.startLine,
        endLine: segment.endLine,
        score: segment.score,
        breadcrumb: segment.breadcrumb,
        text: segment.text,
      })),
    })),
  };

  if (pack.debug) {
    const {
      wVec,
      wLex,
      wExact,
      wPath,
      timingMs,
      plan,
      facets,
      graphAnchorTerms,
      retrieval,
      selection,
    } = pack.debug;
    result.debug = {
      wVec,
      wLex,
      wExact,
      wPath,
      timingMs,
      plan,
      facets,
      graphAnchorTerms,
      retrieval,
      selection,
    };
  }

  return result;
}

/** --jsonl 每行查询的校验 schema（复用 MCP 契约，去掉 repo_path，收紧必填项） */
export const jsonlQuerySchema = codebaseRetrievalSchema.omit({ repo_path: true }).extend({
  information_request: z.string().trim().min(1, 'information_request 不能为空'),
});

export type JsonlQuery = z.infer<typeof jsonlQuerySchema>;

export type JsonlRow = { ok: true; query: JsonlQuery } | { ok: false; error: string };

/** 解析并校验一行 JSONL 查询；row 从 1 开始，用于错误信息定位。 */
export function parseJsonlLine(raw: string, row: number): JsonlRow {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: `JSONL 第 ${row} 行不是合法 JSON` };
  }
  const result = jsonlQuerySchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `[${issue.path.join('.') || 'root'}] ${issue.message}`)
      .join('; ');
    return { ok: false, error: `JSONL 第 ${row} 行校验失败: ${detail}` };
  }
  return { ok: true, query: result.data };
}
