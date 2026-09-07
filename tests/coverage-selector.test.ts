import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SemanticSplitter } from '../src/chunking/SemanticSplitter.js';
import { SourceAdapter } from '../src/chunking/SourceAdapter.js';
import { ContextPacker } from '../src/search/ContextPacker.js';
import { CoverageSelector } from '../src/search/CoverageSelector.js';
import { DEFAULT_CONFIG } from '../src/search/config.js';
import { SearchService } from '../src/search/SearchService.js';
import type { ScoredChunk, SearchConfig } from '../src/search/types.js';
import type { ChunkRecord } from '../src/vectorStore/index.js';

function chunk(
  filePath: string,
  chunkIndex: number,
  score: number,
  rawStart: number,
  rawEnd: number,
  displayCode = '',
): ScoredChunk {
  const record: ChunkRecord = {
    chunk_id: `${filePath}#hash#${chunkIndex}`,
    file_path: filePath,
    file_hash: 'hash',
    chunk_index: chunkIndex,
    vector: [1, 0],
    display_code: displayCode,
    vector_text: displayCode,
    language: 'typescript',
    breadcrumb: filePath,
    start_index: rawStart,
    end_index: rawEnd,
    raw_start: rawStart,
    raw_end: rawEnd,
    vec_start: rawStart,
    vec_end: rawEnd,
  };

  return {
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: { ...record, _distance: 0 },
  };
}

