import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { getParser, SemanticSplitter } from '../src/chunking/index.js';
import {
  batchReplaceSymbolOccurrences,
  initSymbolOccurrences,
  searchSymbolOccurrences,
} from '../src/db/index.js';
import { extractSymbols } from '../src/indexer/SymbolExtractor.js';
import { DEFAULT_CONFIG } from '../src/search/config.js';
import { SearchService } from '../src/search/SearchService.js';
import type { ScoredChunk } from '../src/search/types.js';
import type { ChunkRecord } from '../src/vectorStore/index.js';

function record(filePath: string, chunkIndex: number, code: string): ChunkRecord {
  return {
    chunk_id: `${filePath}#hash#${chunkIndex}`,
    file_path: filePath,
    file_hash: 'hash',
    chunk_index: chunkIndex,
    vector: [1, 0],
    display_code: code,
    vector_text: code,
    language: 'typescript',
    breadcrumb: filePath,
    start_index: 0,
    end_index: code.length,
    raw_start: 0,
    raw_end: code.length,
    vec_start: 0,
    vec_end: code.length,
  };
}

test('Tree-sitter symbol extraction indexes class, method and arrow-function definitions', async () => {
  const code = `
export class SearchService {
  buildContextPack(): string { return 'ok'; }
}
const helperFactory = () => new SearchService();
`;
  const parser = await getParser('typescript');
  assert.ok(parser);
  const tree = parser.parse(code);
  const splitter = new SemanticSplitter({ maxChunkSize: 500, minChunkSize: 10, chunkOverlap: 0 });
  const chunks = splitter.split(tree, code, 'src/search.ts', 'typescript');
  const symbols = await extractSymbols('src/search.ts', 'typescript', code, chunks);

  assert.ok(symbols.some((item) => item.identifier === 'SearchService' && item.kind === 'class'));
  assert.ok(
    symbols.some((item) => item.identifier === 'buildContextPack' && item.kind === 'method'),
  );
  assert.ok(
    symbols.some((item) => item.identifier === 'helperFactory' && item.kind === 'function'),
  );
  assert.ok(symbols.every((item) => item.chunkIndex >= 0 && item.chunkIndex < chunks.length));
});

test('symbol extraction preserves valid definitions around a syntax error', async () => {
  const code = `
export class Good {}
function unfinished(
`;
  const parser = await getParser('typescript');
  assert.ok(parser);
  const tree = parser.parse(code);
  assert.equal(tree.rootNode.hasError, true);
  const splitter = new SemanticSplitter({ maxChunkSize: 500, minChunkSize: 1, chunkOverlap: 0 });
  const chunks = splitter.split(tree, code, 'src/broken.ts', 'typescript');
  const symbols = await extractSymbols('src/broken.ts', 'typescript', code, chunks);
  assert.ok(symbols.some((item) => item.identifier === 'Good' && item.kind === 'class'));
});

test('symbol occurrence replacement is exact and removes stale definitions', () => {
  const db = new Database(':memory:');
  initSymbolOccurrences(db);
  batchReplaceSymbolOccurrences(
    db,
    ['src/a.ts'],
    [
      {
        identifier: 'SearchService',
        kind: 'class',
        filePath: 'src/a.ts',
        chunkIndex: 0,
        startIndex: 10,
        endIndex: 23,
      },
    ],
  );
  assert.equal(searchSymbolOccurrences(db, ['SearchService']).length, 1);
  assert.equal(searchSymbolOccurrences(db, ['searchservice']).length, 0);

  batchReplaceSymbolOccurrences(db, ['src/a.ts'], []);
  assert.equal(searchSymbolOccurrences(db, ['SearchService']).length, 0);
  db.close();
});

