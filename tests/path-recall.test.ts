import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { extractPathQueryTerms, searchPaths } from '../src/search/PathRecall.js';
import { buildRetrievalPlan } from '../src/search/RetrievalPlan.js';
import { SearchService } from '../src/search/SearchService.js';
import type { ChunkRecord } from '../src/vectorStore/index.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE files(path TEXT PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO files(path) VALUES (?)');
  for (const filePath of [
    'src/api/embedding.ts',
    'src/search/config.ts',
    'src/search/resolvers/JsTsResolver.ts',
    'src/search/resolvers/index.ts',
    'src/mcp/server.ts',
  ]) {
    insert.run(filePath);
  }
  return db;
}

function chunk(filePath: string, code: string): ChunkRecord {
  return {
    chunk_id: `${filePath}#hash#0`,
    file_path: filePath,
    file_hash: 'hash',
    chunk_index: 0,
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

test('path recall tokenizes camelCase and ranks matching stems/directories', () => {
  const db = createDb();
  assert.ok(extractPathQueryTerms('EmbeddingClient 在哪个文件？').includes('embedding'));
  assert.equal(searchPaths(db, 'EmbeddingClient 在哪个文件？')[0].filePath, 'src/api/embedding.ts');
  assert.equal(
    searchPaths(db, 'JsTsResolver import 路径解析器在哪个文件？')[0].filePath,
    'src/search/resolvers/JsTsResolver.ts',
  );
  assert.equal(
    searchPaths(db, 'DEFAULT_CONFIG vectorTopK smartMaxK 在哪里？')[0].filePath,
    'src/search/config.ts',
  );
  db.close();
});

test('RetrievalPlan enables path recall selectively', () => {
  assert.equal(buildRetrievalPlan('which file has EmbeddingClient?').usePath, true);
  assert.equal(buildRetrievalPlan('where is SearchService defined?').usePath, false);
});

test('SearchService path recall resolves a matched path to its most relevant chunk', async () => {
  const db = createDb();
  const configChunk = chunk(
    'src/search/config.ts',
    'export const DEFAULT_CONFIG = { vectorTopK: 80 };',
  );
  const otherChunk = chunk('src/api/embedding.ts', 'export class EmbeddingClient {}');
  const service = new SearchService('path-test', '.');
  Reflect.set(service, 'db', db);
  Reflect.set(service, 'vectorStore', {
    getFilesChunks: async (paths: string[]) =>
      new Map(
        paths.map((filePath) => [
          filePath,
          filePath === configChunk.file_path
            ? [configChunk]
            : filePath === otherChunk.file_path
              ? [otherChunk]
              : [],
        ]),
      ),
  });
  const retrieve = Reflect.get(service, 'pathRetrieve') as (
    this: SearchService,
    query: string,
  ) => Promise<Array<{ filePath: string; source: string }>>;
  const results = await retrieve.call(service, 'DEFAULT_CONFIG vectorTopK 在哪个文件？');
  assert.equal(results[0].filePath, 'src/search/config.ts');
  assert.equal(results[0].source, 'path');
  db.close();
});
