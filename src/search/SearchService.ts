/**
 * SearchService - 搜索服务
 *
 * Phase 0: 向量召回 + Rerank
 * Phase 1: 添加词法召回 + RRF 融合
 * Phase 2: 上下文扩展（邻居/breadcrumb/import）
 *
 * - buildContextPack(): 用于问答/生成的上下文包
 */

import type Database from 'better-sqlite3';
import { getRerankerClient } from '../api/reranker.js';
import { getEmbeddingConfig } from '../config.js';
import {
  findExistingSymbolIdentifiers,
  getSharedDb,
  searchSymbolOccurrences,
} from '../db/index.js';
import { getIndexer, type Indexer } from '../indexer/index.js';
import { isDebugEnabled, logger } from '../utils/logger.js';
import type { SearchResult as VectorSearchResult } from '../vectorStore/index.js';
import { getVectorStore, type VectorStore } from '../vectorStore/index.js';
import { ContextPacker } from './ContextPacker.js';
import { CoverageSelector } from './CoverageSelector.js';
import { DEFAULT_CONFIG } from './config.js';
import {
  getTokenBoundaryRegex,
  isChunksFtsInitialized,
  isFtsInitialized,
  searchChunksFts,
  searchFilesFts,
  segmentQuery,
} from './fts.js';
import { getGraphExpander } from './GraphExpander.js';
import { searchPaths } from './PathRecall.js';
import { decomposeQuery } from './QueryDecomposer.js';
import { buildRetrievalPlan, type RetrievalPlan } from './RetrievalPlan.js';
import type {
  ContextPack,
  RankedChunkTrace,
  RetrievalCallTrace,
  ScoredChunk,
  SearchConfig,
} from './types.js';

export class SearchService {
  private projectId: string;
  private indexer: Indexer | null = null;
  private vectorStore: VectorStore | null = null;
  private db: Database.Database | null = null;
  private config: SearchConfig;

  constructor(projectId: string, _projectPath: string, config?: Partial<SearchConfig>) {
    this.projectId = projectId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    const embeddingConfig = getEmbeddingConfig();
    this.indexer = await getIndexer(this.projectId, embeddingConfig.dimensions);
    this.vectorStore = await getVectorStore(this.projectId, embeddingConfig.dimensions);
    this.db = getSharedDb(this.projectId);
  }

  // 公开接口

  /**
   * 构建上下文包（用于问答/生成）
   */
  async buildContextPack(query: string): Promise<ContextPack> {
    const timingMs: Record<string, number> = {};
    // 检索自身耗时（不含索引准备 / service.init / 外层序列化），供基准测试使用
    const startedAt = Date.now();
    let t0 = startedAt;

    const plan = buildRetrievalPlan(query);
    const retrievalCalls: RetrievalCallTrace[] = [];

    // 1. 按 RetrievalPlan 执行召回通道；compound query 保留 full query 并追加 bounded facets。
    const facets =
      plan.intent === 'compound' ? decomposeQuery(query, this.config.maxQueryFacets) : [];
    const candidates =
      facets.length > 0
        ? await this.retrieveWithFacets(query, facets, plan, retrievalCalls)
        : await this.hybridRetrieve(query, plan, retrievalCalls);
    timingMs.retrieve = Date.now() - t0;

    // 2. 取 topM
    t0 = Date.now();
    const topM = candidates.sort((a, b) => b.score - a.score).slice(0, this.config.fusedTopM);

    // 3. Rerank → seeds
    const reranked = await this.rerank(query, topM);
    timingMs.rerank = Date.now() - t0;

    // 4. Smart TopK Cutoff
    t0 = Date.now();
    const cutoffSeeds = this.applySmartCutoff(reranked, plan);
    const graphAnchorTerms =
      plan.intent === 'reference' ? this.resolveGraphAnchorTerms(query) : undefined;
    // Import/dependency edges are contextual hints, not symbol-call evidence. Do not relabel or
    // over-boost reverse imports as callers; true caller semantics require symbol reference edges.
    const seeds = cutoffSeeds;
    timingMs.smartCutoff = Date.now() - t0;

    // 5. 扩展（Phase 2 实现）
    t0 = Date.now();
    const queryTokens = this.extractQueryTokens(query);
    const dependencySeeds =
      plan.intent === 'reference'
        ? await this.exactSymbolRetrieve(query, graphAnchorTerms ?? [])
        : undefined;
    const expanded = await this.expand(seeds, queryTokens, plan, dependencySeeds);
    timingMs.expand = Date.now() - t0;

    // 6. coverage-aware 选择
    t0 = Date.now();
    const selector = new CoverageSelector(this.config);
    const selection = selector.selectWithStats([...seeds, ...expanded]);
    const selected = selection.chunks;
    timingMs.select = Date.now() - t0;

    // 7. 打包
    t0 = Date.now();
    const packer = new ContextPacker(this.projectId, this.config);
    const files = await packer.pack(selected);
    timingMs.pack = Date.now() - t0;
    timingMs.total = Date.now() - startedAt;

    return {
      query,
      seeds,
      expanded,
      files,
      debug: {
        wVec: this.config.wVec,
        wLex: this.config.wLex,
        wExact: this.config.wExact,
        wPath: this.config.wPath,
        timingMs,
        selection: selection.stats,
        plan,
        facets,
        graphAnchorTerms,
        retrieval: {
          calls: retrievalCalls,
          combined: this.snapshotRanking(candidates),
          reranked: this.snapshotRanking(reranked),
          cutoff: this.snapshotRanking(cutoffSeeds),
        },
      },
    };
  }

