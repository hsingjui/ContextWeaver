/**
 * 搜索模块默认配置
 */

import type { SearchConfig } from './types.js';

export const DEFAULT_CONFIG: SearchConfig = {
  // 召回
  vectorTopK: 80,
  vectorTopM: 60,
  ftsTopKFiles: 20,
  lexChunksPerFile: 2,
  lexTotalChunks: 40,
  exactTopK: 40,
  pathTopK: 20,

  // 融合
  rrfK0: 20,
  wVec: 0.6,
  wLex: 0.4,
  wExact: 1.0,
  wPath: 0.8,
  fusedTopM: 60,

  // bounded query decomposition
  maxQueryFacets: 3,
  facetRrfWeight: 0.75,

  // Rerank
  rerankTopN: 10,
  maxRerankChars: 1000,
  maxBreadcrumbChars: 250,
  headRatio: 0.67,

  // 扩展 (同文件充分展开，跨文件由 Agent 按需发起)
  neighborHops: 2,
  breadcrumbExpandLimit: 3,
  importFilesPerSeed: 0,
  chunksPerImportFile: 0,
  decayNeighbor: 0.8,
  decayBreadcrumb: 0.7,
  decayImport: 0.6,
  decayDepth: 0.7,

  // 预计算 dependency graph 扩展
  graphFilesPerSeed: 4,
  graphChunksPerFile: 2,
  graphMaxDepth: 2,
  decayDependency: 0.65,
  dependencyDepthDecay: 0.7,

  // CoverageSelector / ContextPacker
  maxSegmentsPerFile: 3,
  maxContextFiles: 8,
  maxTotalChars: 48000,

  // Smart TopK
  enableSmartTopK: true,
  smartTopScoreRatio: 0.5,
  smartTopScoreDeltaAbs: 0.25,
  smartMinScore: 0.25,
  smartMinK: 2,
  smartMaxK: 8,
};
