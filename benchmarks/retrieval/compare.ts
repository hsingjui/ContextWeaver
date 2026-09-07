import { promises as fs } from 'node:fs';
import path from 'node:path';

interface Summary {
  cases: number;
  top1FileAccuracy: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  relevantFileCoverage: number;
  avgUniqueFiles: number;
  avgReturnedChars: number;
  latencyMs: {
    retrieve: { avgMs: number; p50Ms: number };
    rerank: { avgMs: number; p50Ms: number };
    total: { avgMs: number; p50Ms: number };
  };
}

interface BenchmarkOutput {
  schemaVersion?: number;
  repoName?: string;
  casesFile?: string;
  git?: {
    commit: string | null;
    dirty: boolean | null;
  };
  summary: Summary;
  byCategory: Record<string, Summary>;
  models?:
    | {
        embeddingProvider: string;
        embeddingModel: string;
        rerankerModel: string;
      }
    | {
        embedding: {
          provider: string;
          model: string;
        };
        reranker: {
          model: string;
        };
      };
  fingerprints?: {
    corpus: string;
    cases: string;
    searchConfig: string;
    corpusRules: string;
    modelConfig?: string;
    index?: string;
  };
  corpus?: {
    projectId?: string;
    indexKey?: string;
    indexFingerprint?: string;
    fileCount?: number;
  };
  runtime?: {
    platform: string;
    arch: string;
    nodeVersion: string;
    osRelease: string;
    cpuModel: string;
    cpuCount: number;
  };
  run?: {
    totalDurationMs: number;
    index: {
      mode: string;
      durationMs: number;
    };
    queriesDurationMs: number;
  };
}

function readArg(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function pct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}pp`;
}

function numeric(value: number, digits = 3): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

function integer(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${Math.round(value)}`;
}

function printSummaryDelta(baseline: Summary, candidate: Summary): void {
  console.log('metric                    baseline   candidate   delta');
  console.log(
    `Top1 file accuracy       ${(baseline.top1FileAccuracy * 100).toFixed(1).padStart(7)}%   ${(candidate.top1FileAccuracy * 100).toFixed(1).padStart(7)}%   ${pct(candidate.top1FileAccuracy - baseline.top1FileAccuracy)}`,
  );
  console.log(
    `MRR                      ${baseline.mrr.toFixed(3).padStart(8)}   ${candidate.mrr.toFixed(3).padStart(9)}   ${numeric(candidate.mrr - baseline.mrr)}`,
  );
  console.log(
    `Relevant file coverage   ${(baseline.relevantFileCoverage * 100).toFixed(1).padStart(7)}%   ${(candidate.relevantFileCoverage * 100).toFixed(1).padStart(7)}%   ${pct(candidate.relevantFileCoverage - baseline.relevantFileCoverage)}`,
  );
  console.log(
    `Avg unique files         ${baseline.avgUniqueFiles.toFixed(2).padStart(8)}   ${candidate.avgUniqueFiles.toFixed(2).padStart(9)}   ${numeric(candidate.avgUniqueFiles - baseline.avgUniqueFiles, 2)}`,
  );
  console.log(
    `Avg returned chars       ${Math.round(baseline.avgReturnedChars).toString().padStart(8)}   ${Math.round(candidate.avgReturnedChars).toString().padStart(9)}   ${integer(candidate.avgReturnedChars - baseline.avgReturnedChars)}`,
  );
  console.log(
    `Retrieve p50             ${Math.round(baseline.latencyMs.retrieve.p50Ms).toString().padStart(7)}ms   ${Math.round(candidate.latencyMs.retrieve.p50Ms).toString().padStart(8)}ms   ${integer(candidate.latencyMs.retrieve.p50Ms - baseline.latencyMs.retrieve.p50Ms)}ms`,
  );
  console.log(
    `Rerank p50               ${Math.round(baseline.latencyMs.rerank.p50Ms).toString().padStart(7)}ms   ${Math.round(candidate.latencyMs.rerank.p50Ms).toString().padStart(8)}ms   ${integer(candidate.latencyMs.rerank.p50Ms - baseline.latencyMs.rerank.p50Ms)}ms`,
  );
  console.log(
    `Total p50                ${Math.round(baseline.latencyMs.total.p50Ms).toString().padStart(7)}ms   ${Math.round(candidate.latencyMs.total.p50Ms).toString().padStart(8)}ms   ${integer(candidate.latencyMs.total.p50Ms - baseline.latencyMs.total.p50Ms)}ms`,
  );
}

async function readOutput(filePath: string): Promise<BenchmarkOutput> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as BenchmarkOutput;
}

function modelOf(output: BenchmarkOutput): string | null {
  if (!output.models) return null;
  if ('embedding' in output.models) {
    return `${output.models.embedding.provider}/${output.models.embedding.model} + ${output.models.reranker.model}`;
  }
  return `${output.models.embeddingProvider}/${output.models.embeddingModel} + ${output.models.rerankerModel}`;
}

function runtimeOf(output: BenchmarkOutput): string | null {
  if (!output.runtime) return null;
  return `${output.runtime.platform}/${output.runtime.arch} ${output.runtime.cpuModel} Node ${output.runtime.nodeVersion}`;
}