function config(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

test('CoverageSelector prefers cross-file coverage before filling same-file chunks', () => {
  const selector = new CoverageSelector(config({ maxSegmentsPerFile: 3, maxTotalChars: 1000 }));
  const selected = selector.select([
    chunk('a.ts', 0, 1.0, 0, 100),
    chunk('a.ts', 1, 0.99, 200, 300),
    chunk('a.ts', 2, 0.98, 400, 500),
    chunk('b.ts', 0, 0.8, 0, 100),
    chunk('c.ts', 0, 0.7, 0, 100),
  ]);

  assert.deepEqual(
    selected.slice(0, 3).map((item) => item.filePath),
    ['a.ts', 'b.ts', 'c.ts'],
  );
  assert.equal(selected.length, 5);
});

test('CoverageSelector deduplicates the same canonical chunk across recall sources', () => {
  const selector = new CoverageSelector(config({ maxSegmentsPerFile: 3, maxTotalChars: 1000 }));
  const primary = chunk('a.ts', 0, 1.0, 0, 100);
  const duplicate: ScoredChunk = { ...primary, score: 0.8, source: 'neighbor' };
  const selected = selector.select([primary, duplicate, chunk('b.ts', 0, 0.7, 0, 100)]);

  assert.deepEqual(
    selected.map((item) => `${item.filePath}#${item.chunkIndex}`),
    ['a.ts#0', 'b.ts#0'],
  );
  assert.equal(selected[0].score, 1.0);
});

test('CoverageSelector enforces maxSegmentsPerFile while still covering other files', () => {
  const selector = new CoverageSelector(config({ maxSegmentsPerFile: 2, maxTotalChars: 1000 }));
  const selected = selector.select([
    chunk('a.ts', 0, 1.0, 0, 100),
    chunk('a.ts', 1, 0.9, 100, 200),
    chunk('a.ts', 2, 0.8, 200, 300),
    chunk('b.ts', 0, 0.7, 0, 100),
  ]);

  assert.deepEqual(
    selected.map((item) => `${item.filePath}#${item.chunkIndex}`),
    ['a.ts#0', 'b.ts#0', 'a.ts#1'],
  );
  assert.equal(selected.filter((item) => item.filePath === 'a.ts').length, 2);
});

test('CoverageSelector retries a smaller chunk from a file when its top chunk does not fit', () => {
  const selector = new CoverageSelector(config({ maxSegmentsPerFile: 3, maxTotalChars: 40 }));
  const selected = selector.select([
    chunk('a.ts', 0, 1.0, 0, 50),
    chunk('a.ts', 1, 0.9, 50, 70),
    chunk('b.ts', 0, 0.8, 0, 20),
  ]);

  assert.deepEqual(
    selected.map((item) => `${item.filePath}#${item.chunkIndex}`),
    ['a.ts#1', 'b.ts#0'],
  );
});

test('CoverageSelector skips chunks that do not fit and continues within the char budget', () => {
  const selector = new CoverageSelector(config({ maxTotalChars: 60, maxSegmentsPerFile: 3 }));
  const selected = selector.select([
    chunk('too-large.ts', 0, 1.0, 0, 100),
    chunk('fits-a.ts', 0, 0.9, 0, 30),
    chunk('fits-b.ts', 0, 0.8, 0, 25),
    chunk('overflow.ts', 0, 0.7, 0, 10),
  ]);

  assert.deepEqual(
    selected.map((item) => item.filePath),
    ['fits-a.ts', 'fits-b.ts'],
  );
  assert.ok(
    selected.reduce((total, item) => total + item.record.raw_end - item.record.raw_start, 0) <= 60,
  );
});

test('CoverageSelector raw span budget stays in JS string units for UTF-8 parser metadata', () => {
  const code = '// 中文😀\nconst first = "登录";\nconst second = "配置";\n';
  const splitter = new SemanticSplitter({ maxChunkSize: 15, minChunkSize: 1 });
  Reflect.set(splitter, 'code', code);
  Reflect.set(
    splitter,
    'adapter',
    new SourceAdapter({ code, endIndex: Buffer.byteLength(code, 'utf8') }),
  );

  const boundary = code.indexOf('const second');
  const byteBoundary = Buffer.byteLength(code.slice(0, boundary), 'utf8');
  const processed = Reflect.get(splitter, 'windowsToChunks').call(
    splitter,
    [
      { nodes: [{ startIndex: 0, endIndex: byteBoundary }], size: 20, contextPath: ['file.ts'] },
      {
        nodes: [{ startIndex: byteBoundary, endIndex: Buffer.byteLength(code, 'utf8') }],
        size: 20,
        contextPath: ['file.ts'],
      },
    ],
    'file.ts',
    'typescript',
  ) as Array<{
    displayCode: string;
    metadata: { rawSpan: { start: number; end: number } };
  }>;

  const candidates = processed.map((item, index) =>
    chunk(
      'file.ts',
      index,
      1 - index * 0.1,
      item.metadata.rawSpan.start,
      item.metadata.rawSpan.end,
      item.displayCode,
    ),
  );
  const rawChars = candidates.reduce(
    (total, item) => total + item.record.raw_end - item.record.raw_start,
    0,
  );

  assert.equal(rawChars, code.length);
  assert.equal(
    candidates.map((item) => code.slice(item.record.raw_start, item.record.raw_end)).join('')
      .length,
    code.length,
  );

  const selected = new CoverageSelector(
    config({ maxSegmentsPerFile: 10, maxTotalChars: code.length }),
  ).select(candidates);
  assert.equal(selected.length, candidates.length);
});

test('SearchService passes coverage-selected chunks to ContextPacker', async () => {
  const service = new SearchService('coverage-selector-test', '.', {
    enableSmartTopK: false,
    maxSegmentsPerFile: 3,
    maxTotalChars: 1000,
  });
  const a0 = chunk('a.ts', 0, 1.0, 0, 100);
  const a1 = chunk('a.ts', 1, 0.9, 100, 200);
  const b0 = chunk('b.ts', 0, 0.8, 0, 100);
  const duplicateA0: ScoredChunk = { ...a0, score: 0.7, source: 'neighbor' };

  Reflect.set(service, 'hybridRetrieve', async () => [a0, a1]);
  Reflect.set(service, 'rerank', async (_query: string, candidates: ScoredChunk[]) => candidates);
  Reflect.set(service, 'expand', async () => [b0, duplicateA0]);

  const originalPack = ContextPacker.prototype.pack;
  let packedChunks: ScoredChunk[] = [];
  ContextPacker.prototype.pack = async (chunks: ScoredChunk[]) => {
    packedChunks = chunks;
    return [];
  };

  try {
    const result = await service.buildContextPack('coverage query');
    assert.deepEqual(
      packedChunks.map((item) => `${item.filePath}#${item.chunkIndex}`),
      ['a.ts#0', 'b.ts#0', 'a.ts#1'],
    );
    assert.deepEqual(result.files, []);
    assert.ok(result.debug?.timingMs.select !== undefined);
  } finally {
    ContextPacker.prototype.pack = originalPack;
  }
});

test('CoverageSelector exposes stable selection diagnostics', () => {
  const selector = new CoverageSelector(config({ maxSegmentsPerFile: 1, maxTotalChars: 60 }));
  const duplicate = chunk('a.ts', 0, 0.95, 0, 20);
  const result = selector.selectWithStats([
    chunk('a.ts', 0, 1.0, 0, 20),
    { ...duplicate, source: 'neighbor' },
    chunk('a.ts', 1, 0.9, 20, 40),
    chunk('b.ts', 0, 0.8, 0, 30),
    chunk('c.ts', 0, 0.7, 0, 50),
  ]);

  assert.deepEqual(
    result.chunks.map((item) => `${item.filePath}#${item.chunkIndex}`),
    ['a.ts#0', 'b.ts#0'],
  );
  assert.deepEqual(result.stats, {
    candidates: 5,
    selectedChunks: 2,
    selectedFiles: 2,
    selectedChars: 50,
    skippedDuplicates: 1,
    skippedPerFileLimit: 1,
    skippedBudget: 1,
    skippedFileLimit: 0,
  });
});

test('CoverageSelector caps unique files while still filling selected files', () => {
  const selector = new CoverageSelector(
    config({ maxSegmentsPerFile: 2, maxContextFiles: 2, maxTotalChars: 1000 }),
  );
  const selection = selector.selectWithStats([
    chunk('a.ts', 0, 1.0, 0, 100),
    chunk('b.ts', 0, 0.9, 0, 100),
    chunk('c.ts', 0, 0.8, 0, 100),
    chunk('a.ts', 1, 0.7, 100, 200),
    chunk('b.ts', 1, 0.6, 100, 200),
  ]);
  assert.deepEqual(
    selection.chunks.map((item) => `${item.filePath}#${item.chunkIndex}`),
    ['a.ts#0', 'b.ts#0', 'a.ts#1', 'b.ts#1'],
  );
  assert.equal(selection.stats.selectedFiles, 2);
  assert.equal(selection.stats.skippedFileLimit, 1);
});
