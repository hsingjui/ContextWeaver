/**
 * 搜索模块类型定义
 */

import type { ChunkRecord } from '../vectorStore/index.js';
import type { RetrievalPlan } from './RetrievalPlan.js';

// ===========================================
// 配置类型
// ===========================================

/** 搜索配置 */
export interface SearchConfig {
  // 召回
  vectorTopK: number;
  vectorTopM: number;
  ftsTopKFiles: number;
  lexChunksPerFile: number;
  lexTotalChunks: number;
  exactTopK: number;
  pathTopK: number;

  // 融合（Phase 1）
  rrfK0: number;
  wVec: number;
  wLex: number;
  wExact: number;
  wPath: number;
  fusedTopM: number;

  // bounded query decomposition
  maxQueryFacets: number;
  facetRrfWeight: number;

  // Rerank
  rerankTopN: number;
  maxRerankChars: number;
  maxBreadcrumbChars: number;
  headRatio: number;

  // 扩展（Phase 2）
  neighborHops: number;
  breadcrumbExpandLimit: number;
  importFilesPerSeed: number;
  chunksPerImportFile: number;
  decayNeighbor: number;
  decayBreadcrumb: number;
  decayImport: number;
  decayDepth: number;

  // 预计算 dependency graph
  graphFilesPerSeed: number;
  graphChunksPerFile: number;
  graphMaxDepth: number;
  decayDependency: number;
  dependencyDepthDecay: number;

  // CoverageSelector / ContextPacker
  maxSegmentsPerFile: number;
  maxContextFiles: number;
  maxTotalChars: number;

  // === Smart TopK ===
  /** 是否启用智能 TopK 策略 */
  enableSmartTopK: boolean;

  /**
   * 动态阈值比例：dynamicThreshold 的 ratio 部分
   * ratioThreshold = topScore * smartTopScoreRatio
   * 推荐：0.4 ~ 0.6
   */
  smartTopScoreRatio: number;

  /**
   * 绝对差距护栏：保护 Top1 outlier 场景
   * deltaThreshold = topScore - smartTopScoreDeltaAbs
   * dynamicThreshold = max(floor, min(ratioThreshold, deltaThreshold))
   * 推荐：0.20 ~ 0.35
   */
  smartTopScoreDeltaAbs: number;

  /**
   * 最低分数阈值（floor）：低于此分数视为垃圾
   * 推荐：0.20 ~ 0.30（依赖 reranker 分数归一化稳定性）
   */
  smartMinScore: number;

  /**
   * Safe Harbor：前 minK 个只检查 floor，不检查 ratio/delta
   * 推荐：2 或 3
   */
  smartMinK: number;

  /**
   * 硬上限，避免刷屏 / token 溢出
   */
  smartMaxK: number;
}

// ===========================================
// 搜索结果类型
// ===========================================

/** Chunk 来源类型 */
export type ChunkSource =
  | 'vector'
  | 'lexical'
  | 'exact'
  | 'path'
  | 'neighbor'
  | 'breadcrumb'
  | 'import'
  | 'dependency';

/** 带得分的 Chunk */
export interface ScoredChunk {
  /** 来源文件路径 */
  filePath: string;
  /** 文件内序号 */
  chunkIndex: number;
  /** 综合得分（rerank score 或衰减后的 score） */
  score: number;
  /** 来源类型 */
  source: ChunkSource;
  /** 原始 ChunkRecord */
  record: ChunkRecord & { _distance: number };
}

/** 轻量排序快照，用于结构化诊断输出，不复制 chunk 文本。 */
export interface RankedChunkTrace {
  filePath: string;
  chunkIndex: number;
  score: number;
  source: ChunkSource;
}

/** 一次 full-query/facet 召回的各通道与融合结果。 */
export interface RetrievalCallTrace {
  query: string;
  intent: RetrievalPlan['intent'];
  vector: RankedChunkTrace[];
  lexical: RankedChunkTrace[];
  exact: RankedChunkTrace[];
  path: RankedChunkTrace[];
  fused: RankedChunkTrace[];
}

/** 合并后的段 */
export interface Segment {
  /** 文件路径 */
  filePath: string;
  /** 原始起始偏移 */
  rawStart: number;
  /** 原始结束偏移 */
  rawEnd: number;
  /** 起始行号（1-indexed） */
  startLine: number;
  /** 结束行号（1-indexed） */
  endLine: number;
  /** 段内最高得分 */
  score: number;
  /** 面包屑（取段内第一个 chunk 的） */
  breadcrumb: string;
  /** 段文本（从原文件切片） */
  text: string;
}

/** 上下文包 */
export interface ContextPack {
  /** 原始查询 */
  query: string;
  /** seed chunks（rerank 后的 topN） */
  seeds: ScoredChunk[];
  /** 扩展的 chunks */
  expanded: ScoredChunk[];
  /** 最终输出的段落（按文件聚合） */
  files: Array<{
    filePath: string;
    segments: Segment[];
  }>;
  /** 调试信息 */
  debug?: {
    wVec: number;
    wLex: number;
    wExact: number;
    wPath: number;
    timingMs: Record<string, number>;
    plan?: RetrievalPlan;
    facets?: string[];
    graphAnchorTerms?: string[];
    retrieval?: {
      calls: RetrievalCallTrace[];
      combined: RankedChunkTrace[];
      reranked: RankedChunkTrace[];
      cutoff: RankedChunkTrace[];
    };
    selection?: {
      candidates: number;
      selectedChunks: number;
      selectedFiles: number;
      selectedChars: number;
      skippedDuplicates: number;
      skippedPerFileLimit: number;
      skippedBudget: number;
      skippedFileLimit: number;
    };
  };
}
