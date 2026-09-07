import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { getDependencyEdges, initDependencyGraph } from '../src/db/index.js';
import { ensureDependencyGraph, rebuildDependencyGraph } from '../src/indexer/DependencyIndexer.js';
import { DEFAULT_CONFIG } from '../src/search/config.js';
import { GraphExpander } from '../src/search/GraphExpander.js';
import { buildRetrievalPlan } from '../src/search/RetrievalPlan.js';
import type { ScoredChunk } from '../src/search/types.js';
import type { ChunkRecord } from '../src/vectorStore/index.js';

function graphDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE files(path TEXT PRIMARY KEY, content TEXT)');
  const insert = db.prepare('INSERT INTO files(path, content) VALUES (?, ?)');
  insert.run('src/a.ts', "import { b } from './b.js';\nexport const a = b;");
  insert.run('src/b.ts', "import { c } from './c.js';\nexport const b = c;");
  insert.run('src/c.ts', 'export const c = 1;');
  insert.run('src/d.ts', "import { b } from './b.js';\nexport const d = b;");
  insert.run('src/public.ts', "export { b } from './b.js';");
  insert.run('src/lib.rs', 'pub mod helper;');
  insert.run('src/helper.rs', 'pub const VALUE: i32 = 1;');
  initDependencyGraph(db);
  return db;
}

function record(filePath: string): ChunkRecord {
  const code = `// ${filePath}`;
  return {
    chunk_id: `${filePath}#h#0`,
    file_path: filePath,
    file_hash: 'h',
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

function scored(filePath: string, score = 1): ScoredChunk {
  return {
    filePath,
    chunkIndex: 0,
    score,
    source: 'vector',
    record: { ...record(filePath), _distance: 0 },
  };
}

test('dependency graph is precomputed from existing language resolvers with reverse lookup', async () => {
  const db = graphDb();
  const edges = await rebuildDependencyGraph(db);
  assert.deepEqual(edges.map((edge) => `${edge.fromPath}->${edge.toPath}`).sort(), [
    'src/a.ts->src/b.ts',
    'src/b.ts->src/c.ts',
    'src/d.ts->src/b.ts',
    'src/lib.rs->src/helper.rs',
    'src/public.ts->src/b.ts',
  ]);
  assert.deepEqual(
    getDependencyEdges(db, ['src/b.ts'], 'forward').map((edge) => edge.toPath),
    ['src/c.ts'],
  );
  assert.deepEqual(
    getDependencyEdges(db, ['src/b.ts'], 'reverse')
      .map((edge) => edge.fromPath)
      .sort(),
    ['src/a.ts', 'src/d.ts', 'src/public.ts'],
  );
  assert.equal(edges.find((edge) => edge.fromPath === 'src/public.ts')?.kind, 'reexport');
  assert.equal(edges.find((edge) => edge.fromPath === 'src/lib.rs')?.kind, 'export');
  db.close();
});

test('dependency graph is versioned, clean scans are O(1), and changed sources update incrementally', async () => {
  const db = graphDb();
  assert.equal(await ensureDependencyGraph(db), 'rebuild', 'first graph-version upgrade rebuilds');
  db.prepare(
    "INSERT OR IGNORE INTO dependencies(from_path, to_path, kind) VALUES ('sentinel.ts', 'src/c.ts', 'import')",
  ).run();

  assert.equal(await ensureDependencyGraph(db), 'clean', 'clean current graph is not rebuilt');
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM dependencies WHERE from_path = 'sentinel.ts'")
        .get() as { count: number }
    ).count,
    1,
  );

  db.prepare("UPDATE files SET content = 'export const a = 1;' WHERE path = 'src/a.ts'").run();
  assert.equal(await ensureDependencyGraph(db, ['src/a.ts']), 'incremental');
  assert.deepEqual(getDependencyEdges(db, ['src/a.ts'], 'forward'), []);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM dependencies WHERE from_path = 'sentinel.ts'")
        .get() as { count: number }
    ).count,
    1,
    'unrelated edges survive an incremental update',
  );
  assert.deepEqual(
    getDependencyEdges(db, ['src/b.ts'], 'forward').map((edge) => edge.toPath),
    ['src/c.ts'],
  );
  db.close();
});

