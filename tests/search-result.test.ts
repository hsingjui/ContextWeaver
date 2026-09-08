import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonlLine, toCliSearchResult } from '../src/cli/searchResult.js';
import type { ContextPack, ScoredChunk } from '../src/search/types.js';

function makeChunk(
  filePath: string,
  chunkIndex: number,
  score: number,
  source: ScoredChunk['source'],
): ScoredChunk {
  return {
    filePath,
    chunkIndex,
    score,
    source,
    record: {
      chunk_id: `${filePath}#h#${chunkIndex}`,
      file_path: filePath,
      file_hash: 'h',
      chunk_index: chunkIndex,
      vector: new Array(768).fill(0.1),
      display_code: 'display-code',
      vector_text: 'vector-text',
      language: 'ts',
      breadcrumb: 'breadcrumb',
      start_index: 0,
      end_index: 10,
      raw_start: 0,
      raw_end: 10,
      _distance: 0.01,
    } as ScoredChunk['record'],
  };
}

function makePack(): ContextPack {
  return {
    query: 'where is SearchService defined?',
    seeds: [makeChunk('a.ts', 0, 0.9, 'vector'), makeChunk('a.ts', 1, 0.8, 'exact')],
    expanded: [makeChunk('b.ts', 0, 0.5, 'neighbor')],
    files: [
      {
        filePath: 'a.ts',
        segments: [
          {
            rawStart: 0,
            rawEnd: 10,
            startLine: 1,
            endLine: 9,
            score: 0.9,
            breadcrumb: 'breadcrumb',
            text: 'code text',
          },
        ],
      },
    ],
    debug: {
      wVec: 1,
      wLex: 2,
      wExact: 3,
      wPath: 4,
      timingMs: { retrieve: 10, rerank: 20, total: 30 },
      facets: ['facet'],
      graphAnchorTerms: ['SearchService'],
    },
  };
}

test('toCliSearchResult 只输出白名单字段，不泄露 record/vector', () => {
  const result = toCliSearchResult(makePack());
  const json = JSON.stringify(result);

  assert.equal(result.version, 1);
  assert.deepEqual(result.seeds, [
    { filePath: 'a.ts', chunkIndex: 0, score: 0.9, source: 'vector' },
    { filePath: 'a.ts', chunkIndex: 1, score: 0.8, source: 'exact' },
  ]);
  assert.deepEqual(result.expanded, [
    { filePath: 'b.ts', chunkIndex: 0, score: 0.5, source: 'neighbor' },
  ]);

  // 内部字段一律不得进入机器输出
  assert.ok(!json.includes('record'), '不得输出 record');
  assert.ok(!json.includes('vector_text'), '不得输出 vector_text');
  assert.ok(!json.includes('display_code'), '不得输出 display_code');
  assert.ok(!json.includes('_distance'), '不得输出 _distance');
  assert.ok(!json.includes('file_hash'), '不得输出 file_hash');

  // 有效载荷保留：代码段文本与诊断 timing
  assert.equal(result.files[0].segments[0].text, 'code text');
  assert.equal(result.debug?.timingMs.total, 30);
  assert.deepEqual(result.debug?.graphAnchorTerms, ['SearchService']);
});

test('toCliSearchResult 无 debug 时输出省略 debug 字段', () => {
  const pack = makePack();
  delete pack.debug;
  const result = toCliSearchResult(pack);
  assert.equal(result.debug, undefined);
  assert.ok(!JSON.stringify(result).includes('debug'));
});

test('parseJsonlLine 接受合法查询', () => {
  const row = parseJsonlLine('{"information_request":"where is X","technical_terms":["X","Y"]}', 1);
  assert.ok(row.ok);
  if (row.ok) {
    assert.equal(row.query.information_request, 'where is X');
    assert.deepEqual(row.query.technical_terms, ['X', 'Y']);
  }
});

test('parseJsonlLine 拒绝字符串型 technical_terms（防 spread 成字符）', () => {
  const row = parseJsonlLine('{"information_request":"where","technical_terms":"abc"}', 1);
  assert.ok(!row.ok);
  if (!row.ok) assert.match(row.error, /technical_terms/);
});

test('parseJsonlLine 拒绝缺 information_request / 空串 / 非 JSON', () => {
  for (const [raw, pattern] of [
    ['{}', /information_request/],
    ['{"information_request":"   "}', /information_request/],
    ['not json', /不是合法 JSON/],
    ['[1,2]', /expected object|information_request/],
  ] as const) {
    const row = parseJsonlLine(raw, 3);
    assert.ok(!row.ok, `应拒绝: ${raw}`);
    if (!row.ok) assert.match(row.error, pattern);
  }
});
