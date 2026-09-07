import '../../src/config.js';

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProgressBar, Spinner } from '../../src/cli/progress.js';
import {
  checkEmbeddingEnv,
  checkRerankerEnv,
  getEmbeddingConfig,
  getRerankerConfig,
} from '../../src/config.js';
import { closeDb, getAllFileMeta, initDb } from '../../src/db/index.js';
import { closeIndexer } from '../../src/indexer/index.js';
import { scan } from '../../src/scanner/index.js';
import { DEFAULT_CONFIG } from '../../src/search/config.js';
import { SearchService } from '../../src/search/SearchService.js';
import { setConsoleVerbose } from '../../src/utils/logger.js';
import { closeVectorStore } from '../../src/vectorStore/index.js';
import { getBenchmarkIndexIdentity } from './indexIdentity.js';
import {
  type BenchmarkSummary,
  evaluateRanking,
  type RetrievalCase,
  type RetrievalCategory,
  summarize,
} from './metrics.js';

interface BenchmarkCaseResult {
  id: string;
  category: RetrievalCategory;
  query: string;
  relevantFiles: string[];
  rankedFiles: string[];
  metrics: ReturnType<typeof evaluateRanking>;
  timingMs: {
    retrieve?: number;
    rerank?: number;
    total: number;
  };
  stages: {
    retrieval?: NonNullable<import('../../src/search/types.js').ContextPack['debug']>['retrieval'];
    graphAnchorTerms?: string[];
    seeds: Array<{
      filePath: string;
      chunkIndex: number;
      score: number;
      source: string;
    }>;
    expanded: Array<{
      filePath: string;
      chunkIndex: number;
      score: number;
      source: string;
    }>;
    files: Array<{
      filePath: string;
      segments: number;
      chars: number;
    }>;
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

interface BenchmarkOutput {
  schemaVersion: 3;
  generatedAt: string;
  repoName: string;
  git: {
    commit: string | null;
    dirty: boolean | null;
    dirtyFiles: string[] | null;
  };
  models: {
    embedding: {
      provider: string;
      model: string;
      dimensions: number;
      maxConcurrency: number;
      maxInputChars: number;
      maxBatchChars: number;
      autoSplitLongText: boolean;
      endpoint?: string;
      repo?: string;
      revision?: string;
      dtype?: string;
      maxContextTokens?: number;
      pooling?: string;
      documentInputSpaceVersion?: string;
    };
    reranker: {
      model: string;
      topN: number;
      endpoint: string;
    };
  };
  fingerprints: {
    corpus: string;
    cases: string;
    searchConfig: string;
    corpusRules: string;
    modelConfig: string;
    index: string;
  };
  corpus: {
    projectId: string;
    indexKey: string;
    indexFingerprint: string;
    fileCount: number;
    excludedPatterns: string[];
  };
  searchConfig: typeof DEFAULT_CONFIG;
  runtime: {
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    osRelease: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryBytes: number;
  };
  run: {
    startedAt: string;
    finishedAt: string;
    totalDurationMs: number;
    index: {
      mode: 'refreshed' | 'reused';
      durationMs: number;
    };
    queriesDurationMs: number;
  };
  casesFile: string;
  summary: BenchmarkSummary;
  byCategory: Partial<Record<RetrievalCategory, BenchmarkSummary>>;
  results: BenchmarkCaseResult[];
}

interface CliOptions {
  repoPath: string;
  casesPath: string;
  outputPath: string;
  noIndex: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultCasesPath = path.join(here, 'cases.json');
const defaultOutputPath = path.join(here, 'results', 'latest.json');
const BENCHMARK_EXCLUDE_PATTERNS = ['tests/', 'test/', '__tests__/'];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function corpusSnapshot(projectId: string): { fingerprint: string; fileCount: number } {
  const db = initDb(projectId);
  try {
    const rows = Array.from(
      getAllFileMeta(db),
      ([filePath, meta]) => `${filePath}\0${meta.hash}`,
    ).sort();
    return {
      fingerprint: sha256(rows.join('\n')),
      fileCount: rows.length,
    };
  } finally {
    closeDb(db);
  }
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseOptions(args: string[]): CliOptions {
  return {
    repoPath: path.resolve(readArg(args, '--repo') ?? process.cwd()),
    casesPath: path.resolve(readArg(args, '--cases') ?? defaultCasesPath),
    outputPath: path.resolve(readArg(args, '--output') ?? defaultOutputPath),
    noIndex: args.includes('--no-index'),
  };
}

function isRetrievalCategory(value: unknown): value is RetrievalCategory {
  return ['symbol', 'feature', 'path', 'reference', 'call-chain', 'overview', 'compound'].includes(
    String(value),
  );
}

async function loadCases(casesPath: string, repoPath: string): Promise<RetrievalCase[]> {
  const raw = JSON.parse(await fsPromises.readFile(casesPath, 'utf8')) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Benchmark cases must be a non-empty JSON array');
  }

  const seenIds = new Set<string>();
  const cases: RetrievalCase[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('Invalid benchmark case');
    const candidate = item as Partial<RetrievalCase>;
    if (!candidate.id || seenIds.has(candidate.id)) {
      throw new Error(`Benchmark case id is missing or duplicated: ${candidate.id ?? '<missing>'}`);
    }
    if (!isRetrievalCategory(candidate.category)) {
      throw new Error(`Unknown category for ${candidate.id}: ${candidate.category ?? '<missing>'}`);
    }
    if (!candidate.informationRequest?.trim()) {
      throw new Error(`Missing informationRequest for ${candidate.id}`);
    }
    if (!Array.isArray(candidate.relevantFiles) || candidate.relevantFiles.length === 0) {
      throw new Error(`Missing relevantFiles for ${candidate.id}`);
    }
    if (
      candidate.technicalTerms &&
      !candidate.technicalTerms.every((term) => typeof term === 'string')
    ) {
      throw new Error(`technicalTerms must be strings for ${candidate.id}`);
    }

    for (const relevantFile of candidate.relevantFiles) {
      const absolutePath = path.join(repoPath, relevantFile);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Relevant file does not exist for ${candidate.id}: ${relevantFile}`);
      }
    }

    seenIds.add(candidate.id);
    cases.push(candidate as RetrievalCase);
  }

  return cases;
}

function gitMetadata(repoPath: string): BenchmarkOutput['git'] {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd();
    const dirtyFiles = status
      ? status
          .split('\n')
          .map((line) => line.slice(3).trim())
          .filter(Boolean)
          .sort()
      : [];
    return { commit, dirty: dirtyFiles.length > 0, dirtyFiles };
  } catch {
    return { commit: null, dirty: null, dirtyFiles: null };
  }
}

function sanitizedEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '<configured>';
  }
}

function runtimeMetadata(): BenchmarkOutput['runtime'] {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

function printSummary(summary: BenchmarkSummary): void {
  console.log('\nRetrieval Benchmark');
  console.log('────────────────────────────────');
  console.log(`Cases:               ${summary.cases}`);
  console.log(`Top1 File Accuracy:  ${pct(summary.top1FileAccuracy)}`);
  console.log(`Recall@5:            ${pct(summary.recallAt5)}`);
  console.log(`Recall@10:           ${pct(summary.recallAt10)}`);
  console.log(`MRR:                 ${summary.mrr.toFixed(3)}`);
  console.log(`Relevant Coverage:   ${pct(summary.relevantFileCoverage)}`);
  console.log(`Avg Unique Files:    ${summary.avgUniqueFiles.toFixed(1)}`);
  console.log(`Avg Returned Chars:  ${Math.round(summary.avgReturnedChars)}`);
  console.log(`Retrieve p50:        ${formatMs(summary.latencyMs.retrieve.p50Ms)}`);
  console.log(`Rerank p50:          ${formatMs(summary.latencyMs.rerank.p50Ms)}`);
  console.log(`Total p50:           ${formatMs(summary.latencyMs.total.p50Ms)}`);
}

function printCategorySummary(
  byCategory: Partial<Record<RetrievalCategory, BenchmarkSummary>>,
): void {
  console.log('\nBy category');
  console.log('category     cases   top1    r@5     r@10    mrr    coverage');
  for (const [category, summary] of Object.entries(byCategory)) {
    console.log(
      `${category.padEnd(12)} ${String(summary.cases).padStart(5)}   ${pct(summary.top1FileAccuracy).padStart(6)}  ${pct(summary.recallAt5).padStart(6)}  ${pct(summary.recallAt10).padStart(6)}  ${summary.mrr.toFixed(2).padStart(5)}  ${pct(summary.relevantFileCoverage).padStart(8)}`,
    );
  }
}

async function ensureIndex(repoPath: string, projectId: string): Promise<void> {
  const spinner = new Spinner();
  const bar = new ProgressBar();
  let barStarted = false;

  setConsoleVerbose(false);
  spinner.start('正在扫描并建立 Benchmark 索引');

  try {
    const stats = await scan(repoPath, {
      projectId,
      extraExcludePatterns: BENCHMARK_EXCLUDE_PATTERNS,
      onProgress: (current, total, message) => {
        if (!barStarted) {
          // 空仓库首个回调可能直接是 100%，避免闪现进度条。
          if (total !== undefined && current >= total) return;
          spinner.stop();
          bar.start();
          barStarted = true;
        }
        bar.update(current, total ?? 100, message);
      },
    });

    if (barStarted) {
      spinner.stop();
      bar.done('');
    } else {
      // 全程无 <100% 回调（空仓库）：spinner 保持到结束，兜底输出完成行
      spinner.stop('扫描完成');
    }
    const errors = stats.errors + (stats.vectorIndex?.errors ?? 0);
    if (errors > 0) {
      throw new Error(`Index refresh completed with ${errors} error(s)`);
    }
  } catch (error) {
    if (barStarted) {
      bar.fail('Benchmark 索引失败');
    } else {
      spinner.fail('Benchmark 索引失败');
    }
    throw error;
  } finally {
    setConsoleVerbose(true);
  }
}

async function main(): Promise<void> {
  const runStartedAt = new Date();
  const runStarted = performance.now();
  const options = parseOptions(process.argv.slice(2));
  const cases = await loadCases(options.casesPath, options.repoPath);
  const missingVars = [...checkEmbeddingEnv().missingVars, ...checkRerankerEnv().missingVars];
  if (missingVars.length > 0) {
    throw new Error(`Missing retrieval environment variables: ${missingVars.join(', ')}`);
  }
  const embedding = getEmbeddingConfig();
  const reranker = getRerankerConfig();
  const indexIdentity = getBenchmarkIndexIdentity(options.repoPath, embedding);
  const projectId = indexIdentity.projectId;
  const modelConfig: BenchmarkOutput['models'] = {
    embedding: {
      provider: embedding.provider,
      model: embedding.model,
      dimensions: embedding.dimensions,
      maxConcurrency: embedding.maxConcurrency,
      maxInputChars: embedding.maxInputChars,
      maxBatchChars: embedding.maxBatchChars,
      autoSplitLongText: embedding.autoSplitLongText,
      ...(embedding.provider === 'local'
        ? {
            repo: embedding.repo,
            revision: embedding.revision,
            dtype: embedding.dtype,
            maxContextTokens: embedding.maxContextTokens,
            pooling: embedding.pooling,
            documentInputSpaceVersion: embedding.documentInputSpaceVersion,
          }
        : { endpoint: sanitizedEndpoint(embedding.baseUrl) }),
    },
    reranker: {
      model: reranker.model,
      topN: reranker.topN,
      endpoint: sanitizedEndpoint(reranker.baseUrl),
    },
  };

  console.log(`Benchmark index: ${indexIdentity.key}`);
  const indexStarted = performance.now();
  if (!options.noIndex) {
    console.log('Refreshing isolated benchmark index (tests excluded)...');
    await ensureIndex(options.repoPath, projectId);
  } else {
    console.log('Reusing frozen benchmark index (--no-index)...');
  }
  const indexDurationMs = performance.now() - indexStarted;
  const corpus = corpusSnapshot(projectId);
  if (options.noIndex && corpus.fileCount === 0) {
    throw new Error(
      `No frozen benchmark index exists for ${indexIdentity.key}. Re-run without --no-index first.`,
    );
  }

  const fingerprints: BenchmarkOutput['fingerprints'] = {
    corpus: corpus.fingerprint,
    cases: sha256(await fsPromises.readFile(options.casesPath, 'utf8')),
    searchConfig: sha256(JSON.stringify(DEFAULT_CONFIG)),
    corpusRules: sha256(JSON.stringify(BENCHMARK_EXCLUDE_PATTERNS)),
    modelConfig: sha256(JSON.stringify(modelConfig)),
    index: indexIdentity.fingerprint,
  };

  const service = new SearchService(projectId, options.repoPath);
  await service.init();

  const results: BenchmarkCaseResult[] = [];
  const queriesStarted = performance.now();
  try {
    for (let index = 0; index < cases.length; index++) {
      const benchmarkCase = cases[index];
      const query = [benchmarkCase.informationRequest, ...(benchmarkCase.technicalTerms ?? [])]
        .filter(Boolean)
        .join(' ');
      process.stdout.write(
        `[${String(index + 1).padStart(2)}/${cases.length}] ${benchmarkCase.category.padEnd(10)} ${benchmarkCase.id} ... `,
      );

      const startedAt = performance.now();
      const contextPack = await service.buildContextPack(query);
      const totalMs = performance.now() - startedAt;
      const files = contextPack.files.map((file) => ({
        filePath: file.filePath,
        segments: file.segments.length,
        chars: file.segments.reduce((sum, segment) => sum + segment.text.length, 0),
      }));
      const returnedChars = files.reduce((sum, file) => sum + file.chars, 0);
      const metrics = evaluateRanking(
        benchmarkCase.relevantFiles,
        files.map((file) => file.filePath),
        returnedChars,
      );

      results.push({
        id: benchmarkCase.id,
        category: benchmarkCase.category,
        query,
        relevantFiles: benchmarkCase.relevantFiles,
        rankedFiles: files.map((file) => file.filePath),
        metrics,
        timingMs: {
          retrieve: contextPack.debug?.timingMs.retrieve,
          rerank: contextPack.debug?.timingMs.rerank,
          total: totalMs,
        },
        stages: {
          retrieval: contextPack.debug?.retrieval,
          graphAnchorTerms: contextPack.debug?.graphAnchorTerms,
          seeds: contextPack.seeds.map((chunk) => ({
            filePath: chunk.filePath,
            chunkIndex: chunk.chunkIndex,
            score: chunk.score,
            source: chunk.source,
          })),
          expanded: contextPack.expanded.map((chunk) => ({
            filePath: chunk.filePath,
            chunkIndex: chunk.chunkIndex,
            score: chunk.score,
            source: chunk.source,
          })),
          files,
          selection: contextPack.debug?.selection,
        },
      });

      console.log(
        `${metrics.top1FileHit ? 'top1' : metrics.recallAt10 ? 'hit' : 'miss'} (${Math.round(totalMs)} ms)`,
      );
    }
  } finally {
    closeIndexer(projectId);
    await closeVectorStore(projectId);
  }
  const queriesDurationMs = performance.now() - queriesStarted;

  const summary = summarize(results);
  const byCategory: Partial<Record<RetrievalCategory, BenchmarkSummary>> = {};
  for (const category of Array.from(
    new Set(cases.map((benchmarkCase) => benchmarkCase.category)),
  )) {
    byCategory[category] = summarize(results.filter((result) => result.category === category));
  }

  const finishedAt = new Date();
  const output: BenchmarkOutput = {
    schemaVersion: 3,
    generatedAt: finishedAt.toISOString(),
    repoName: path.basename(options.repoPath),
    git: gitMetadata(options.repoPath),
    models: modelConfig,
    fingerprints,
    corpus: {
      projectId,
      indexKey: indexIdentity.key,
      indexFingerprint: indexIdentity.fingerprint,
      fileCount: corpus.fileCount,
      excludedPatterns: BENCHMARK_EXCLUDE_PATTERNS,
    },
    searchConfig: DEFAULT_CONFIG,
    runtime: runtimeMetadata(),
    run: {
      startedAt: runStartedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      totalDurationMs: performance.now() - runStarted,
      index: {
        mode: options.noIndex ? 'reused' : 'refreshed',
        durationMs: indexDurationMs,
      },
      queriesDurationMs,
    },
    casesFile: path.relative(options.repoPath, options.casesPath).replace(/\\/g, '/'),
    summary,
    byCategory,
    results,
  };

  await fsPromises.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fsPromises.writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  printSummary(summary);
  printCategorySummary(byCategory);
  console.log(`\nSaved: ${options.outputPath}`);
}

main().catch((error) => {
  console.error(`Retrieval benchmark failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