  // 召回方法

  /**
   * 混合召回：向量 + 词法 + exact symbol。
   */
  private async hybridRetrieve(
    query: string,
    plan = buildRetrievalPlan(query),
    trace?: RetrievalCallTrace[],
  ): Promise<ScoredChunk[]> {
    const [vectorResults, lexicalResults, exactResults, pathResults] = await Promise.all([
      plan.useVector ? this.vectorRetrieve(query) : Promise.resolve([]),
      plan.useLexical ? this.lexicalRetrieve(query) : Promise.resolve([]),
      plan.useExact ? this.exactSymbolRetrieve(query) : Promise.resolve([]),
      plan.usePath ? this.pathRetrieve(query) : Promise.resolve([]),
    ]);

    logger.debug(
      {
        vectorCount: vectorResults.length,
        lexicalCount: lexicalResults.length,
        exactCount: exactResults.length,
        pathCount: pathResults.length,
      },
      '混合召回完成',
    );

    const fused = this.fuse(vectorResults, lexicalResults, exactResults, pathResults);
    trace?.push({
      query,
      intent: plan.intent,
      vector: this.snapshotRanking(vectorResults),
      lexical: this.snapshotRanking(lexicalResults),
      exact: this.snapshotRanking(exactResults),
      path: this.snapshotRanking(pathResults),
      fused: this.snapshotRanking(fused),
    });
    return fused;
  }

  private async retrieveWithFacets(
    query: string,
    facets: string[],
    plan: RetrievalPlan,
    trace?: RetrievalCallTrace[],
  ): Promise<ScoredChunk[]> {
    const resultSets = await Promise.all([
      this.hybridRetrieve(query, plan, trace),
      ...facets.map((facet) => this.hybridRetrieve(facet, buildRetrievalPlan(facet), trace)),
    ]);
    return this.fuseFacetResults(resultSets);
  }

