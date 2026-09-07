export type RetrievalCategory =
  | 'symbol'
  | 'feature'
  | 'path'
  | 'reference'
  | 'call-chain'
  | 'overview'
  | 'compound';

export interface RetrievalCase {
  id: string;
  category: RetrievalCategory;
  informationRequest: string;
  technicalTerms?: string[];
  relevantFiles: string[];
}

export interface CaseMetrics {
  top1FileHit: boolean;
  recallAt5: boolean;
  recallAt10: boolean;
  reciprocalRank: number;
  relevantFileCoverage: number;
  uniqueFiles: number;
  returnedChars: number;
}

export interface TimingMetrics {
  retrieve?: number;
  rerank?: number;
  total: number;
}

export interface SummarizableCaseResult {
  category: RetrievalCategory;
  metrics: CaseMetrics;
  timingMs: TimingMetrics;
}

export interface LatencySummary {
  avgMs: number;
  p50Ms: number;
}

export interface BenchmarkSummary {
  cases: number;
  top1FileAccuracy: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  relevantFileCoverage: number;
  avgUniqueFiles: number;
  avgReturnedChars: number;
  latencyMs: {
    retrieve: LatencySummary;
    rerank: LatencySummary;
    total: LatencySummary;
  };
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function latencySummary(values: number[]): LatencySummary {
  return {
    avgMs: mean(values),
    p50Ms: p50(values),
  };
}

export function evaluateRanking(
  relevantFiles: string[],
  rankedFiles: string[],
  returnedChars: number,
): CaseMetrics {
  const relevant = new Set(relevantFiles.map(normalizePath));
  const uniqueRanked = Array.from(new Set(rankedFiles.map(normalizePath)));
  const firstRelevantIndex = uniqueRanked.findIndex((filePath) => relevant.has(filePath));
  const matchedRelevant = new Set(uniqueRanked.filter((filePath) => relevant.has(filePath)));

  return {
    top1FileHit: firstRelevantIndex === 0,
    recallAt5: uniqueRanked.slice(0, 5).some((filePath) => relevant.has(filePath)),
    recallAt10: uniqueRanked.slice(0, 10).some((filePath) => relevant.has(filePath)),
    reciprocalRank: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
    relevantFileCoverage: relevant.size > 0 ? matchedRelevant.size / relevant.size : 0,
    uniqueFiles: uniqueRanked.length,
    returnedChars,
  };
}

export function summarize(results: SummarizableCaseResult[]): BenchmarkSummary {
  if (results.length === 0) {
    return {
      cases: 0,
      top1FileAccuracy: 0,
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
      relevantFileCoverage: 0,
      avgUniqueFiles: 0,
      avgReturnedChars: 0,
      latencyMs: {
        retrieve: latencySummary([]),
        rerank: latencySummary([]),
        total: latencySummary([]),
      },
    };
  }

  return {
    cases: results.length,
    top1FileAccuracy: mean(results.map((result) => Number(result.metrics.top1FileHit))),
    recallAt5: mean(results.map((result) => Number(result.metrics.recallAt5))),
    recallAt10: mean(results.map((result) => Number(result.metrics.recallAt10))),
    mrr: mean(results.map((result) => result.metrics.reciprocalRank)),
    relevantFileCoverage: mean(results.map((result) => result.metrics.relevantFileCoverage)),
    avgUniqueFiles: mean(results.map((result) => result.metrics.uniqueFiles)),
    avgReturnedChars: mean(results.map((result) => result.metrics.returnedChars)),
    latencyMs: {
      retrieve: latencySummary(
        results.flatMap((result) =>
          result.timingMs.retrieve === undefined ? [] : [result.timingMs.retrieve],
        ),
      ),
      rerank: latencySummary(
        results.flatMap((result) =>
          result.timingMs.rerank === undefined ? [] : [result.timingMs.rerank],
        ),
      ),
      total: latencySummary(results.map((result) => result.timingMs.total)),
    },
  };
}
