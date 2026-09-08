import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRetrievalPlan, classifyRetrievalIntent } from '../src/search/RetrievalPlan.js';
import { SearchService } from '../src/search/SearchService.js';
import type { ScoredChunk } from '../src/search/types.js';

test('RetrievalPlan classifies representative coding-agent queries without an LLM', () => {
  assert.equal(classifyRetrievalIntent('SearchService 的定义位置是什么？'), 'symbol');
  assert.equal(classifyRetrievalIntent('search config 在哪个文件？'), 'path');
  assert.equal(classifyRetrievalIntent('谁调用了 withLock？'), 'reference');
  assert.equal(
    classifyRetrievalIntent('SearchService 在哪里复用 segmentQuery，使词法召回保持一致？'),
    'reference',
  );
  assert.equal(classifyRetrievalIntent('segmentQuery 是在哪里被调用的？'), 'reference');
  assert.equal(classifyRetrievalIntent('从 MCP 到 SearchService 的调用链是什么？'), 'call-chain');
  assert.equal(classifyRetrievalIntent('解释整体 retrieval 架构'), 'overview');
  assert.equal(classifyRetrievalIntent('embedding 长输入怎么处理'), 'feature');
  assert.equal(
    classifyRetrievalIntent('登录从哪里触发？后端在哪里校验？失败后怎么返回？'),
    'compound',
  );
});

test('RetrievalPlan enables high-precision channels only where they are useful', () => {
  const symbol = buildRetrievalPlan('where is SearchService defined?');
  assert.equal(symbol.useExact, true);
  assert.equal(symbol.usePath, false);
  assert.equal(symbol.minSeedFiles, 1);

  const path = buildRetrievalPlan('which file contains search config?');
  assert.equal(path.usePath, true);
  assert.equal(path.useExact, false);
  assert.equal(path.minSeedFiles, 1);

  const overview = buildRetrievalPlan('architecture overview');
  assert.equal(overview.useExact, false);
  assert.equal(overview.useVector, true);
  assert.equal(overview.useLexical, true);
  assert.equal(overview.minSeedFiles, 4);

  const reference = buildRetrievalPlan('who calls withLock?');
  assert.equal(reference.useExact, false);
  assert.equal(reference.expandDependencies, true);
  assert.equal(reference.dependencyDirection, 'reverse');
  assert.equal(reference.minSeedFiles, 2);
  assert.ok(
    reference.dependencyDecay < 1,
    'reverse imports must not be caller-like boosted evidence',
  );
});

test('SmartTopK keeps distinct-file safe harbor for broad intents', () => {
  const service = new SearchService('smart-topk-plan-test', '.');
  const chunk = (filePath: string, chunkIndex: number, score: number): ScoredChunk => ({
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: {} as ScoredChunk['record'],
  });
  const candidates = [
    chunk('a.ts', 0, 0.23),
    chunk('a.ts', 1, 0.22),
    chunk('b.ts', 0, 0.2),
    chunk('c.ts', 0, 0.18),
    chunk('d.ts', 0, 0.17),
    chunk('e.ts', 0, 0.16),
  ];
  const applyCutoff = Reflect.get(service, 'applySmartCutoff') as (
    this: SearchService,
    chunks: ScoredChunk[],
    plan: ReturnType<typeof buildRetrievalPlan>,
  ) => ScoredChunk[];

  const overview = applyCutoff.call(
    service,
    candidates,
    buildRetrievalPlan('architecture overview'),
  );
  assert.equal(overview.length, 4);
  assert.equal(new Set(overview.map((item) => item.filePath)).size, 4);

  const symbol = applyCutoff.call(
    service,
    candidates,
    buildRetrievalPlan('where is SearchService defined?'),
  );
  assert.deepEqual(
    symbol.map((item) => item.filePath),
    ['a.ts'],
  );
});

test('SmartTopK low-confidence fallback collapses to top1 when nothing clears the secondary floor', () => {
  const service = new SearchService('smart-topk-garbage-test', '.');
  const chunk = (filePath: string, chunkIndex: number, score: number): ScoredChunk => ({
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: {} as ScoredChunk['record'],
  });
  // 全体低于 floor(0.25)，也低于次级门槛 floor*ratio(0.125)：
  // 不得为凑 minSeedFiles 硬凑无关文件，只返回 top1 低置信降级
  const candidates = [
    chunk('a.ts', 0, 0.05),
    chunk('b.ts', 0, 0.04),
    chunk('c.ts', 0, 0.03),
    chunk('d.ts', 0, 0.02),
    chunk('e.ts', 0, 0.01),
  ];
  const applyCutoff = Reflect.get(service, 'applySmartCutoff') as (
    this: SearchService,
    chunks: ScoredChunk[],
    plan: ReturnType<typeof buildRetrievalPlan>,
  ) => ScoredChunk[];

  const overview = applyCutoff.call(
    service,
    candidates,
    buildRetrievalPlan('architecture overview'),
  );
  assert.deepEqual(
    overview.map((item) => item.filePath),
    ['a.ts'],
  );
});

