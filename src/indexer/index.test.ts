import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import Database from 'better-sqlite3';
import type { ProcessedChunk } from '../chunking/types.js';
import { getFilesNeedingVectorIndex } from '../db/index.js';
import { initExactIndex, searchExactIndex } from '../search/exactIndex.js';
import type { ProcessResult } from '../scanner/processor.js';
import { Indexer } from './index.js';

function initTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content TEXT,
      language TEXT NOT NULL,
      vector_index_hash TEXT
    )
  `);
  initExactIndex(db);
  return db;
}

function makeChunk(filePath: string, content: string): ProcessedChunk {
  return {
    displayCode: content,
    vectorText: content,
    nwsSize: content.trim().length,
    metadata: {
      startIndex: 0,
      endIndex: content.length,
      rawSpan: { start: 0, end: content.length },
      vectorSpan: { start: 0, end: content.length },
      filePath,
      language: 'typescript',
      contextPath: [filePath],
    },
  };
}

function makeResult(path: string, hash: string, content: string): ProcessResult {
  return {
    absPath: path,
    relPath: path,
    hash,
    content,
    chunks: [makeChunk(path, content)],
    language: 'typescript',
    mtime: 1,
    size: content.length,
    status: 'added',
  };
}

describe('Indexer exact index consistency', () => {
  it('counts exact index write failure as indexing error and does not update vector_index_hash', async () => {
    const db = initTestDb();
    try {
      db.prepare(
        'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      ).run('src/example.ts', 'hash-1', 1, 18, 'export const ok = 1;', 'typescript');
      db.exec('DROP TABLE exact_grams');

      const indexer = new Indexer('test-project', 2) as unknown as {
        embeddingClient: { embedBatch: (...args: unknown[]) => Promise<Array<{ embedding: number[] }>> };
        vectorStore: { batchUpsertFiles: (...args: unknown[]) => Promise<void> };
        indexFiles: Indexer['indexFiles'];
      };
      indexer.embeddingClient = {
        embedBatch: async () => [{ embedding: [0.1, 0.2] }],
      };
      indexer.vectorStore = {
        batchUpsertFiles: async () => {},
      };

      const result = await indexer.indexFiles(db, [
        makeResult('src/example.ts', 'hash-1', 'export const ok = 1;'),
      ]);

      assert.equal(result.errors, 1);
      assert.equal(result.indexed, 0);
      const row = db.prepare('SELECT vector_index_hash FROM files WHERE path = ?').get('src/example.ts') as {
        vector_index_hash: string | null;
      };
      assert.equal(row.vector_index_hash, null);
    } finally {
      db.close();
    }
  });

  it('retries exact index write after a previous exact index failure', async () => {
    const db = initTestDb();
    try {
      const projectId = 'test-project';
      const filePath = 'src/retry-example.ts';
      const hash = 'hash-retry-1';
      const technicalTerm = 'retryExactTerm';
      const content = `export const ${technicalTerm} = true;`;

      db.prepare(
        'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      ).run(filePath, hash, 1, content.length, content, 'typescript');

      let embedBatchCalls = 0;
      let vectorUpsertCalls = 0;
      const indexer = new Indexer(projectId, 2) as unknown as {
        embeddingClient: { embedBatch: (...args: unknown[]) => Promise<Array<{ embedding: number[] }>> };
        vectorStore: { batchUpsertFiles: (...args: unknown[]) => Promise<void> };
        indexFiles: Indexer['indexFiles'];
      };
      indexer.embeddingClient = {
        embedBatch: async () => {
          embedBatchCalls++;
          return [{ embedding: [0.1, 0.2] }];
        },
      };
      indexer.vectorStore = {
        batchUpsertFiles: async () => {
          vectorUpsertCalls++;
        },
      };

      db.exec('DROP TABLE exact_grams');

      const firstResult = await indexer.indexFiles(db, [makeResult(filePath, hash, content)]);

      assert.equal(firstResult.errors, 1);
      assert.equal(firstResult.indexed, 0);
      assert.equal(getFilesNeedingVectorIndex(db).includes(filePath), true);
      const afterFirst = db.prepare('SELECT vector_index_hash FROM files WHERE path = ?').get(filePath) as {
        vector_index_hash: string | null;
      };
      assert.equal(afterFirst.vector_index_hash, null);

      initExactIndex(db);

      const secondResult = await indexer.indexFiles(db, [makeResult(filePath, hash, content)]);

      assert.equal(secondResult.errors, 0);
      assert.equal(secondResult.indexed, 1);
      assert.equal(embedBatchCalls, 2);
      assert.equal(vectorUpsertCalls, 2);
      assert.equal(getFilesNeedingVectorIndex(db).includes(filePath), false);
      const afterSecond = db.prepare('SELECT vector_index_hash FROM files WHERE path = ?').get(filePath) as {
        vector_index_hash: string | null;
      };
      assert.equal(afterSecond.vector_index_hash, hash);

      const exactResult = searchExactIndex(db, projectId, [technicalTerm]);
      assert.equal(exactResult.hits.length, 1);
      assert.equal(exactResult.hits[0].chunk.file_path, filePath);
      assert.deepEqual(exactResult.missingExactTechnicalTerms, []);
    } finally {
      db.close();
    }
  });
});