test('TypeScript type re-exports are kept as reexport edges even beside normal imports', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE files(path TEXT PRIMARY KEY, content TEXT)');
  const insert = db.prepare('INSERT INTO files(path, content) VALUES (?, ?)');
  insert.run('src/types.ts', 'export interface User { id: string }');
  insert.run('src/x.ts', 'export const x = 1;');
  insert.run('src/type-only.ts', "export type { User } from './types.js';");
  insert.run(
    'src/mixed.ts',
    "import { x } from './x.js';\nexport type { User } from './types.js';\nexport const y = x;",
  );
  initDependencyGraph(db);

  const edges = await rebuildDependencyGraph(db);
  assert.ok(
    edges.some(
      (edge) =>
        edge.fromPath === 'src/type-only.ts' &&
        edge.toPath === 'src/types.ts' &&
        edge.kind === 'reexport',
    ),
  );
  assert.ok(
    edges.some(
      (edge) =>
        edge.fromPath === 'src/mixed.ts' &&
        edge.toPath === 'src/types.ts' &&
        edge.kind === 'reexport',
    ),
  );
  assert.ok(
    edges.some(
      (edge) =>
        edge.fromPath === 'src/mixed.ts' && edge.toPath === 'src/x.ts' && edge.kind === 'import',
    ),
  );
  db.close();
});

test('commented-out JavaScript/TypeScript imports do not create dependency edges', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE files(path TEXT PRIMARY KEY, content TEXT)');
  const insert = db.prepare('INSERT INTO files(path, content) VALUES (?, ?)');
  insert.run('src/b.ts', 'export const b = 1;');
  insert.run(
    'src/a.ts',
    "// import { b } from './b.js';\nconst example = \"import { b } from './b.js'\";\nexport const a = example;",
  );
  initDependencyGraph(db);
  const edges = await rebuildDependencyGraph(db);
  assert.deepEqual(edges, []);
  db.close();
});

test('explicit empty dependency seeds do not fall back to reranked seeds', async () => {
  const db = graphDb();
  await rebuildDependencyGraph(db);
  const expander = new GraphExpander('dependency-empty-anchor-test', {
    ...DEFAULT_CONFIG,
    importFilesPerSeed: 0,
    graphFilesPerSeed: 4,
    graphChunksPerFile: 1,
    graphMaxDepth: 1,
  });
  Reflect.set(expander, 'db', db);
  Reflect.set(expander, 'vectorStore', {
    getFilesChunks: async (paths: string[]) =>
      new Map(paths.map((filePath) => [filePath, [record(filePath)]])),
  });
  Reflect.set(expander, 'init', async () => {});

  const result = await expander.expand([scored('src/a.ts')], undefined, {
    expandNeighbors: false,
    expandDependencies: true,
    dependencyDirection: 'forward',
    dependencySeeds: [],
    maxDependencyDepth: 1,
    maxDependencyFiles: 4,
    dependencyChunksPerFile: 1,
  });
  assert.equal(
    result.chunks.some((chunk) => chunk.source === 'dependency'),
    false,
  );
  db.close();
});

test('GraphExpander traverses dependency edges in bounded forward multi-hop mode', async () => {
  const db = graphDb();
  await rebuildDependencyGraph(db);
  const expander = new GraphExpander('dependency-test', {
    ...DEFAULT_CONFIG,
    graphFilesPerSeed: 4,
    graphChunksPerFile: 1,
    graphMaxDepth: 2,
  });
  Reflect.set(expander, 'db', db);
  Reflect.set(expander, 'vectorStore', {
    getFilesChunks: async (paths: string[]) =>
      new Map(paths.map((filePath) => [filePath, [record(filePath)]])),
  });
  const method = Reflect.get(expander, 'expandDependencyGraph') as (
    this: GraphExpander,
    seeds: ScoredChunk[],
    existingKeys: Set<string>,
    queryTokens: Set<string> | undefined,
    direction: 'forward' | 'reverse' | 'both',
    maxDepth: number,
  ) => Promise<ScoredChunk[]>;
  const chunks = await method.call(
    expander,
    [scored('src/a.ts')],
    new Set(['src/a.ts#0']),
    undefined,
    'forward',
    2,
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.filePath),
    ['src/b.ts', 'src/c.ts'],
  );
  assert.ok(chunks.every((chunk) => chunk.source === 'dependency'));
  assert.ok(chunks[1].score < chunks[0].score);
  db.close();
});