test('SmartTopK can replace duplicate-file seeds to satisfy broad-query file diversity', () => {
  const service = new SearchService('smart-topk-diversity-test', '.');
  const chunk = (filePath: string, chunkIndex: number, score: number): ScoredChunk => ({
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: {} as ScoredChunk['record'],
  });
  const candidates = [
    chunk('a.ts', 0, 0.9),
    chunk('a.ts', 1, 0.85),
    chunk('a.ts', 2, 0.8),
    chunk('a.ts', 3, 0.75),
    chunk('a.ts', 4, 0.7),
    chunk('a.ts', 5, 0.65),
    chunk('b.ts', 0, 0.4),
    chunk('c.ts', 0, 0.35),
    chunk('d.ts', 0, 0.3),
  ];
  const applyCutoff = Reflect.get(service, 'applySmartCutoff') as (
    this: SearchService,
    chunks: ScoredChunk[],
    plan: ReturnType<typeof buildRetrievalPlan>,
  ) => ScoredChunk[];

  const overview = applyCutoff.call(
    service,
    candidates,
    buildRetrievalPlan('architecture overview'),
  );
  assert.equal(overview.length, 6);
  assert.equal(new Set(overview.map((item) => item.filePath)).size, 4);
  assert.ok(overview.some((item) => item.filePath === 'd.ts'));
});

test('SmartTopK file-diversity backfill never dips below the absolute floor', () => {
  const service = new SearchService('smart-topk-floor-test', '.');
  const chunk = (filePath: string, chunkIndex: number, score: number): ScoredChunk => ({
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: {} as ScoredChunk['record'],
  });
  // 实测场景：一个强文件 + 多个远低于 floor(0.25) 的垃圾分数文件。
  // 为凑 overview 的 minSeedFiles=4，不得把 0.02/0.01/0.005 的候选捞回来。
  const candidates = [
    chunk('a.ts', 0, 0.9),
    chunk('a.ts', 1, 0.85),
    chunk('a.ts', 2, 0.8),
    chunk('b.ts', 0, 0.02),
    chunk('c.ts', 0, 0.01),
    chunk('d.ts', 0, 0.005),
  ];
  const applyCutoff = Reflect.get(service, 'applySmartCutoff') as (
    this: SearchService,
    chunks: ScoredChunk[],
    plan: ReturnType<typeof buildRetrievalPlan>,
  ) => ScoredChunk[];

  const overview = applyCutoff.call(
    service,
    candidates,
    buildRetrievalPlan('architecture overview'),
  );
  assert.deepEqual(
    overview.map((item) => item.filePath),
    ['a.ts', 'a.ts', 'a.ts'],
  );
  assert.ok(
    overview.every((item) => item.score >= 0.25),
    '补齐不得低于绝对 floor',
  );
});

test('SmartTopK backfill accepts candidates exactly at the floor', () => {
  const service = new SearchService('smart-topk-floor-equal-test', '.');
  const chunk = (filePath: string, chunkIndex: number, score: number): ScoredChunk => ({
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: {} as ScoredChunk['record'],
  });
  const candidates = [
    chunk('a.ts', 0, 0.9),
    chunk('a.ts', 1, 0.85),
    chunk('a.ts', 2, 0.8),
    // 恰好等于 floor(0.25)：等值可以补齐；0.24/0.1 不行。
    chunk('b.ts', 0, 0.25),
    chunk('c.ts', 0, 0.24),
    chunk('d.ts', 0, 0.1),
  ];
  const applyCutoff = Reflect.get(service, 'applySmartCutoff') as (
    this: SearchService,
    chunks: ScoredChunk[],
    plan: ReturnType<typeof buildRetrievalPlan>,
  ) => ScoredChunk[];

  const overview = applyCutoff.call(
    service,
    candidates,
    buildRetrievalPlan('architecture overview'),
  );
  assert.equal(overview.length, 4);
  assert.ok(overview.some((item) => item.filePath === 'b.ts' && item.score === 0.25));
  assert.ok(overview.every((item) => item.score >= 0.25));
});

test('SearchService obeys RetrievalPlan recall channel switches', async () => {
  const service = new SearchService('plan-test', '.');
  const calls: string[] = [];
  Reflect.set(service, 'vectorRetrieve', async () => {
    calls.push('vector');
    return [] as ScoredChunk[];
  });
  Reflect.set(service, 'lexicalRetrieve', async () => {
    calls.push('lexical');
    return [] as ScoredChunk[];
  });
  Reflect.set(service, 'exactSymbolRetrieve', async () => {
    calls.push('exact');
    return [] as ScoredChunk[];
  });
  const retrieve = Reflect.get(service, 'hybridRetrieve') as (
    this: SearchService,
    query: string,
    plan: ReturnType<typeof buildRetrievalPlan>,
  ) => Promise<ScoredChunk[]>;

  await retrieve.call(
    service,
    'architecture overview',
    buildRetrievalPlan('architecture overview'),
  );
  assert.deepEqual(calls.sort(), ['lexical', 'vector']);
});