  private fuseFacetResults(resultSets: ScoredChunk[][]): ScoredChunk[] {
    const fused = new Map<string, { score: number; chunk: ScoredChunk }>();
    for (let queryIndex = 0; queryIndex < resultSets.length; queryIndex++) {
      const weight = queryIndex === 0 ? 1 : this.config.facetRrfWeight;
      const ranked = [...resultSets[queryIndex]].sort((a, b) => b.score - a.score);
      for (let rank = 0; rank < ranked.length; rank++) {
        const chunk = ranked[rank];
        const key = `${chunk.filePath}#${chunk.chunkIndex}`;
        const contribution = weight / (this.config.rrfK0 + rank);
        const existing = fused.get(key);
        if (existing) {
          existing.score += contribution;
          if (chunk.score > existing.chunk.score) existing.chunk = chunk;
        } else {
          fused.set(key, { score: contribution, chunk });
        }
      }
    }
    return Array.from(fused.values())
      .map(({ score, chunk }) => ({ ...chunk, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.fusedTopM);
  }

  private snapshotRanking(chunks: ScoredChunk[], limit = 20): RankedChunkTrace[] {
    return chunks.slice(0, limit).map((chunk) => ({
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      score: chunk.score,
      source: chunk.source,
    }));
  }

  /**
   * 向量召回
   */
  private async vectorRetrieve(query: string): Promise<ScoredChunk[]> {
    if (!this.indexer) throw new Error('SearchService not initialized');

    const results = await this.indexer.textSearch(query, this.config.vectorTopK);
    if (!results) return [];

    // 按距离排序并转换
    return results
      .sort((a, b) => a._distance - b._distance)
      .slice(0, this.config.vectorTopM)
      .map((r: VectorSearchResult, rank: number) => ({
        filePath: r.file_path,
        chunkIndex: r.chunk_index,
        score: 1 / (1 + r._distance), // 转为相似度（用于调试）
        source: 'vector' as const,
        record: r,
        _rank: rank, // 用于 RRF
      }));
  }

  /** File-path lexical recall, only enabled by RetrievalPlan for path/compound queries. */
  private async pathRetrieve(query: string): Promise<ScoredChunk[]> {
    if (!this.db || !this.vectorStore) return [];
    const matches = searchPaths(this.db, query, this.config.pathTopK);
    if (matches.length === 0) return [];
    const chunksByFile = await this.vectorStore.getFilesChunks(
      matches.map((item) => item.filePath),
    );
    const out: Array<ScoredChunk & { _rank: number }> = [];
    for (const match of matches) {
      const chunks = chunksByFile.get(match.filePath) ?? [];
      if (chunks.length === 0) continue;
      const queryTokens = this.extractQueryTokens(query);
      const representative = [...chunks].sort(
        (a, b) =>
          this.scoreChunkTokenOverlap(b, queryTokens) -
            this.scoreChunkTokenOverlap(a, queryTokens) || a.chunk_index - b.chunk_index,
      )[0];
      out.push({
        filePath: representative.file_path,
        chunkIndex: representative.chunk_index,
        score: match.score,
        source: 'path',
        record: { ...representative, _distance: 0 },
        _rank: out.length,
      });
    }
    return out;
  }

  /** Exact definition recall backed by the Tree-sitter symbol index. */
  private async exactSymbolRetrieve(
    query: string,
    identifierOverride?: string[],
  ): Promise<ScoredChunk[]> {
    if (!this.db || !this.vectorStore) return [];
    const identifiers = identifierOverride ?? this.extractExactSymbolTerms(query);
    if (identifiers.length === 0) return [];

    const occurrences = searchSymbolOccurrences(this.db, identifiers, this.config.exactTopK);
    if (occurrences.length === 0) return [];

    const chunksByFile = await this.vectorStore.getFilesChunks(
      Array.from(new Set(occurrences.map((item) => item.filePath))),
    );
    const results: Array<ScoredChunk & { _rank: number }> = [];
    const seen = new Set<string>();
    for (const occurrence of occurrences) {
      const key = `${occurrence.filePath}#${occurrence.chunkIndex}`;
      if (seen.has(key)) continue;
      const chunk = chunksByFile
        .get(occurrence.filePath)
        ?.find((candidate) => candidate.chunk_index === occurrence.chunkIndex);
      if (!chunk) continue;
      seen.add(key);
      results.push({
        filePath: occurrence.filePath,
        chunkIndex: occurrence.chunkIndex,
        score: 1,
        source: 'exact',
        record: { ...chunk, _distance: 0 },
        _rank: results.length,
      });
      if (results.length >= this.config.exactTopK) break;
    }
    return results;
  }

  /**
   * 词法召回（FTS）
   *
   * 优先使用 chunk 级 FTS（更精准）
   * 如果 chunks_fts 不可用，降级到文件级 FTS + overlap 下钻
   */
  private async lexicalRetrieve(query: string): Promise<ScoredChunk[]> {
    if (!this.db || !this.vectorStore) return [];

    // 优先尝试 chunk 级 FTS（更精准）
    if (isChunksFtsInitialized(this.db)) {
      return this.lexicalRetrieveFromChunksFts(query);
    }

    // 降级到文件级 FTS + overlap 下钻
    if (isFtsInitialized(this.db)) {
      return this.lexicalRetrieveFromFilesFts(query);
    }

    logger.debug('FTS 未初始化，跳过词法召回');
    return [];
  }

  /**
   * 从 chunks_fts 直接搜索（最优方案）
   */
  private async lexicalRetrieveFromChunksFts(query: string): Promise<ScoredChunk[]> {
    // db 在 init() 中已初始化
    const chunkResults = searchChunksFts(
      this.db as Database.Database,
      query,
      this.config.lexTotalChunks,
    );

    if (chunkResults.length === 0) {
      logger.debug('Chunk FTS 无命中');
      return [];
    }

    // 将 FTS 结果转换为 ScoredChunk，需要从 VectorStore 获取完整的 ChunkRecord
    const allChunks: ScoredChunk[] = [];

    // 按文件分组获取 chunks
    const fileChunksMap = new Map<string, Map<number, number>>(); // filePath -> (chunkIndex -> score)
    for (const result of chunkResults) {
      if (!fileChunksMap.has(result.filePath)) {
        fileChunksMap.set(result.filePath, new Map());
      }
      fileChunksMap.get(result.filePath)?.set(result.chunkIndex, result.score);
    }

    // 从 VectorStore 批量获取完整的 chunk 信息（性能优化：N 次查询 → 1 次）
    const allFilePaths = Array.from(fileChunksMap.keys());
    const chunksMap = await this.vectorStore?.getFilesChunks(allFilePaths);
    if (!chunksMap) return allChunks;

    for (const [filePath, chunkScores] of fileChunksMap) {
      const chunks = chunksMap.get(filePath) ?? [];

      for (const chunk of chunks) {
        const score = chunkScores.get(chunk.chunk_index);
        if (score !== undefined) {
          allChunks.push({
            filePath: chunk.file_path,
            chunkIndex: chunk.chunk_index,
            score,
            source: 'lexical' as const,
            record: { ...chunk, _distance: 0 },
          });
        }
      }
    }

    logger.debug(
      {
        totalChunks: allChunks.length,
        filesWithChunks: fileChunksMap.size,
      },
      'Chunk FTS 召回完成',
    );

    // 按 score 排序并分配 rank
    return allChunks
      .sort((a, b) => b.score - a.score)
      .map((chunk, rank) => ({ ...chunk, _rank: rank }));
  }

  /**
   * 从 files_fts 搜索 + overlap 下钻（降级方案）
   */
  private async lexicalRetrieveFromFilesFts(query: string): Promise<ScoredChunk[]> {
    // 1. FTS 搜索文件
    // db 在 init() 中已初始化
    const fileResults = searchFilesFts(
      this.db as Database.Database,
      query,
      this.config.ftsTopKFiles,
    );
    if (fileResults.length === 0) {
      logger.debug('FTS 无命中文件');
      return [];
    }

    // 2. 提取查询 tokens（用于 chunk 级别打分）
    const queryTokens = this.extractQueryTokens(query);
    logger.debug(
      {
        fileCount: fileResults.length,
        queryTokens: Array.from(queryTokens).slice(0, 10),
      },
      'FTS 召回开始 chunk 选择',
    );

    // 3. 从 VectorStore 获取每个文件的 chunks，使用 token overlap 打分
    const allChunks: ScoredChunk[] = [];
    let totalChunks = 0;
    let skippedFiles = 0;
    const chunksByFile = await this.vectorStore?.getFilesChunks(fileResults.map((r) => r.path));

    for (const { path: filePath, score: fileScore } of fileResults) {
      if (totalChunks >= this.config.lexTotalChunks) break;

      const chunks = chunksByFile?.get(filePath);
      if (!chunks || chunks.length === 0) continue;

      // 对每个 chunk 计算 token overlap 得分
      const scoredChunks = chunks.map((chunk) => ({
        chunk,
        overlapScore: this.scoreChunkTokenOverlap(chunk, queryTokens),
      }));

      // 阈值过滤：如果文件内所有 chunk 的 maxOverlap == 0，跳过该文件
      // 避免引入无关 chunk 噪声
      const maxOverlap = Math.max(...scoredChunks.map((c) => c.overlapScore));
      if (maxOverlap === 0) {
        skippedFiles++;
        continue;
      }

      // 按 overlap 得分降序排序，取 topK（只取 overlapScore > 0 的）
      const topChunks = scoredChunks
        .filter((c) => c.overlapScore > 0)
        .sort((a, b) => b.overlapScore - a.overlapScore)
        .slice(0, this.config.lexChunksPerFile);

      for (const { chunk, overlapScore } of topChunks) {
        if (totalChunks >= this.config.lexTotalChunks) break;

        // 综合得分 = 文件级 BM25 分数 * (1 + chunk 级 overlap 加成)
        const combinedScore = fileScore * (1 + overlapScore * 0.5);

        allChunks.push({
          filePath: chunk.file_path,
          chunkIndex: chunk.chunk_index,
          score: combinedScore,
          source: 'lexical' as const,
          record: { ...chunk, _distance: 0 },
        });
        totalChunks++;
      }
    }

    if (skippedFiles > 0) {
      logger.debug({ skippedFiles }, 'FTS 跳过 overlap=0 的文件');
    }

    logger.debug(
      {
        totalChunks: allChunks.length,
        filesWithChunks: new Set(allChunks.map((c) => c.filePath)).size,
      },
      'FTS chunk 选择完成',
    );

    // 按 score 排序并分配 rank
    return allChunks
      .sort((a, b) => b.score - a.score)
      .map((chunk, rank) => ({ ...chunk, _rank: rank }));
  }

  private extractExactSymbolTerms(query: string): string[] {
    const matches = query.match(/[$_\p{L}][$_\p{L}\p{N}]*/gu) ?? [];
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      if (match.length < 2 || seen.has(match)) continue;
      seen.add(match);
      unique.push(match);
      if (unique.length >= 32) break;
    }
    return unique;
  }

  /** Resolve the semantic target of a reference query from symbols that actually exist. */
  private resolveGraphAnchorTerms(query: string): string[] {
    if (!this.db) return [];
    const identifiers = this.extractExactSymbolTerms(query);
    const existing = findExistingSymbolIdentifiers(this.db, identifiers);
    if (existing.length === 0) return [];
    const existingSet = new Set(existing);
    const identifier = '([$_\\p{L}][$_\\p{L}\\p{N}]*)';

    // Prefer the symbol syntactically attached to the reference/call cue. This avoids the old
    // longest-name failure: "who calls scan in Indexer" must anchor scan, not Indexer.
    const targetPatterns = [
      new RegExp(`\\bwho\\s+(?:calls?|uses?|references?|imports?)\\s+${identifier}`, 'iu'),
      new RegExp(`\\b(?:calls?|uses?|references?|imports?)\\s+${identifier}`, 'iu'),
      new RegExp(`(?:调用了?|使用了?|引用了?|导入了?|复用了?)\\s*${identifier}`, 'u'),
      new RegExp(
        `\\bwhere\\s+(?:is|are)\\s+${identifier}\\s+(?:used|called|referenced|imported)`,
        'iu',
      ),
      new RegExp(
        `${identifier}\\s+(?:在[^?？]{0,24})?被[^?？]{0,24}(?:调用|使用|用于|引用|导入)`,
        'u',
      ),
    ];
    for (const pattern of targetPatterns) {
      const match = query.match(pattern);
      const candidate = match?.[1];
      if (candidate && existingSet.has(candidate)) return [candidate];
    }

    // Fallback: nearest real symbol to an action cue; do not infer from identifier length.
    const cueMatches = Array.from(
      query.matchAll(
        /calls?|uses?|references?|imports?|used|called|调用了?|使用了?|引用了?|导入了?|复用了?|用于/giu,
      ),
    );
    const queryOrder = new Map(identifiers.map((item, index) => [item, index]));
    const score = (item: string): number => {
      const position = query.indexOf(item);
      if (position < 0 || cueMatches.length === 0) return 10_000 + (queryOrder.get(item) ?? 999);
      return Math.min(
        ...cueMatches.map((cue) => {
          const cueStart = cue.index ?? 0;
          const cueEnd = cueStart + cue[0].length;
          if (position >= cueEnd) return position - cueEnd;
          return 100 + Math.max(0, cueStart - (position + item.length));
        }),
      );
    };
    return [...existing]
      .sort(
        (a, b) => score(a) - score(b) || (queryOrder.get(a) ?? 999) - (queryOrder.get(b) ?? 999),
      )
      .slice(0, 1);
  }

  /**
   * 提取查询中的 tokens
   *
   * 直接复用 fts.ts 中的 segmentQuery，确保召回和评分逻辑一致
   */
  private extractQueryTokens(query: string): Set<string> {
    const tokens = segmentQuery(query);
    return new Set(tokens);
  }

  /**
   * 计算 chunk 与查询的 token overlap 得分
   *
   * 匹配策略：
   * - breadcrumb 和 display_code 都参与匹配
   * - 精确匹配得 1 分，子串匹配得 0.5 分
   */
  private scoreChunkTokenOverlap(
    chunk: { breadcrumb: string; display_code: string },
    queryTokens: Set<string>,
  ): number {
    const text = `${chunk.breadcrumb} ${chunk.display_code}`.toLowerCase();
    let score = 0;

    for (const token of queryTokens) {
      // 性能优化：先用 includes 快速判断，再用预编译的 RegExp 判断边界
      if (text.includes(token)) {
        // 精确匹配（作为完整单词）得更高分
        const regex = getTokenBoundaryRegex(token);
        if (regex.test(text)) {
          score += 1;
        } else {
          score += 0.5; // 子串匹配
        }
      }
    }

    return score;
  }

  // =========================================
  // 融合方法
  // =========================================

  /**
   * RRF (Reciprocal Rank Fusion) 融合
   *
   * 公式: score = Σ w_i / (k + rank_i)
   * 其中 k 是平滑常数，rank 从 0 开始
   */
  private fuse(
    vectorResults: (ScoredChunk & { _rank?: number })[],
    lexicalResults: (ScoredChunk & { _rank?: number })[],
    exactResults: (ScoredChunk & { _rank?: number })[] = [],
    pathResults: (ScoredChunk & { _rank?: number })[] = [],
  ): ScoredChunk[] {
    const { rrfK0, wVec, wLex, wExact, wPath } = this.config;
    const fusedScores = new Map<
      string,
      { score: number; chunk: ScoredChunk; sources: Set<string> }
    >();
    const getKey = (chunk: ScoredChunk) => `${chunk.filePath}#${chunk.chunkIndex}`;

    const addChannel = (
      results: (ScoredChunk & { _rank?: number })[],
      weight: number,
      source: 'vector' | 'lexical' | 'exact' | 'path',
    ): void => {
      for (const result of results) {
        const key = getKey(result);
        const rank = result._rank ?? 0;
        const rrfScore = weight / (rrfK0 + rank);
        const existing = fusedScores.get(key);
        if (existing) {
          existing.score += rrfScore;
          existing.sources.add(source);
        } else {
          fusedScores.set(key, {
            score: rrfScore,
            chunk: result,
            sources: new Set([source]),
          });
        }
      }
    };

    addChannel(vectorResults, wVec, 'vector');
    addChannel(lexicalResults, wLex, 'lexical');
    addChannel(exactResults, wExact, 'exact');
    addChannel(pathResults, wPath, 'path');

    const fused = Array.from(fusedScores.values())
      .map(({ score, chunk }) => ({ ...chunk, score }))
      .sort((a, b) => b.score - a.score);

    if (isDebugEnabled()) {
      logger.debug(
        {
          vectorCount: vectorResults.length,
          lexicalCount: lexicalResults.length,
          exactCount: exactResults.length,
          pathCount: pathResults.length,
          fusedCount: fused.length,
          multiSource: Array.from(fusedScores.values()).filter((item) => item.sources.size > 1)
            .length,
        },
        'RRF 融合完成',
      );
    }
    return fused;
  }

  // Rerank 方法

  /**
   * Rerank
   */
  private async rerank(query: string, candidates: ScoredChunk[]): Promise<ScoredChunk[]> {
    if (candidates.length === 0) return [];

    const reranker = getRerankerClient();
    const queryTokens = this.extractQueryTokens(query);

    // 构造 rerank 文本：围绕命中行截取，而非头尾截断
    const textExtractor = (chunk: ScoredChunk): string => {
      const bc = this.truncateMiddle(chunk.record.breadcrumb, this.config.maxBreadcrumbChars);
      const budget = Math.max(0, this.config.maxRerankChars - bc.length - 1);
      const code = this.extractAroundHit(chunk.record.display_code, queryTokens, budget);
      return `${bc}\n${code}`;
    };

    const reranked = await reranker.rerankWithData(query, candidates, textExtractor, {
      topN: this.config.rerankTopN,
    });

    return reranked
      .filter((r) => r.data !== undefined)
      .map((r) => ({
        ...(r.data as ScoredChunk),
        score: r.score,
      }));
  }

  // Smart TopK Cutoff

  /**
   * 智能截断策略（Anchor & Floor + Safe Harbor + Delta Guard）
   *
   * 核心逻辑：
   * 1. 低置信保护：窄查询返回 top1；宽查询保留 RetrievalPlan 要求的不同文件数
   * 2. 动态阈值：max(floor, min(ratioThreshold, deltaThreshold))
   * 3. Safe Harbor：前 minK 个只检查 floor，不检查 ratio/delta
   * 4. 去重 + 补齐：cutoff 后去重，不足 minK 时从后续补齐
   */
  private applySmartCutoff(candidates: ScoredChunk[], plan: RetrievalPlan): ScoredChunk[] {
    // 未启用时直接返回原列表
    if (!this.config.enableSmartTopK) {
      return candidates;
    }

    if (candidates.length === 0) return [];

    // 防御：确保降序排列
    const sorted = candidates.slice().sort((a, b) => b.score - a.score);

    const {
      smartTopScoreRatio: ratio,
      smartTopScoreDeltaAbs: deltaAbs,
      smartMinScore: floor,
      smartMinK: minK,
      smartMaxK: configuredMaxK,
    } = this.config;
    const maxK = Math.max(1, Math.min(configuredMaxK, plan.maxSeeds));
    const minSeedFiles = Math.max(1, Math.min(plan.minSeedFiles, maxK));

    const topScore = sorted[0].score;

    // 对窄查询保留原来的低置信降级；宽查询则至少保住若干不同文件，
    // 避免 reranker 绝对分偏低时把 overview/call-chain/compound 直接塌缩成 top1。
    // 次级门槛 floor*ratio：候选连这道线都过不了说明整体是垃圾分数，不再硬凑文件。
    if (topScore < floor) {
      const secondaryFloor = floor * ratio;
      const eligible = sorted.filter((chunk) => chunk.score >= secondaryFloor);
      const lowConfidenceSeeds = this.ensureMinSeedFiles([sorted[0]], eligible, minSeedFiles, maxK);
      logger.debug(
        { topScore, floor, secondaryFloor, minSeedFiles, pickedCount: lowConfidenceSeeds.length },
        'SmartTopK: Top1 below floor, applying file-diversity safe harbor',
      );
      return lowConfidenceSeeds;
    }

    // 动态阈值计算（ratio + deltaAbs 护栏）
    const ratioThreshold = topScore * ratio;
    const deltaThreshold = topScore - deltaAbs;
    const dynamicThreshold = Math.max(floor, Math.min(ratioThreshold, deltaThreshold));

    const picked: ScoredChunk[] = [];

    for (let i = 0; i < sorted.length; i++) {
      if (picked.length >= maxK) break;

      const chunk = sorted[i];

      // Safe Harbor：前 minK 只看 floor
      if (i < minK) {
        if (chunk.score >= floor) {
          picked.push(chunk);
          continue;
        }
        // 保护区都过不了 floor，后面更差，直接结束
        logger.debug(
          { rank: i, score: chunk.score, floor },
          'SmartTopK: Safe harbor chunk below floor, breaking',
        );
        break;
      }

      // 保护区外：必须过动态阈值
      if (chunk.score < dynamicThreshold) {
        logger.debug(
          {
            rank: i,
            score: chunk.score,
            dynamicThreshold,
            topScore,
            ratioThreshold,
            deltaThreshold,
          },
          'SmartTopK: cutoff at dynamic threshold',
        );
        break;
      }

      picked.push(chunk);
    }

    // 去重（按 file_path + chunk_index）
    const deduped = this.dedupChunks(picked);

    // 去重后不足 minK，从后续 candidates 补齐（仅补 floor 以上）
    if (deduped.length < Math.min(minK, maxK)) {
      const seen = new Set(deduped.map((c) => this.chunkKey(c)));
      for (const c of sorted) {
        if (deduped.length >= Math.min(minK, maxK)) break;
        if (c.score < floor) break;
        const key = this.chunkKey(c);
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(c);
        }
      }
    }

    // 文件多样性补齐只能从 floor 以上的候选里选：
    // 低于绝对置信度的候选是垃圾分数，不能为凑文件数捞回来。
    const diversified = this.ensureMinSeedFiles(
      deduped,
      sorted.filter((chunk) => chunk.score >= floor),
      minSeedFiles,
      maxK,
    );

    logger.debug(
      {
        originalCount: candidates.length,
        pickedCount: picked.length,
        finalCount: diversified.length,
        finalFiles: new Set(diversified.map((chunk) => chunk.filePath)).size,
        minSeedFiles,
        topScore,
        floor,
        ratio,
        deltaAbs,
        ratioThreshold: ratioThreshold.toFixed(3),
        deltaThreshold: deltaThreshold.toFixed(3),
        dynamicThreshold: dynamicThreshold.toFixed(3),
      },
      'SmartTopK: done',
    );

    return diversified;
  }

