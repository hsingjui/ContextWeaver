import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  batchDeleteExactIndex,
  batchUpsertExactIndex,
  clearProjectExactIndex,
  initExactIndex,
  searchExactIndex,
} from './exactIndex.js';
import { SearchService } from './SearchService.js';
import type { ScoredChunk } from './types.js';
import { collectExactTechnicalTermMatches, EXACT_RESERVED_SEEDS, type SearchableChunk } from './exactTechnicalTerms.js';

function chunk(chunk_index: number, text: string): SearchableChunk {
  return {
    file_path: `fixture-${chunk_index}.txt`,
    chunk_index,
    display_code: text,
  };
}

function withExactDb(
  rows: Array<{ chunkId: string; content: string; displayCode?: string }>,
  run: (db: Database.Database) => void,
): void {
  const db = new Database(':memory:');
  try {
    initExactIndex(db);
    batchUpsertExactIndex(
      db,
      'test-project',
      rows.map((row, index) => ({
        chunkId: row.chunkId,
        filePath: `fixture-${index}.txt`,
        fileHash: `hash-${index}`,
        chunkIndex: index,
        startLine: 1,
        endLine: 1,
        rawStart: 0,
        rawEnd: row.content.length,
        content: row.content,
        displayCode: row.displayCode ?? row.content,
      })),
    );
    run(db);
  } finally {
    db.close();
  }
}

describe('collectExactTechnicalTermMatches fixed-string fixtures', () => {
  it('does not match @ControllerAdvice as @RestController', () => {
    const result = collectExactTechnicalTermMatches(
      [chunk(0, '@RestController\nclass DemoController {}')],
      ['@ControllerAdvice'],
    );

    assert.equal(result.matches.length, 0);
    assert.deepEqual(result.missingExactTechnicalTerms, ['@ControllerAdvice']);
  });

  it('does not match useQuery() as useQueryClient', () => {
    const result = collectExactTechnicalTermMatches(
      [chunk(0, 'const client = useQueryClient();')],
      ['useQuery()'],
    );

    assert.equal(result.matches.length, 0);
    assert.deepEqual(result.missingExactTechnicalTerms, ['useQuery()']);
  });

  it('does not match R.failed only because failed is present', () => {
    const result = collectExactTechnicalTermMatches(
      [chunk(0, 'return failed(error);')],
      ['R.failed'],
    );

    assert.equal(result.matches.length, 0);
    assert.deepEqual(result.missingExactTechnicalTerms, ['R.failed']);
  });

  it('puts nonexistent terms into missingExactTechnicalTerms', () => {
    const result = collectExactTechnicalTermMatches([chunk(0, 'const ok = true;')], ['NotThere']);

    assert.equal(result.matches.length, 0);
    assert.deepEqual(result.missingExactTechnicalTerms, ['NotThere']);
  });
});



