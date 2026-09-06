import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { EmbeddingClient } from '../src/api/embedding.js';
import { getParser } from '../src/chunking/ParserPool.js';
import { SemanticSplitter } from '../src/chunking/SemanticSplitter.js';
import { SourceAdapter } from '../src/chunking/SourceAdapter.js';
import { batchUpdateMtime, clear, getSharedDb } from '../src/db/index.js';
import { crawl } from '../src/scanner/crawler.js';
import { initFilter } from '../src/scanner/filter.js';
import { processFiles } from '../src/scanner/processor.js';
import { ContextPacker } from '../src/search/ContextPacker.js';
import { DEFAULT_CONFIG } from '../src/search/config.js';
import {
  batchUpsertChunkFts,
  batchUpsertFileFts,
  initChunksFts,
  initFilesFts,
  searchChunksFts,
  searchFilesFts,
} from '../src/search/fts.js';
import { getGraphExpander } from '../src/search/GraphExpander.js';
import { SearchService } from '../src/search/SearchService.js';
import type { ScoredChunk } from '../src/search/types.js';
import { decodeBuffer, detectEncoding } from '../src/utils/encoding.js';
import {
  type ChunkRecord,
  closeAllVectorStores,
  getVectorStore,
} from '../src/vectorStore/index.js';

// 隔离测试数据目录，避免写入真实 ~/.contextweaver
process.env.HOME = path.resolve('test-output', `home-regressions-${process.pid}`);

const project = `regression-${process.pid}`;
const fixture = path.resolve('test-output', project);

function record(index: number, filePath = 'file.ts', hash = 'hash'): ChunkRecord {
  return {
    chunk_id: `${filePath}#${hash}#${index}`,
    file_path: filePath,
    file_hash: hash,
    chunk_index: index,
    vector: [1, 0],
    display_code: '登录配置',
    vector_text: '登录配置',
    language: 'typescript',
    breadcrumb: filePath,
    start_index: index * 3,
    end_index: index * 3 + 3,
    raw_start: index * 3,
    raw_end: index * 3 + 3,
    vec_start: index * 3,
    vec_end: index * 3 + 3,
  };
}

function scored(chunk: ChunkRecord): ScoredChunk {
  return {
    filePath: chunk.file_path,
    chunkIndex: chunk.chunk_index,
    score: 1,
    source: 'vector',
    record: { ...chunk, _distance: 0 },
  };
}

test('all configured grammars load, parse and reuse cached parsers', async () => {
  for (const language of [
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
    'java',
    'c',
    'cpp',
    'c_sharp',
  ]) {
    const parser = await getParser(language);
    assert.ok(parser, language);
    assert.equal(parser.parse('').rootNode.endIndex, 0, language);
    assert.equal(await getParser(language), parser, language);
  }
  assert.equal(await getParser('unsupported-language'), null);
});

test('batchUpdateMtime requires and updates file size together with mtime', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      'CREATE TABLE files(path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL);',
    );
    db.prepare('INSERT INTO files VALUES (?, ?, ?)').run('file.ts', 1, 10);
    batchUpdateMtime(db, [{ path: 'file.ts', mtime: 2, size: 20 }]);
    assert.deepEqual(db.prepare('SELECT mtime, size FROM files').get(), { mtime: 2, size: 20 });
  } finally {
    db.close();
  }
});

test('FTS short Chinese / mixed queries, literal wildcards and force clear', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE files(path TEXT, content TEXT)');
    initFilesFts(db);
    initChunksFts(db);
    batchUpsertFileFts(db, [{ path: 'auth.ts', content: '登录配置 apiKey' }]);
    batchUpsertChunkFts(db, [
      {
        chunkId: 'auth#0',
        filePath: 'auth.ts',
        chunkIndex: 0,
        breadcrumb: 'auth',
        content: '登录配置 apiKey',
      },
    ]);
    assert.equal(searchFilesFts(db, '登录', 10)[0]?.path, 'auth.ts');
    assert.equal(searchChunksFts(db, '登录', 10)[0]?.chunkId, 'auth#0');
    assert.equal(searchChunksFts(db, '配置 apiKey', 10)[0]?.chunkId, 'auth#0');
    assert.equal(searchFilesFts(db, 'apiKey', 10)[0]?.path, 'auth.ts');
    batchUpsertFileFts(db, [{ path: 'auth.ts', content: '登出配置' }]);
    assert.deepEqual(searchFilesFts(db, '登录', 10), []);
    assert.equal(searchFilesFts(db, '登出', 10)[0]?.path, 'auth.ts');
    assert.deepEqual(searchFilesFts(db, '不存在', 10), []);
    assert.deepEqual(searchFilesFts(db, '%', 10), []);
    assert.equal(searchFilesFts(db, '登录', 0).length, 0);
    clear(db);
    for (const table of [
      'files',
      'files_fts',
      'chunks_fts',
      'fts_short_tokens',
      'fts_short_records',
      'fts_short_tokens_meta',
    ]) {
      assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    }
  } finally {
    db.close();
  }
});

