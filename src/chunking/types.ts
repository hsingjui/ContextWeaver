import type Parser from '@keqingmoe/tree-sitter';

// ==========================================
// 分片元数据：用于后续的过滤和定位
// ==========================================

export interface ChunkMetadata {
  /** 语义起始偏移量（节点边界，用于高亮/跳转） */
  startIndex: number;
  /** 语义结束偏移量（节点边界） */
  endIndex: number;
  /**
   * 原始覆盖范围 [start, end)，用于无空洞还原
   * - rawSpan.start: 本 chunk 负责的起始位置（含前置 gap）
   * - rawSpan.end: 本 chunk 负责的结束位置
   * 保证：所有 chunk 的 rawSpan 拼接后 === 完整文件（不重叠）
   */
  rawSpan: { start: number; end: number };
  /**
   * 向量文本覆盖范围 [start, end)，用于语义检索
   * - 可以与相邻 chunk 重叠（overlap）
   * - vectorText 基于此范围生成
   * - 如果没有启用 overlap，则等于 [startIndex, endIndex)
   */
  vectorSpan: { start: number; end: number };
  /** 文件路径 */
  filePath: string;
  /** 语言 ID (e.g., "typescript") */
  language: string;
  /** 语义路径 (e.g., ["src/auth.ts", "class User", "method login"]) */
  contextPath: string[];
}

// ==========================================
// 最终产物
// ==========================================

export interface ProcessedChunk {
  /** 展示层：纯净代码 (用于 UI) */
  displayCode: string;

  /** 向量层：增强文本 (用于 Embedding) */
  vectorText: string;

  /** 统计层：非空白字符大小 (用于预算控制) */
  nwsSize: number;

  metadata: ChunkMetadata;
}

// ==========================================
// 内部滑动窗口结构
// ==========================================

export interface Window {
  /** 包含的 AST 节点 */
  nodes: Parser.SyntaxNode[];
  /** 节点累加大小 + 内部缝隙大小 */
  size: number;
  /** 语义上下文路径 */
  contextPath: string[];
}

// ==========================================
// 分片器配置
// ==========================================

export interface SplitterConfig {
  /** 最大分片大小（非空白字符数） */
  maxChunkSize: number;
  /** 最小分片大小（小于此值的碎片尝试强制合并） */
  minChunkSize: number;
  /**
   * 分片重叠大小（非空白字符数）
   * - 用于提升语义检索的召回率
   * - 只影响 vectorText/vectorSpan，不影响 rawSpan
   * - 默认为 0（不重叠）
   */
  chunkOverlap: number;
  /**
   * 物理字符硬上限（合并熔断）
   * - 防止 NWS 小但物理长度大的代码块（如大量注释）撑爆 Token 预算
   * - 合并时会同时检查 NWS 和 Raw 两个预算
   * - 默认为 maxChunkSize * 4（假设 1 token ≈ 4 chars）
   */
  maxRawChars: number;
}
