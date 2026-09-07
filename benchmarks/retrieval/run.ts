import '../../src/config.js';

import { execFileSync } from 'node:child_process';
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEmbeddingEnv, checkRerankerEnv } from '../../src/config.js';
import { generateProjectId } from '../../src/db/index.js';
import { closeIndexer } from '../../src/indexer/index.js';
import { scan } from '../../src/scanner/index.js';
import { SearchService } from '../../src/search/SearchService.js';
import { closeVectorStore } from '../../src/vectorStore/index.js';
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
  };
}

interface BenchmarkOutput {
  schemaVersion: 1;
  generatedAt: string;
  repoName: string;
  git: {
    commit: string | null;
    dirty: boolean | null;
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
const defaultOutputPath = path.join(here, 'results', 'baseline.json');

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
    const dirty =
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
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

async function ensureIndex(repoPath: string): Promise<void> {
  const stats = await scan(repoPath);
  const errors = stats.errors + (stats.vectorIndex?.errors ?? 0);
  if (errors > 0) {
    throw new Error(`Index refresh completed with ${errors} error(s)`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const cases = await loadCases(options.casesPath, options.repoPath);
  const missingVars = [...checkEmbeddingEnv().missingVars, ...checkRerankerEnv().missingVars];
  if (missingVars.length > 0) {
    throw new Error(`Missing retrieval environment variables: ${missingVars.join(', ')}`);
  }

  if (!options.noIndex) {
    console.log('Refreshing repository index...');
    await ensureIndex(options.repoPath);
  }

  const projectId = generateProjectId(options.repoPath);
  const service = new SearchService(projectId, options.repoPath);
  await service.init();

  const results: BenchmarkCaseResult[] = [];
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

  const summary = summarize(results);
  const byCategory: Partial<Record<RetrievalCategory, BenchmarkSummary>> = {};
  for (const category of Array.from(
    new Set(cases.map((benchmarkCase) => benchmarkCase.category)),
  )) {
    byCategory[category] = summarize(results.filter((result) => result.category === category));
  }

  const output: BenchmarkOutput = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repoName: path.basename(options.repoPath),
    git: gitMetadata(options.repoPath),
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