test('UTF-8 metadata is UTF-16 and raw spans reconstruct Chinese / emoji source', async () => {
  const code = '// 中文😀\nconst first = "登录";\nconst second = "配置";\n';
  const splitter = new SemanticSplitter({ maxChunkSize: 15, minChunkSize: 1 });
  // Exercise byte-domain output independently of the installed parser's domain.
  Reflect.set(splitter, 'code', code);
  Reflect.set(splitter, 'adapter', new SourceAdapter({ code, endIndex: Buffer.byteLength(code) }));
  const boundary = code.indexOf('const second');
  const byteBoundary = Buffer.byteLength(code.slice(0, boundary));
  const chunks = Reflect.get(splitter, 'windowsToChunks').call(
    splitter,
    [
      { nodes: [{ startIndex: 0, endIndex: byteBoundary }], size: 20, contextPath: ['file.ts'] },
      {
        nodes: [{ startIndex: byteBoundary, endIndex: Buffer.byteLength(code) }],
        size: 20,
        contextPath: ['file.ts'],
      },
    ],
    'file.ts',
    'typescript',
  );
  assert.equal(chunks[1].metadata.startIndex, boundary);
  assert.equal(
    chunks
      .map((c: { metadata: { rawSpan: { start: number; end: number } } }) =>
        code.slice(c.metadata.rawSpan.start, c.metadata.rawSpan.end),
      )
      .join(''),
    code,
  );
  const byteSplitter = new SemanticSplitter();
  Reflect.set(byteSplitter, 'visitNode', () => []);
  const originalInfo = console.info;
  console.info = () => assert.fail('splitter wrote to stdout');
  try {
    byteSplitter.split(
      { rootNode: { endIndex: Buffer.byteLength(code) } } as Parameters<
        SemanticSplitter['split']
      >[0],
      code,
      'file.ts',
      'typescript',
    );
  } finally {
    console.info = originalInfo;
  }
  const parser = await getParser('typescript');
  assert.ok(parser);
  const tree = parser.parse(code);
  const actual = splitter.split(tree, code, 'file.ts', 'typescript');
  assert.equal(
    actual.map((c) => code.slice(c.metadata.rawSpan.start, c.metadata.rawSpan.end)).join(''),
    code,
  );
  console.error(
    `Parser domain: root=${tree.rootNode.endIndex}, utf16=${code.length}, utf8=${Buffer.byteLength(code)}`,
  );
});

