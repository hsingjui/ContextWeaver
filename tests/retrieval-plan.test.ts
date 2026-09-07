import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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

  const path = buildRetrievalPlan('which file contains search config?');
  assert.equal(path.usePath, true);
  assert.equal(path.useExact, false);

  const overview = buildRetrievalPlan('architecture overview');
  assert.equal(overview.useExact, false);
  assert.equal(overview.useVector, true);
  assert.equal(overview.useLexical, true);

  const reference = buildRetrievalPlan('who calls withLock?');
  assert.equal(reference.useExact, false);
  assert.equal(reference.expandDependencies, true);
  assert.equal(reference.dependencyDirection, 'reverse');
  assert.ok(
    reference.dependencyDecay < 1,
    'reverse imports must not be caller-like boosted evidence',
  );
});

test('benchmark categories and RetrievalPlan taxonomy use the same definitions', async () => {
  const cases = JSON.parse(
    await readFile(path.resolve('benchmarks/retrieval/cases.json'), 'utf8'),
  ) as Array<{
    id: string;
    category: ReturnType<typeof classifyRetrievalIntent>;
    informationRequest: string;
    technicalTerms?: string[];
  }>;
  for (const benchmarkCase of cases) {
    const query = [benchmarkCase.informationRequest, ...(benchmarkCase.technicalTerms ?? [])].join(
      ' ',
    );
    assert.equal(classifyRetrievalIntent(query), benchmarkCase.category, benchmarkCase.id);
  }
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
