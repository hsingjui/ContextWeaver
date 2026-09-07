/**
 * CoverageSelector - coverage-aware chunk selection before context packing.
 *
 * Two-pass strategy:
 * 1. Prefer the highest-scoring chunk from each file to improve repository coverage.
 * 2. Fill remaining budget by score, respecting the per-file limit.
 */

import type { ScoredChunk, SearchConfig } from './types.js';

export class CoverageSelector {
  private config: SearchConfig;

  constructor(config: SearchConfig) {
    this.config = config;
  }

  select(chunks: ScoredChunk[]): ScoredChunk[] {
    if (chunks.length === 0) return [];

    const sorted = [...chunks].sort((a, b) => b.score - a.score);
    const selected: ScoredChunk[] = [];
    const selectedKeys = new Set<string>();
    const countByFile = new Map<string, number>();
    let totalChars = 0;

    const trySelect = (chunk: ScoredChunk): boolean => {
      const key = this.chunkKey(chunk);
      if (selectedKeys.has(key)) return false;

      const fileCount = countByFile.get(chunk.filePath) ?? 0;
      if (fileCount >= this.config.maxSegmentsPerFile) return false;

      const chunkChars = this.chunkChars(chunk);
      if (totalChars + chunkChars > this.config.maxTotalChars) return false;

      selected.push(chunk);
      selectedKeys.add(key);
      countByFile.set(chunk.filePath, fileCount + 1);
      totalChars += chunkChars;
      return true;
    };

    // Pass 1: maximize file coverage while preserving score order.
    const coveredFiles = new Set<string>();
    for (const chunk of sorted) {
      if (coveredFiles.has(chunk.filePath)) continue;
      if (trySelect(chunk)) coveredFiles.add(chunk.filePath);
    }

    // Pass 2: fill remaining budget with the best remaining chunks.
    for (const chunk of sorted) {
      trySelect(chunk);
    }

    return selected;
  }

  private chunkChars(chunk: ScoredChunk): number {
    return Math.max(0, chunk.record.raw_end - chunk.record.raw_start);
  }

  private chunkKey(chunk: ScoredChunk): string {
    return `${chunk.filePath}#${chunk.chunkIndex}`;
  }
}