describe('searchExactIndex SQLite-backed fixed-string fixtures', () => {
  it('does not match @ControllerAdvice as @RestController', () => {
    withExactDb([{ chunkId: 'c0', content: '@RestController\nclass DemoController {}' }], (db) => {
      const result = searchExactIndex(db, 'test-project', ['@ControllerAdvice']);

      assert.equal(result.hits.length, 0);
      assert.deepEqual(result.missingExactTechnicalTerms, ['@ControllerAdvice']);
    });
  });

  it('does not match useQuery() as useQueryClient', () => {
    withExactDb([{ chunkId: 'c0', content: 'const client = useQueryClient();' }], (db) => {
      const result = searchExactIndex(db, 'test-project', ['useQuery()']);

      assert.equal(result.hits.length, 0);
      assert.deepEqual(result.missingExactTechnicalTerms, ['useQuery()']);
    });
  });

  it('does not match R.failed only because failed is present', () => {
    withExactDb([{ chunkId: 'c0', content: 'return failed(error);' }], (db) => {
      const result = searchExactIndex(db, 'test-project', ['R.failed']);

      assert.equal(result.hits.length, 0);
      assert.deepEqual(result.missingExactTechnicalTerms, ['R.failed']);
    });
  });

  it('puts nonexistent terms into missingExactTechnicalTerms', () => {
    withExactDb([{ chunkId: 'c0', content: 'const ok = true;' }], (db) => {
      const result = searchExactIndex(db, 'test-project', ['NotThere']);

      assert.equal(result.hits.length, 0);
      assert.deepEqual(result.missingExactTechnicalTerms, ['NotThere']);
    });
  });

  it('finds exact raw substring hits via exact_grams candidates', () => {
    withExactDb([{ chunkId: 'c0', content: 'const value = useQuery();' }], (db) => {
      const result = searchExactIndex(db, 'test-project', ['useQuery()']);

      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0].chunk.chunk_id, 'c0');
      assert.deepEqual(result.missingExactTechnicalTerms, []);
      assert.deepEqual(result.exactSearchSource, ['exact_chunks']);
    });
  });

  it('finds 2-character terms that appear only in displayCode via scanCandidates', () => {
    withExactDb([{ chunkId: 'c0', content: 'const value = noDisplayOnlyTerm;', displayCode: 'xy' }], (db) => {
      const result = searchExactIndex(db, 'test-project', ['xy']);

      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0].chunk.chunk_id, 'c0');
      assert.deepEqual(result.hits[0].matchedTerms, ['xy']);
      assert.deepEqual(result.missingExactTechnicalTerms, []);
    });
  });

});


