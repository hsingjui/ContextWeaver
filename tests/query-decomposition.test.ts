import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decomposeQuery } from '../src/search/QueryDecomposer.js';
import { classifyRetrievalIntent } from '../src/search/RetrievalPlan.js';
import { SearchService } from '../src/search/SearchService.js';
import type { ScoredChunk } from '../src/search/types.js';
import type { ChunkRecord } from '../src/vectorStore/index.js';

function chunk(filePath: string, score: number): ScoredChunk {
  const record: ChunkRecord = {
    chunk_id: `${filePath}#h#0`,
    file_path: filePath,
    file_hash: 'h',
    chunk_index: 0,
    vector: [1, 0],
    display_code: filePath,
    vector_text: filePath,
    language: 'typescript',
    breadcrumb: filePath,
    start_index: 0,
    end_index: filePath.length,
    raw_start: 0,
    raw_end: filePath.length,
    vec_start: 0,
    vec_end: filePath.length,
  };
  return { filePath, chunkIndex: 0, score, source: 'vector', record: { ...record, _distance: 0 } };
}

test('query decomposition keeps bounded facets for staged compound questions', () => {
  const query =
    '源码怎样发现并过滤？语义分块和向量化分别怎么做？最终写入什么存储？ crawler splitter embed storage';
  const facets = decomposeQuery(query, 3);
  assert.ok(facets.length >= 2 && facets.length <= 3);
  assert.ok(facets.some((facet) => facet.includes('发现并过滤')));
  assert.ok(facets.some((facet) => facet.includes('语义分块和向量化')));
  assert.equal(classifyRetrievalIntent(query), 'compound');
});

test('query decomposition handles long enumerations and leaves simple symbol queries alone', () => {
  const unicodeQuery =
    '中文与 emoji 源码如何在解析字节偏移、字符坐标、chunk 元数据和索引记录间保持位置一致？ unicode offset span record';
  assert.equal(classifyRetrievalIntent(unicodeQuery), 'compound');
  assert.equal(decomposeQuery(unicodeQuery, 3).length, 3);
  assert.deepEqual(decomposeQuery('请找出 SearchService 的定义', 3), []);
});

test('multiline compound queries preserve line boundaries for decomposition', () => {
  const query = `读取源码文件
解析语法树节点
生成向量索引`;
  assert.equal(classifyRetrievalIntent(query), 'compound');
  assert.deepEqual(decomposeQuery(query, 3), ['读取源码文件', '解析语法树节点', '生成向量索引']);
});

test('facet RRF boosts chunks supported by the full query and a facet', () => {
  const service = new SearchService('facet-test', '.');
  const shared = chunk('src/shared.ts', 0.8);
  const fullOnly = chunk('src/full.ts', 1.0);
  const facetOnly = chunk('src/facet.ts', 1.0);
  const fuse = Reflect.get(service, 'fuseFacetResults') as (
    this: SearchService,
    sets: ScoredChunk[][],
  ) => ScoredChunk[];
  const fused = fuse.call(service, [
    [fullOnly, shared],
    [facetOnly, shared],
  ]);
  assert.equal(fused[0].filePath, 'src/shared.ts');
});
