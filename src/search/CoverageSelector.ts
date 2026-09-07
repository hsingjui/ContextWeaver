/**
 * CoverageSelector - coverage-aware chunk selection before context packing.
 *
 * Two-pass strategy:
 * 1. Prefer the highest-scoring chunk from each file to improve repository coverage.
 * 2. Fill remaining budget by score, respecting the per-file limit.
 *
 * Exact duplicate chunks are removed here. Raw-span overlap is intentionally left to
 * ContextPacker, which already merges overlapping/adjacent spans while preserving the
 * semantic chunks selected by this stage.
 */

import type { ScoredChunk, SearchConfig } from './types.js';

export interface CoverageSelectionStats {
  candidates: number;
  selectedChunks: number;
  selectedFiles: number;
  selectedChars: number;
  skippedDuplicates: number;
  skippedPerFileLimit: number;
  skippedBudget: number;
  skippedFileLimit: number;
}

export interface CoverageSelectionResult {
  chunks: ScoredChunk[];
  stats: CoverageSelectionStats;
}

export class CoverageSelector {
  private config: SearchConfig;

  constructor(config: SearchConfig) {
    this.config = config;
  }

  select(chunks: ScoredChunk[]): ScoredChunk[] {
    return this.selectWithStats(chunks).chunks;
  }

  selectWithStats(chunks: ScoredChunk[]): CoverageSelectionResult {
    const stats: CoverageSelectionStats = {
      candidates: chunks.length,
      selectedChunks: 0,
      selectedFiles: 0,
      selectedChars: 0,
      skippedDuplicates: 0,
      skippedPerFileLimit: 0,
      skippedBudget: 0,
      skippedFileLimit: 0,
    };
    if (chunks.length === 0) return { chunks: [], stats };

    const sorted = [...chunks].sort((a, b) => b.score - a.score);
    const unique: ScoredChunk[] = [];
    const seenCandidates = new Set<string>();
    for (const chunk of sorted) {
      const key = this.chunkKey(chunk);
      if (seenCandidates.has(key)) {
        stats.skippedDuplicates++;
        continue;
      }
      seenCandidates.add(key);
      unique.push(chunk);
    }

    const selected: ScoredChunk[] = [];
    const selectedKeys = new Set<string>();
    const countByFile = new Map<string, number>();
    const skipReasons = new Set<string>();
    let totalChars = 0;

    const recordSkip = (reason: 'per-file' | 'budget' | 'file-limit', key: string): void => {
      const reasonKey = `${reason}:${key}`;
      if (skipReasons.has(reasonKey)) return;
      skipReasons.add(reasonKey);
      if (reason === 'per-file') stats.skippedPerFileLimit++;
      else if (reason === 'file-limit') stats.skippedFileLimit++;
      else stats.skippedBudget++;
    };

    const trySelect = (chunk: ScoredChunk): boolean => {
      const key = this.chunkKey(chunk);
      if (selectedKeys.has(key)) return false;

      const fileCount = countByFile.get(chunk.filePath) ?? 0;
      if (fileCount === 0 && countByFile.size >= this.config.maxContextFiles) {
        recordSkip('file-limit', key);
        return false;
      }
      if (fileCount >= this.config.maxSegmentsPerFile) {
        recordSkip('per-file', key);
        return false;
      }

      const chunkChars = this.chunkChars(chunk);
      if (totalChars + chunkChars > this.config.maxTotalChars) {
        recordSkip('budget', key);
        return false;
      }

      selected.push(chunk);
      selectedKeys.add(key);
      countByFile.set(chunk.filePath, fileCount + 1);
      totalChars += chunkChars;
      return true;
    };

    // Pass 1: maximize file coverage while preserving score order. If a file's top
    // chunk does not fit, later smaller chunks from the same file still get a chance.
    const coveredFiles = new Set<string>();
    for (const chunk of unique) {
      if (coveredFiles.has(chunk.filePath)) continue;
      if (trySelect(chunk)) coveredFiles.add(chunk.filePath);
    }

    // Pass 2: fill remaining budget with the best remaining chunks.
    for (const chunk of unique) {
      trySelect(chunk);
    }

    stats.selectedChunks = selected.length;
    stats.selectedFiles = countByFile.size;
    stats.selectedChars = totalChars;
    return { chunks: selected, stats };
  }

  private chunkChars(chunk: ScoredChunk): number {
    return Math.max(0, chunk.record.raw_end - chunk.record.raw_start);
  }

  private chunkKey(chunk: ScoredChunk): string {
    return `${chunk.filePath}#${chunk.chunkIndex}`;
  }
}
