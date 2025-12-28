/**
 * 搜索模块默认配置
 */

import type { SearchConfig } from "./types.js";

export const DEFAULT_CONFIG: SearchConfig = {
    // 召回
    vectorTopK: 80,
    vectorTopM: 60,
    ftsTopKFiles: 20,
    lexChunksPerFile: 2,
    lexTotalChunks: 40,

    // 融合
    rrfK0: 20,
    wVec: 0.6,
    wLex: 0.4,
    fusedTopM: 60,

    // Rerank
    rerankTopN: 10,
    maxRerankChars: 1000,
    maxBreadcrumbChars: 250,
    headRatio: 0.67,

    // 扩展
    neighborHops: 1,
    breadcrumbExpandLimit: 1,
    importFilesPerSeed: 5,
    chunksPerImportFile: 2,
    decayNeighbor: 0.8,
    decayBreadcrumb: 0.7,
    decayImport: 0.6,
    decayDepth: 0.7,

    // ContextPacker
    maxSegmentsPerFile: 3,
    maxTotalChars: 48000,

    // Smart TopK
    enableSmartTopK: true,
    smartTopScoreRatio: 0.5,
    smartTopScoreDeltaAbs: 0.25,
    smartMinScore: 0.25,
    smartMinK: 2,
    smartMaxK: 8,
};