test('GraphExpander aggregates duplicate paths by max score instead of first path wins', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE files(path TEXT PRIMARY KEY, content TEXT)');
  db.exec(`
    INSERT INTO files(path, content) VALUES
      ('src/low.ts', ''), ('src/high.ts', ''), ('src/target.ts', '');
  `);
  initDependencyGraph(db);
  db.exec(`
    INSERT INTO dependencies(from_path, to_path, kind) VALUES
      ('src/low.ts', 'src/target.ts', 'import'),
      ('src/high.ts', 'src/target.ts', 'import');
  `);
  const expander = new GraphExpander('dependency-path-score-test', {
    ...DEFAULT_CONFIG,
    graphFilesPerSeed: 1,
    graphChunksPerFile: 1,
    graphMaxDepth: 1,
  });
  Reflect.set(expander, 'db', db);
  Reflect.set(expander, 'vectorStore', {
    getFilesChunks: async (paths: string[]) =>
      new Map(paths.map((filePath) => [filePath, [record(filePath)]])),
  });
  const method = Reflect.get(expander, 'expandDependencyGraph') as (
    this: GraphExpander,
    seeds: ScoredChunk[],
    existingKeys: Set<string>,
    queryTokens: Set<string> | undefined,
    direction: 'forward' | 'reverse' | 'both',
    maxDepth: number,
    maxFiles?: number,
    chunksPerFile?: number,
    dependencyDecay?: number,
  ) => Promise<ScoredChunk[]>;
  const chunks = await method.call(
    expander,
    [scored('src/low.ts', 0.2), scored('src/high.ts', 1)],
    new Set(['src/low.ts#0', 'src/high.ts#0']),
    undefined,
    'forward',
    1,
    1,
    1,
    0.5,
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].filePath, 'src/target.ts');
  assert.equal(chunks[0].score, 0.5);
  db.close();
});

test('GraphExpander applies graphFilesPerSeed as a per-seed quota', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE files(path TEXT PRIMARY KEY, content TEXT)');
  db.exec(`
    INSERT INTO files(path, content) VALUES
      ('src/a.ts', ''), ('src/b.ts', ''), ('src/x.ts', ''), ('src/y.ts', '');
  `);
  initDependencyGraph(db);
  db.exec(`
    INSERT INTO dependencies(from_path, to_path, kind) VALUES
      ('src/a.ts', 'src/x.ts', 'import'),
      ('src/b.ts', 'src/y.ts', 'import');
  `);
  const expander = new GraphExpander('dependency-per-seed-quota-test', {
    ...DEFAULT_CONFIG,
    graphFilesPerSeed: 1,
    graphChunksPerFile: 1,
    graphMaxDepth: 1,
  });
  Reflect.set(expander, 'db', db);
  Reflect.set(expander, 'vectorStore', {
    getFilesChunks: async (paths: string[]) =>
      new Map(paths.map((filePath) => [filePath, [record(filePath)]])),
  });
  const method = Reflect.get(expander, 'expandDependencyGraph') as (
    this: GraphExpander,
    seeds: ScoredChunk[],
    existingKeys: Set<string>,
    queryTokens: Set<string> | undefined,
    direction: 'forward' | 'reverse' | 'both',
    maxDepth: number,
    maxFiles?: number,
  ) => Promise<ScoredChunk[]>;
  const chunks = await method.call(
    expander,
    [scored('src/a.ts'), scored('src/b.ts')],
    new Set(['src/a.ts#0', 'src/b.ts#0']),
    undefined,
    'forward',
    1,
    1,
  );
  assert.deepEqual(chunks.map((chunk) => chunk.filePath).sort(), ['src/x.ts', 'src/y.ts']);
  db.close();
});

test('reference and call-chain plans choose reverse/both dependency traversal', () => {
  assert.equal(buildRetrievalPlan('谁调用了 SearchService？').dependencyDirection, 'reverse');
  assert.equal(buildRetrievalPlan('从 MCP 到 SearchService 的调用链').dependencyDirection, 'both');
  assert.equal(buildRetrievalPlan('定位 SearchService 的定义').expandDependencies, false);
});