  private ensureMinSeedFiles(
    selected: ScoredChunk[],
    ranked: ScoredChunk[],
    minSeedFiles: number,
    maxK: number,
  ): ScoredChunk[] {
    const result = this.dedupChunks(selected).slice(0, maxK);
    const seenChunks = new Set(result.map((chunk) => this.chunkKey(chunk)));
    const fileCounts = new Map<string, number>();
    for (const chunk of result) {
      fileCounts.set(chunk.filePath, (fileCounts.get(chunk.filePath) ?? 0) + 1);
    }

    for (const candidate of ranked) {
      if (fileCounts.size >= minSeedFiles) break;
      if (fileCounts.has(candidate.filePath)) continue;
      if (seenChunks.has(this.chunkKey(candidate))) continue;

      if (result.length >= maxK) {
        let replaceIndex = -1;
        for (let index = result.length - 1; index >= 0; index--) {
          const existing = result[index];
          if ((fileCounts.get(existing.filePath) ?? 0) > 1) {
            replaceIndex = index;
            break;
          }
        }
        if (replaceIndex < 0) break;

        const removed = result.splice(replaceIndex, 1)[0];
        seenChunks.delete(this.chunkKey(removed));
        const remaining = (fileCounts.get(removed.filePath) ?? 1) - 1;
        if (remaining <= 0) fileCounts.delete(removed.filePath);
        else fileCounts.set(removed.filePath, remaining);
      }

      result.push(candidate);
      seenChunks.add(this.chunkKey(candidate));
      fileCounts.set(candidate.filePath, 1);
    }

    return result.sort((a, b) => b.score - a.score);
  }