test('SearchService exact symbol recall resolves indexed definitions to chunks', async () => {
  const db = new Database(':memory:');
  initSymbolOccurrences(db);
  batchReplaceSymbolOccurrences(
    db,
    ['src/search/SearchService.ts'],
    [
      {
        identifier: 'SearchService',
        kind: 'class',
        filePath: 'src/search/SearchService.ts',
        chunkIndex: 2,
        startIndex: 10,
        endIndex: 23,
      },
    ],
  );
  const chunk = record('src/search/SearchService.ts', 2, 'export class SearchService {}');
  const service = new SearchService('exact-test', '.', DEFAULT_CONFIG);
  Reflect.set(service, 'db', db);
  Reflect.set(service, 'vectorStore', {
    getFilesChunks: async () => new Map([[chunk.file_path, [chunk]]]),
  });

  const retrieve = Reflect.get(service, 'exactSymbolRetrieve') as (
    this: SearchService,
    query: string,
  ) => Promise<ScoredChunk[]>;
  const results = await retrieve.call(service, '请定位 SearchService 的声明位置');
  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'exact');
  assert.equal(results[0].filePath, 'src/search/SearchService.ts');
  db.close();
});

test('reference graph anchor is chosen from symbols that actually exist in the index', () => {
  const db = new Database(':memory:');
  initSymbolOccurrences(db);
  batchReplaceSymbolOccurrences(
    db,
    ['src/scan.ts', 'src/indexer.ts', 'src/http.ts', 'src/search.ts'],
    [
      {
        identifier: 'scan',
        kind: 'function',
        filePath: 'src/scan.ts',
        chunkIndex: 0,
        startIndex: 0,
        endIndex: 4,
      },
      {
        identifier: 'Indexer',
        kind: 'class',
        filePath: 'src/indexer.ts',
        chunkIndex: 0,
        startIndex: 0,
        endIndex: 7,
      },
      {
        identifier: 'HTTPClient',
        kind: 'class',
        filePath: 'src/http.ts',
        chunkIndex: 0,
        startIndex: 0,
        endIndex: 10,
      },
      {
        identifier: 'SearchService',
        kind: 'class',
        filePath: 'src/search.ts',
        chunkIndex: 0,
        startIndex: 0,
        endIndex: 13,
      },
    ],
  );
  const service = new SearchService('anchor-test', '.', DEFAULT_CONFIG);
  Reflect.set(service, 'db', db);
  const resolve = Reflect.get(service, 'resolveGraphAnchorTerms') as (
    this: SearchService,
    query: string,
  ) => string[];

  assert.deepEqual(resolve.call(service, 'who calls scan?'), ['scan']);
  assert.deepEqual(resolve.call(service, 'Indexer 中谁调用了 scan？'), ['scan']);
  assert.deepEqual(resolve.call(service, 'who calls scan in Indexer?'), ['scan']);
  assert.deepEqual(resolve.call(service, '谁调用了 Indexer？'), ['Indexer']);
  assert.deepEqual(resolve.call(service, '谁调用了 HTTPClient？'), ['HTTPClient']);
  assert.deepEqual(resolve.call(service, 'who calls somethingUnknown?'), []);
  db.close();
});

test('exact symbol RRF signal outranks a vector-only candidate at equal rank', () => {
  const service = new SearchService('fuse-test', '.', DEFAULT_CONFIG);
  const vectorRecord = record('src/vector.ts', 0, 'vector candidate');
  const exactRecord = record('src/exact.ts', 0, 'class Exact {}');
  const vector: ScoredChunk & { _rank: number } = {
    filePath: vectorRecord.file_path,
    chunkIndex: 0,
    score: 1,
    source: 'vector',
    record: { ...vectorRecord, _distance: 0 },
    _rank: 0,
  };
  const exact: ScoredChunk & { _rank: number } = {
    filePath: exactRecord.file_path,
    chunkIndex: 0,
    score: 1,
    source: 'exact',
    record: { ...exactRecord, _distance: 0 },
    _rank: 0,
  };
  const fuse = Reflect.get(service, 'fuse') as (
    this: SearchService,
    vector: (typeof vector)[],
    lexical: ScoredChunk[],
    exact: (typeof exact)[],
  ) => ScoredChunk[];
  const fused = fuse.call(service, [vector], [], [exact]);
  assert.equal(fused[0].filePath, 'src/exact.ts');
});