test('shared DB, idempotent vector retry, expansion after stores close and file index refresh', async () => {
  process.env.EMBEDDINGS_API_KEY = 'test';
  process.env.EMBEDDINGS_BASE_URL = 'https://example.invalid';
  process.env.EMBEDDINGS_MODEL = 'test';
  process.env.EMBEDDINGS_DIMENSIONS = '2';
  const db = getSharedDb(project);
  assert.equal(db, getSharedDb(project));
  const store = await getVectorStore(project, 2);
  const records = [record(0), record(1)];
  await store.batchUpsertFiles([{ path: 'file.ts', hash: 'hash', records }]);
  await store.batchUpsertFiles([{ path: 'file.ts', hash: 'hash', records }]);
  assert.equal((await store.getFileChunks('file.ts')).length, 2);
  await store.upsertFile('file.ts', 'hash', records);
  assert.equal((await store.getFileChunks('file.ts')).length, 2);
  const batch = Array.from({ length: 51 }, (_, i) => ({
    path: `batch-${i}.ts`,
    hash: 'h',
    records: [record(0, `batch-${i}.ts`, 'h')],
  }));
  const table = Reflect.get(store, 'table');
  const add = table.add.bind(table);
  // 模拟历史重复行，并确认重试会收敛。
  await add(records);
  assert.equal((await store.getFileChunks('file.ts')).length, 4);
  await store.upsertFile('file.ts', 'hash', records);
  assert.equal((await store.getFileChunks('file.ts')).length, 2);
  table.add = async () => {
    throw new Error('injected write failure');
  };
  try {
    await assert.rejects(store.upsertFile('file.ts', 'hash', records), /injected/);
    assert.equal((await store.getFileChunks('file.ts')).length, 2);
    await assert.rejects(
      store.batchUpsertFiles([{ path: 'file.ts', hash: 'hash', records }]),
      /injected/,
    );
    assert.equal((await store.getFileChunks('file.ts')).length, 2);
  } finally {
    table.add = add;
  }
  await store.upsertFile('file.ts', 'hash', records);
  assert.deepEqual(
    (await store.getFileChunks('file.ts')).map((r) => r.file_hash),
    ['hash', 'hash'],
  );
  let writes = 0;
  table.add = async (...args: unknown[]) => {
    if (++writes === 2) throw new Error('injected batch failure');
    return add(...args);
  };
  try {
    await assert.rejects(store.batchUpsertFiles(batch), /injected/);
  } finally {
    table.add = add;
  }
  await store.batchUpsertFiles(batch);
  for (const file of batch) assert.equal((await store.getFileChunks(file.path)).length, 1);
  const config = { ...DEFAULT_CONFIG, importFilesPerSeed: 1, chunksPerImportFile: 1 };
  const expander = await getGraphExpander(project, config);
  assert.ok((await expander.expand([scored(records[0])])).chunks.some((c) => c.chunkIndex === 1));
  await closeAllVectorStores();
  db.prepare('INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'new.ts',
    'h',
    0,
    0,
    '',
    'typescript',
    'h',
  );
  assert.ok((await expander.expand([scored(records[0])])).chunks.some((c) => c.chunkIndex === 1));
  assert.ok(Reflect.get(expander, 'allFilePaths').has('new.ts'));
  const reopened = await getVectorStore(project, 2);
  await reopened.batchUpsertFiles([
    { path: 'file.ts', hash: 'hash', records: [] },
    { path: 'new.ts', hash: 'h', records: [record(0, 'new.ts', 'h')] },
  ]);
  assert.equal((await reopened.getFileChunks('file.ts')).length, 0);
  for (const file of ['a.ts', 'b.ts']) {
    db.prepare('INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      file,
      'h',
      0,
      0,
      "import './new';",
      'typescript',
      'h',
    );
  }
  const imports = await expander.expand([
    { ...scored(record(0, 'a.ts')), score: 0.3 },
    { ...scored(record(0, 'b.ts')), score: 0.9 },
  ]);
  assert.equal(imports.stats.importCount, 1);
  assert.equal(
    imports.chunks.find((c) => c.filePath === 'new.ts')?.score,
    0.9 * config.decayImport,
  );
  await closeAllVectorStores();
});