  /**
   * 生成 chunk 唯一键（用于去重）
   */
  private chunkKey(chunk: ScoredChunk): string {
    return `${chunk.filePath}#${chunk.chunkIndex}`;
  }

  /**
   * 按 file_path + chunk_index 去重
   */
  private dedupChunks(list: ScoredChunk[]): ScoredChunk[] {
    const seen = new Set<string>();
    const out: ScoredChunk[] = [];
    for (const c of list) {
      const k = this.chunkKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }

  // 扩展方法

  /**
   * 扩展 seed chunks
   *
   * 使用 GraphExpander 执行三种扩展策略：
   * - E1: 同文件邻居
   * - E2: breadcrumb 补段
   * - E3: 相对路径 import 解析
   */
  private async expand(
    seeds: ScoredChunk[],
    queryTokens?: Set<string>,
    plan = buildRetrievalPlan(''),
    dependencySeeds?: ScoredChunk[],
  ): Promise<ScoredChunk[]> {
    if (seeds.length === 0) return [];

    const expander = await getGraphExpander(this.projectId, this.config);
    const { chunks, stats } = await expander.expand(seeds, queryTokens, {
      expandNeighbors: plan.expandNeighbors,
      expandDependencies: plan.expandDependencies,
      dependencyDirection: plan.dependencyDirection,
      dependencySeeds,
      maxDependencyDepth: plan.dependencyMaxDepth,
      maxDependencyFiles: plan.dependencyMaxFiles,
      dependencyChunksPerFile: plan.dependencyChunksPerFile,
      dependencyDecay: plan.dependencyDecay,
    });

    logger.debug(stats, '上下文扩展统计');

    return chunks;
  }

  // 工具方法

  /**
   * 中间省略截断（保留首尾）
   */
  private truncateMiddle(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    const half = Math.floor((maxLen - 3) / 2);
    return `${text.slice(0, half)}...${text.slice(-half)}`;
  }

  /**
   * 头尾截断（备用方法，当无命中行时使用）
   */
  private truncateHeadTail(text: string, maxLen: number, headRatio: number): string {
    if (text.length <= maxLen) return text;
    const headLen = Math.floor(maxLen * headRatio);
    const tailLen = maxLen - headLen - 3; // "..."
    if (tailLen <= 0) return text.slice(0, maxLen);
    return `${text.slice(0, headLen)}...${text.slice(-tailLen)}`;
  }

  /**
   * 围绕命中行截取
   *
   * 找到第一个包含 query token 的行，截取其上下文
   * 如果没有命中，降级为头尾截断
   */
  private extractAroundHit(text: string, queryTokens: Set<string>, maxLen: number): string {
    if (text.length <= maxLen) return text;

    const lines = text.split('\n');
    const _textLower = text.toLowerCase();

    // 找命中行（包含任意 query token 的行）
    let hitLineIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      let lineScore = 0;
      for (const token of queryTokens) {
        if (lineLower.includes(token)) {
          lineScore++;
        }
      }
      // 选择命中 token 最多的行
      if (lineScore > bestScore) {
        bestScore = lineScore;
        hitLineIdx = i;
      }
    }

    // 无命中，降级为头尾截断
    if (hitLineIdx === -1) {
      return this.truncateHeadTail(text, maxLen, this.config.headRatio);
    }

    // 以命中行为中心，向上下扩展
    let start = hitLineIdx;
    let end = hitLineIdx;
    let currentLen = lines[hitLineIdx].length;

    // 交替向上、向下扩展
    while (currentLen < maxLen) {
      const canUp = start > 0;
      const canDown = end < lines.length - 1;

      if (!canUp && !canDown) break;

      // 先向上
      if (canUp) {
        const upLen = lines[start - 1].length + 1; // +1 for newline
        if (currentLen + upLen <= maxLen) {
          start--;
          currentLen += upLen;
        }
      }

      // 再向下
      if (canDown) {
        const downLen = lines[end + 1].length + 1;
        if (currentLen + downLen <= maxLen) {
          end++;
          currentLen += downLen;
        }
      }

      // 如果两边都无法扩展了，退出
      if (
        (start === 0 || lines[start - 1].length + 1 + currentLen > maxLen) &&
        (end === lines.length - 1 || lines[end + 1].length + 1 + currentLen > maxLen)
      ) {
        break;
      }
    }

    // 构造结果
    const result = lines.slice(start, end + 1).join('\n');
    const prefix = start > 0 ? '...' : '';
    const suffix = end < lines.length - 1 ? '...' : '';

    return this.truncateHeadTail(prefix + result + suffix, maxLen, this.config.headRatio);
  }

  /**
   * 获取当前配置
   */
  getConfig(): SearchConfig {
    return { ...this.config };
  }
}