function assertComparable(
  baseline: BenchmarkOutput,
  candidate: BenchmarkOutput,
  options: {
    allowModelChange: boolean;
    allowCorpusChange: boolean;
    allowSearchConfigChange: boolean;
  },
): void {
  const failures: string[] = [];
  if ((baseline.schemaVersion ?? 0) < 3 || (candidate.schemaVersion ?? 0) < 3) {
    failures.push(
      'both results must use benchmark schemaVersion >= 3 (legacy results lack complete reproducibility metadata)',
    );
  }
  if (!baseline.fingerprints || !candidate.fingerprints) {
    failures.push('missing corpus/cases/search-config fingerprints');
  } else {
    if (!baseline.fingerprints.modelConfig || !candidate.fingerprints.modelConfig) {
      failures.push('model config fingerprint is missing');
    }
    if (baseline.fingerprints.cases !== candidate.fingerprints.cases) {
      failures.push('cases hash differs');
    }
    if (baseline.fingerprints.corpusRules !== candidate.fingerprints.corpusRules) {
      failures.push('benchmark corpus exclusion rules differ');
    }
    if (
      !options.allowCorpusChange &&
      baseline.fingerprints.corpus !== candidate.fingerprints.corpus
    ) {
      failures.push('corpus/index snapshot hash differs');
    }
    if (
      !options.allowSearchConfigChange &&
      baseline.fingerprints.searchConfig !== candidate.fingerprints.searchConfig
    ) {
      failures.push('search config hash differs');
    }
    if (
      !options.allowModelChange &&
      baseline.fingerprints.modelConfig !== candidate.fingerprints.modelConfig
    ) {
      failures.push('embedding/reranker configuration differs');
    }
    if (
      baseline.fingerprints.index &&
      candidate.fingerprints.index &&
      !options.allowModelChange &&
      baseline.fingerprints.index !== candidate.fingerprints.index
    ) {
      failures.push('benchmark index identity differs');
    }
  }

  if (baseline.repoName !== candidate.repoName) failures.push('repository name differs');
  if (baseline.casesFile !== candidate.casesFile) failures.push('cases file path differs');
  const baselineModel = modelOf(baseline);
  const candidateModel = modelOf(candidate);
  if (!baselineModel || !candidateModel) {
    failures.push('model metadata is missing');
  } else if (!options.allowModelChange && baselineModel !== candidateModel) {
    failures.push('embedding/reranker models differ');
  }
  if (!baseline.git || !candidate.git) failures.push('git metadata is missing');

  if (failures.length > 0) {
    throw new Error(
      `Refusing non apples-to-apples benchmark comparison:\n- ${failures.join('\n- ')}\n` +
        'Re-run against one frozen benchmark index/corpus and identical cases/models/config, or use an explicit --allow-*-change flag for the single experimental variable.',
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baselinePath = path.resolve(
    readArg(args, '--baseline', 'benchmarks/retrieval/results/local-jina-v2-base-code.json'),
  );
  const candidatePath = path.resolve(
    readArg(args, '--candidate', 'benchmarks/retrieval/results/latest.json'),
  );
  const [baseline, candidate] = await Promise.all([
    readOutput(baselinePath),
    readOutput(candidatePath),
  ]);

  assertComparable(baseline, candidate, {
    allowModelChange: args.includes('--allow-model-change'),
    allowCorpusChange: args.includes('--allow-corpus-change'),
    allowSearchConfigChange: args.includes('--allow-search-config-change'),
  });

  console.log(`Baseline:  ${baselinePath}`);
  console.log(`Candidate: ${candidatePath}\n`);
  console.log(`Embedding/reranker  baseline:   ${modelOf(baseline)}`);
  console.log(`                   candidate:  ${modelOf(candidate)}`);
  if (baseline.corpus?.indexKey || candidate.corpus?.indexKey) {
    console.log(`Benchmark index    baseline:   ${baseline.corpus?.indexKey ?? '(legacy result)'}`);
    console.log(
      `                   candidate:  ${candidate.corpus?.indexKey ?? '(legacy result)'}`,
    );
  }
  console.log(
    `Git state          baseline:   ${baseline.git?.commit ?? '(unknown)'} dirty=${String(baseline.git?.dirty)}`,
  );
  console.log(
    `                   candidate:  ${candidate.git?.commit ?? '(unknown)'} dirty=${String(candidate.git?.dirty)}\n`,
  );
  console.log(`Runtime            baseline:   ${runtimeOf(baseline) ?? '(unknown)'}`);
  console.log(`                   candidate:  ${runtimeOf(candidate) ?? '(unknown)'}`);
  if (runtimeOf(baseline) !== runtimeOf(candidate)) {
    console.log(
      '                   note: runtime differs; latency deltas are not apples-to-apples',
    );
  }
  if (baseline.run && candidate.run) {
    console.log(
      `Run mode           baseline:   index=${baseline.run.index.mode} total=${Math.round(baseline.run.totalDurationMs)}ms`,
    );
    console.log(
      `                   candidate:  index=${candidate.run.index.mode} total=${Math.round(candidate.run.totalDurationMs)}ms\n`,
    );
  } else {
    console.log('');
  }
  printSummaryDelta(baseline.summary, candidate.summary);

  console.log('\nBy category (Top1 / coverage delta)');
  console.log('category       top1       coverage');
  const categories = new Set([
    ...Object.keys(baseline.byCategory ?? {}),
    ...Object.keys(candidate.byCategory ?? {}),
  ]);
  for (const category of categories) {
    const before = baseline.byCategory?.[category];
    const after = candidate.byCategory?.[category];
    if (!before || !after) continue;
    console.log(
      `${category.padEnd(12)} ${pct(after.top1FileAccuracy - before.top1FileAccuracy).padStart(9)}   ${pct(after.relevantFileCoverage - before.relevantFileCoverage).padStart(9)}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