test('crawler prunes ignored dirs but respects negation; all allowed files get chunks', async () => {
  await fs.mkdir(path.join(fixture, 'ignored'), { recursive: true });
  await fs.mkdir(path.join(fixture, 'nested'), { recursive: true });
  await fs.writeFile(path.join(fixture, '.gitignore'), 'ignored/\nnested/*\n!nested/keep.yaml\n');
  await fs.writeFile(path.join(fixture, 'ignored', 'hidden.ts'), 'const hidden = 1;');
  const names = [
    'yaml',
    'yml',
    'toml',
    'xml',
    'html',
    'css',
    'scss',
    'sql',
    'sh',
    'vue',
    'svelte',
    'php',
    'rb',
    'swift',
    'kt',
    'dart',
    'lua',
    'r',
    'mts',
    'cts',
  ].map((ext) => `file.${ext}`);
  names.push('nested/keep.yaml');
  for (const name of names) await fs.writeFile(path.join(fixture, name), 'const value = "中文";\n');
  await initFilter(fixture);
  const paths = await crawl(fixture);
  assert.deepEqual([...paths].sort(), names.sort());
  const results = await processFiles(fixture, paths, new Map());
  assert.ok(results.every((r) => r.chunks.length > 0));
  await fs.writeFile(path.join(fixture, 'ascii.txt'), 'plain ASCII\n');
  assert.equal(detectEncoding(await fs.readFile(path.join(fixture, 'ascii.txt'))), 'UTF-8');
  await fs.writeFile(
    path.join(fixture, 'utf16.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]),
  );
  assert.equal(decodeBuffer(await fs.readFile(path.join(fixture, 'utf16.txt'))), '中文');
  await fs.rm(fixture, { recursive: true, force: true });
});

test('IGNORE_PATTERNS overrides .gitignore and built-in defaults', async () => {
  await fs.mkdir(path.join(fixture, 'ignored'), { recursive: true });
  await fs.mkdir(path.join(fixture, 'dist'), { recursive: true });
  // dist 是内置默认忽略项，ignored/ 来自 .gitignore
  await fs.writeFile(path.join(fixture, '.gitignore'), 'ignored/\n');
  await fs.writeFile(path.join(fixture, 'ignored', 'keep.ts'), 'const keep = 1;');
  await fs.writeFile(path.join(fixture, 'dist', 'app.ts'), 'const app = 1;');
  process.env.IGNORE_PATTERNS = '!ignored/,!ignored/keep.ts,!dist';
  try {
    await initFilter(fixture);
    const paths = await crawl(fixture);
    assert.deepEqual([...paths].sort(), ['dist/app.ts', 'ignored/keep.ts']);
  } finally {
    delete process.env.IGNORE_PATTERNS;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('crawl returns relative /-separated paths; extension and ignore semantics hold', async () => {
  await fs.mkdir(path.join(fixture, 'weird.dir'), { recursive: true });
  await fs.mkdir(path.join(fixture, 'ignored'), { recursive: true });
  await fs.writeFile(path.join(fixture, '.gitignore'), 'ignored/\n');
  await fs.writeFile(path.join(fixture, 'keep.ts'), 'const keep = 1;\n');
  await fs.writeFile(path.join(fixture, 'weird.dir', 'inner.ts'), 'const inner = 1;\n');
  await fs.writeFile(path.join(fixture, 'weird.dir', 'noext'), 'no extension\n');
  await fs.writeFile(path.join(fixture, '.env'), 'SECRET=1\n');
  await fs.writeFile(path.join(fixture, 'img.png'), 'binary\n');
  await fs.writeFile(path.join(fixture, 'ignored', 'hidden.ts'), 'const hidden = 1;\n');
  await initFilter(fixture);
  const paths = await crawl(fixture);
  assert.deepEqual([...paths].sort(), ['keep.ts', 'weird.dir/inner.ts']);
  for (const p of paths) {
    assert.ok(!path.isAbsolute(p) && !p.includes('\\') && !p.includes('..'));
  }
  const results = await processFiles(fixture, paths, new Map());
  const byPath = new Map(results.map((r) => [r.relPath, r]));
  assert.equal(byPath.get('keep.ts')?.content, 'const keep = 1;\n');
  assert.equal(byPath.get('weird.dir/inner.ts')?.content, 'const inner = 1;\n');
  assert.ok(results.every((r) => r.chunks.length > 0));
  await fs.rm(fixture, { recursive: true, force: true });
});

test('crawl keeps directory structure for relative roots', async () => {
  await fs.mkdir(path.join(fixture, 'src/deep'), { recursive: true });
  await fs.writeFile(path.join(fixture, 'a.ts'), 'const a = 1;\n');
  await fs.writeFile(path.join(fixture, 'src/deep/c.ts'), 'const c = 1;\n');
  const cwd = process.cwd();
  process.chdir(fixture);
  try {
    const filter = await initFilter('.');
    assert.deepEqual((await crawl('.', filter)).sort(), ['a.ts', 'src/deep/c.ts']);
  } finally {
    process.chdir(cwd);
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('unreadable nested .gitignore degrades to no rules instead of crashing the crawl', async () => {
  // 目录形式的 .gitignore 会让 readFileSync 抛 EISDIR，非 ENOENT 不允许冒泡到 fdir 回调。
  await fs.mkdir(path.join(fixture, 'locked/.gitignore'), { recursive: true });
  await fs.writeFile(path.join(fixture, 'locked/x.ts'), 'const x = 1;\n');
  await initFilter(fixture);
  assert.deepEqual(await crawl(fixture), ['locked/x.ts']);
  await fs.rm(fixture, { recursive: true, force: true });
});

test('built-in exclude list: whitelist gates noise, live patterns still exclude', async () => {
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'keep.ts'), 'const keep = 1;\n');
  const noise = [
    'yarn.lock',
    'Cargo.lock',
    'Gemfile.lock',
    'poetry.lock',
    'composer.lock',
    'bun.lockb',
    'logo.png',
    'banner.svg',
    'icon.ico',
    'font.woff2',
    'clip.mp4',
    'doc.pdf',
    'data.zip',
    'dump.tar.gz',
    'lib.so',
    'native.dll',
    'run.exe',
    'cache.pyc',
    'bundle.wasm',
    'app.log',
    'spec.snap',
    'sourcemap.map',
    'Thumbs.db',
    '.DS_Store',
  ];
  const live = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'bundle.min.js',
    'bundle.min.css',
    'schema.generated.ts',
    'schema.generated.js',
    'pb.pb.go',
    'pb.pb.ts',
  ];
  for (const name of [...noise, ...live]) {
    await fs.writeFile(path.join(fixture, name), 'noise\n');
  }
  // 点开头目录剪枝：例外目录及点文件仍可索引。
  for (const dir of [
    '.github/workflows',
    '.storybook',
    '.circleci',
    '.devcontainer',
    '.turbo',
    '.history',
  ]) {
    await fs.mkdir(path.join(fixture, dir), { recursive: true });
  }
  await fs.writeFile(path.join(fixture, '.github', 'workflows', 'ci.yml'), 'jobs: {}\n');
  await fs.writeFile(path.join(fixture, '.storybook', 'main.ts'), 'export default {};\n');
  await fs.writeFile(path.join(fixture, '.circleci', 'config.yml'), 'version: 2.1\n');
  await fs.writeFile(path.join(fixture, '.devcontainer', 'devcontainer.json'), '{}\n');
  await fs.writeFile(path.join(fixture, '.gitlab-ci.yml'), 'stages: []\n');
  await fs.writeFile(path.join(fixture, '.turbo', 'daemon.ts'), 'noise\n');
  await fs.writeFile(path.join(fixture, '.history', 'keep.ts.bak.ts'), 'noise\n');
  await initFilter(fixture);
  const paths = await crawl(fixture);
  assert.deepEqual([...paths].sort(), [
    '.circleci/config.yml',
    '.devcontainer/devcontainer.json',
    '.github/workflows/ci.yml',
    '.gitlab-ci.yml',
    '.storybook/main.ts',
    'keep.ts',
  ]);
  await fs.rm(fixture, { recursive: true, force: true });
});

test('packing line cursor and rerank long-line budget', () => {
  const packer = new ContextPacker(project, DEFAULT_CONFIG);
  const content = '中文\nabc\ndef\nghi';
  const first = record(0);
  first.raw_start = 0;
  first.raw_end = 2;
  const second = record(1);
  second.raw_start = 7;
  second.raw_end = content.length;
  const segments = Reflect.get(packer, 'mergeAndSlice').call(
    packer,
    [scored(second), scored(first)],
    content,
  );
  assert.deepEqual(
    segments.map((s: { startLine: number; endLine: number }) => [s.startLine, s.endLine]),
    [
      [1, 1],
      [3, 4],
    ],
  );
  const search = new SearchService(project, fixture);
  for (const text of ['hit'.repeat(1000), `before\n${'hit'.repeat(1000)}\nafter`]) {
    assert.ok(
      Reflect.get(search, 'extractAroundHit').call(search, text, new Set(['hit']), 100).length <=
        100,
    );
  }
});

test('persistent 429 retries stop and release every acquired slot', async () => {
  const client = new EmbeddingClient({
    apiKey: 'test',
    baseUrl: 'https://example.invalid',
    model: 'test',
    maxConcurrency: 1,
    dimensions: 2,
  });
  let acquired = 0;
  let released = 0;
  let attempts = 0;
  Reflect.set(client, 'rateLimiter', {
    acquire: async () => {
      acquired++;
    },
    releaseSuccess: () => {
      released++;
    },
    releaseForRetry: () => {
      released++;
    },
    releaseFailure: () => {
      released++;
    },
    triggerRateLimit: async () => {},
  });
  Reflect.set(client, 'processBatch', async () => {
    attempts++;
    throw new Error('429 quota exhausted');
  });
  await assert.rejects(client.embedBatch(['test']), /429/);
  assert.equal(attempts, 4);
  assert.equal(acquired, released);
});