describe('exact index legacy schema migration', () => {
  it('recreates legacy exact tables without project_id and keeps exact index usable', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE exact_chunks (
          chunk_id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          file_hash TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          raw_start INTEGER NOT NULL,
          raw_end INTEGER NOT NULL,
          content TEXT NOT NULL,
          display_code TEXT NOT NULL
        );
        CREATE TABLE exact_grams (
          gram TEXT NOT NULL,
          chunk_id TEXT NOT NULL,
          PRIMARY KEY (gram, chunk_id)
        );
      `);

      initExactIndex(db);

      const exactChunkColumns = db.prepare('PRAGMA table_info(exact_chunks)').all() as Array<{ name: string }>;
      const exactGramColumns = db.prepare('PRAGMA table_info(exact_grams)').all() as Array<{ name: string }>;
      assert.equal(exactChunkColumns.some((column) => column.name === 'project_id'), true);
      assert.equal(exactGramColumns.some((column) => column.name === 'project_id'), true);

      batchUpsertExactIndex(db, 'test-project', [
        {
          chunkId: 'migrated-c0',
          filePath: 'migrated/file.ts',
          fileHash: 'migrated-hash',
          chunkIndex: 0,
          startLine: 1,
          endLine: 1,
          rawStart: 0,
          rawEnd: 28,
          content: 'const migratedExactTerm = true;',
          displayCode: 'const migratedExactTerm = true;',
        },
      ]);

      const result = searchExactIndex(db, 'test-project', ['migratedExactTerm']);
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0].chunk.chunk_id, 'migrated-c0');
      assert.deepEqual(result.missingExactTechnicalTerms, []);
    } finally {
      db.close();
    }
  });
});



describe('exact index project isolation', () => {
  function upsertProjectChunk(db: Database.Database, projectId: string, content: string): void {
    batchUpsertExactIndex(db, projectId, [
      {
        chunkId: 'shared-chunk-id',
        filePath: 'shared/file.ts',
        fileHash: `${projectId}-hash`,
        chunkIndex: 0,
        startLine: 1,
        endLine: 1,
        rawStart: 0,
        rawEnd: content.length,
        content,
        displayCode: content,
      },
    ]);
  }

  it('keeps search, file delete, and project clear scoped by project_id', () => {
    const db = new Database(':memory:');
    try {
      initExactIndex(db);
      upsertProjectChunk(db, 'projectA', 'const value = projectAOnlyTerm;');
      upsertProjectChunk(db, 'projectB', 'const value = projectBOnlyTerm;');

      const projectASearch = searchExactIndex(db, 'projectA', ['projectAOnlyTerm', 'projectBOnlyTerm']);
      assert.deepEqual(
        projectASearch.hits.map((hit) => hit.chunk.file_path),
        ['shared/file.ts'],
      );
      assert.deepEqual(projectASearch.hits[0].matchedTerms, ['projectAOnlyTerm']);
      assert.deepEqual(projectASearch.missingExactTechnicalTerms, ['projectBOnlyTerm']);

      batchDeleteExactIndex(db, 'projectA', ['shared/file.ts']);
      assert.equal(searchExactIndex(db, 'projectA', ['projectAOnlyTerm']).hits.length, 0);
      assert.equal(searchExactIndex(db, 'projectB', ['projectBOnlyTerm']).hits.length, 1);

      upsertProjectChunk(db, 'projectA', 'const value = projectAOnlyTerm;');
      clearProjectExactIndex(db, 'projectA');
      assert.equal(searchExactIndex(db, 'projectA', ['projectAOnlyTerm']).hits.length, 0);
      assert.equal(searchExactIndex(db, 'projectB', ['projectBOnlyTerm']).hits.length, 1);
    } finally {
      db.close();
    }
  });
});


describe('exact index force cleanup', () => {
  it('clears only the current project exact index rows', () => {
    const db = new Database(':memory:');
    try {
      initExactIndex(db);
      const insert = (projectId: string, content: string) => {
        batchUpsertExactIndex(db, projectId, [
          {
            chunkId: `${projectId}-chunk`,
            filePath: 'src/shared.ts',
            fileHash: `${projectId}-hash`,
            chunkIndex: 0,
            startLine: 1,
            endLine: 1,
            rawStart: 0,
            rawEnd: content.length,
            content,
            displayCode: content,
          },
        ]);
      };

      insert('projectA', 'const value = projectAForceTerm;');
      insert('projectB', 'const value = projectBForceTerm;');

      clearProjectExactIndex(db, 'projectA');

      assert.equal(searchExactIndex(db, 'projectA', ['projectAForceTerm']).hits.length, 0);
      assert.equal(searchExactIndex(db, 'projectB', ['projectBForceTerm']).hits.length, 1);
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM exact_chunks WHERE project_id = ?').get('projectA') as { count: number }).count,
        0,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM exact_grams WHERE project_id = ?').get('projectA') as { count: number }).count,
        0,
      );
      assert.ok(
        (db.prepare('SELECT COUNT(*) AS count FROM exact_chunks WHERE project_id = ?').get('projectB') as { count: number }).count > 0,
      );
      assert.ok(
        (db.prepare('SELECT COUNT(*) AS count FROM exact_grams WHERE project_id = ?').get('projectB') as { count: number }).count > 0,
      );
    } finally {
      db.close();
    }
  });
});


describe('SearchService exact seed limit', () => {
  it('limits final exact seeds with EXACT_RESERVED_SEEDS', () => {
    const service = new SearchService('test-project', 'test-path') as unknown as {
      limitExactSeeds: (list: ScoredChunk[]) => ScoredChunk[];
    };
    const makeScoredChunk = (index: number, source: ScoredChunk['source']): ScoredChunk => ({
      filePath: `fixture-${index}.ts`,
      chunkIndex: index,
      score: 1,
      source,
      record: {
        chunk_id: `chunk-${index}`,
        file_path: `fixture-${index}.ts`,
        file_hash: `hash-${index}`,
        chunk_index: index,
        vector: [],
        display_code: 'const value = manyExactHits;',
        vector_text: 'const value = manyExactHits;',
        language: 'typescript',
        breadcrumb: '',
        start_index: 0,
        end_index: 1,
        raw_start: 0,
        raw_end: 1,
        vec_start: 0,
        vec_end: 1,
        _distance: 0,
      },
    });

    const manyExact = Array.from({ length: EXACT_RESERVED_SEEDS + 5 }, (_, index) =>
      makeScoredChunk(index, 'exact'),
    );
    const vectorSeed = makeScoredChunk(999, 'vector');
    const seeds = service.limitExactSeeds([...manyExact, vectorSeed]);

    assert.equal(seeds.filter((seed) => seed.source === 'exact').length, EXACT_RESERVED_SEEDS);
    assert.equal(seeds.some((seed) => seed.source === 'vector'), true);
  });
});
