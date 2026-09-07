import assert from 'node:assert/strict';
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { evaluateRanking, type RetrievalCase, summarize } from '../benchmarks/retrieval/metrics.js';
import { getExcludePatterns } from '../src/config.js';

test('retrieval benchmark v1 contains 40 curated cases with the intended category mix', async () => {
  const casesPath = path.resolve('benchmarks/retrieval/cases.json');
  const cases = JSON.parse(await fsPromises.readFile(casesPath, 'utf8')) as RetrievalCase[];

  assert.equal(cases.length, 40);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.deepEqual(
    Object.fromEntries(
      Array.from(new Set(cases.map((item) => item.category))).map((category) => [
        category,
        cases.filter((item) => item.category === category).length,
      ]),
    ),
    {
      symbol: 8,
      feature: 7,
      path: 5,
      reference: 5,
      'call-chain': 5,
      overview: 5,
      compound: 5,
    },
  );

  for (const benchmarkCase of cases) {
    assert.ok(benchmarkCase.informationRequest.trim().length > 0, benchmarkCase.id);
    assert.ok(benchmarkCase.relevantFiles.length > 0, benchmarkCase.id);
    for (const relevantFile of benchmarkCase.relevantFiles) {
      assert.ok(fs.existsSync(path.resolve(relevantFile)), `${benchmarkCase.id}: ${relevantFile}`);
    }
  }
});

test('benchmark files are excluded from the indexed corpus to prevent answer leakage', () => {
  assert.ok(getExcludePatterns().includes('benchmarks'));
});

test('evaluateRanking computes file-level hit, MRR, coverage, and unique files', () => {
  const metrics = evaluateRanking(
    ['src/a.ts', 'src/b.ts'],
    ['src/x.ts', './src/a.ts', 'src/b.ts'],
    321,
  );

  assert.equal(metrics.top1FileHit, false);
  assert.equal(metrics.recallAt5, true);
  assert.equal(metrics.recallAt10, true);
  assert.equal(metrics.reciprocalRank, 0.5);
  assert.equal(metrics.relevantFileCoverage, 1);
  assert.equal(metrics.uniqueFiles, 3);
  assert.equal(metrics.returnedChars, 321);
});

test('evaluateRanking deduplicates ranked paths and reports misses', () => {
  const metrics = evaluateRanking(['src/target.ts'], ['src/a.ts', 'src/a.ts', 'src/b.ts'], 10);

  assert.equal(metrics.top1FileHit, false);
  assert.equal(metrics.recallAt5, false);
  assert.equal(metrics.recallAt10, false);
  assert.equal(metrics.reciprocalRank, 0);
  assert.equal(metrics.relevantFileCoverage, 0);
  assert.equal(metrics.uniqueFiles, 2);
});

test('summarize averages quality metrics and reports p50 stage latency', () => {
  const summary = summarize([
    {
      category: 'symbol',
      metrics: evaluateRanking(['a.ts'], ['a.ts'], 100),
      timingMs: { retrieve: 10, rerank: 30, total: 50 },
    },
    {
      category: 'symbol',
      metrics: evaluateRanking(['b.ts'], ['x.ts', 'b.ts'], 300),
      timingMs: { retrieve: 20, rerank: 50, total: 90 },
    },
  ]);

  assert.equal(summary.cases, 2);
  assert.equal(summary.top1FileAccuracy, 0.5);
  assert.equal(summary.recallAt5, 1);
  assert.equal(summary.recallAt10, 1);
  assert.equal(summary.mrr, 0.75);
  assert.equal(summary.relevantFileCoverage, 1);
  assert.equal(summary.avgUniqueFiles, 1.5);
  assert.equal(summary.avgReturnedChars, 200);
  assert.deepEqual(summary.latencyMs.retrieve, { avgMs: 15, p50Ms: 15 });
  assert.deepEqual(summary.latencyMs.rerank, { avgMs: 40, p50Ms: 40 });
  assert.deepEqual(summary.latencyMs.total, { avgMs: 70, p50Ms: 70 });
});
