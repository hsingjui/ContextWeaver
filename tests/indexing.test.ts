import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { EmbeddingClient } from '../src/api/embedding.js';
import { getParser } from '../src/chunking/ParserPool.js';
import { SemanticSplitter } from '../src/chunking/SemanticSplitter.js';
import {
  batchUpsert,
  closeDb,
  type FileMeta,
  generateProjectId,
  getFilesNeedingVectorIndex,
  getPendingDeletions,
  initDb,
} from '../src/db/index.js';
import { Indexer } from '../src/indexer/index.js';
import { crawl } from '../src/scanner/crawler.js';
import { initFilter } from '../src/scanner/filter.js';
import { scan } from '../src/scanner/index.js';
import { getMaxFileSize, processFiles } from '../src/scanner/processor.js';
import { batchUpsertChunkFts, initChunksFts } from '../src/search/fts.js';
import { closeAllVectorStores, getVectorStore, VectorStore } from '../src/vectorStore/index.js';

// 隔离测试数据目录，避免写入真实 ~/.contextweaver
process.env.HOME = path.resolve('test-output', `home-indexing-${process.pid}`);

const fixture = path.resolve('test-output', `indexing-${process.pid}`);
const config = {
  apiKey: 'mock',
  baseUrl: 'https://example.invalid',
  model: 'mock',
  dimensions: 2,
  maxConcurrency: 2,
};
function configure(): void {
  Object.assign(process.env, {
    EMBEDDINGS_API_KEY: config.apiKey,
    EMBEDDINGS_BASE_URL: config.baseUrl,
    EMBEDDINGS_MODEL: config.model,
    EMBEDDINGS_DIMENSIONS: '2',
    EMBEDDINGS_MAX_CONCURRENCY: '2',
  });
}
function response(input: string[]): Response {
  return Response.json({
    data: input.map((_, index) => ({ index, embedding: [1, 0] })),
    usage: { total_tokens: 1 },
  });
}

/** 断言 scan 进度序列有界且非递减（跨扫描/Embedding 阶段、跨批次），最终到 100。 */
function assertProgressMonotonic(progress: number[]): void {
  assert.ok(progress.length > 0, '应至少收到一次进度回调');
  for (const [k, value] of progress.entries()) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 100, `进度越界: ${value}`);
    if (k > 0) {
      assert.ok(value >= progress[k - 1], `进度倒退: ${progress[k - 1]} -> ${value}`);
    }
  }
  assert.equal(progress.at(-1), 100);
}

// Budget checks apply to the final embedding text, including its prefix.
test('all splitter exits are bounded, preserve Unicode/raw spans, and extract C declarators', async () => {
  const splitter = new SemanticSplitter({ maxChunkSize: 500, minChunkSize: 50, chunkOverlap: 40 });
  const parser = await getParser('typescript');
  assert.ok(parser);
  for (const code of [
    'x'.repeat(12000),
    `const value = "${'中文😀'.repeat(3000)}";`,
    `const a = 1;${' '.repeat(12000)}const b = 2;`,
    `/**${'comment '.repeat(3000)}*/\nconst value = 1;`,
    ' \n'.repeat(6000),
  ]) {
    for (const chunks of [
      splitter.splitPlainText(code, 'file.md', 'markdown'),
      splitter.split(parser.parse(code), code, 'file.ts', 'typescript'),
    ]) {
      assert.ok(chunks.length > 0);
      assert.equal(
        chunks.map((c) => code.slice(c.metadata.rawSpan.start, c.metadata.rawSpan.end)).join(''),
        code,
      );
      for (const chunk of chunks) {
        assert.ok(chunk.vectorText.length <= 2000, `oversized: ${chunk.vectorText.length}`);
        assert.ok(chunk.nwsSize <= 500);
        assert.equal(
          chunk.displayCode,
          code.slice(chunk.metadata.startIndex, chunk.metadata.endIndex),
        );
        assert.ok(
          chunk.vectorText.endsWith(
            code.slice(chunk.metadata.vectorSpan.start, chunk.metadata.vectorSpan.end),
          ),
        );
        assert.equal(chunk.vectorText.isWellFormed(), true);
      }
    }
  }
  assert.deepEqual(splitter.splitPlainText('', 'empty.ts', 'typescript'), []);
  const c = await getParser('c');
  assert.ok(c);
  const code = `int calculate_total(void) {\n${'  total += 1;\n'.repeat(100)}  return total;\n}`;
  const chunks = splitter.split(c.parse(code), code, 'file.c', 'c');
  assert.ok(chunks.every((chunk) => chunk.metadata.contextPath.includes('calculate_total')));
  assert.throws(() => new SemanticSplitter({ maxChunkSize: 0 }), /Invalid splitter/);
});

test('scanner routes TSX/C# and falls back on erroneous ASTs', async () => {
  const root = path.join(fixture, 'grammars');
  await fs.mkdir(root, { recursive: true });
  const jsx = 'export const App = () => <div>Hello <span>world</span></div>;';
  const tsxParsers = await Promise.all(Array.from({ length: 8 }, () => getParser('tsx')));
  assert.ok(tsxParsers.every((parser) => parser === tsxParsers[0]));
  assert.equal(tsxParsers[0]?.parse(jsx).rootNode.hasError, false);
  await fs.writeFile(path.join(root, 'App.tsx'), jsx);
  await fs.writeFile(path.join(root, 'App.cs'), 'class App { public int Run() { return 1; } }');
  await fs.writeFile(path.join(root, 'broken.ts'), 'function broken( {');
  const files = await crawl(root, await initFilter(root));
  const results = await processFiles(root, files, new Map());
  assert.equal(results.find((file) => file.relPath === 'App.cs')?.language, 'c_sharp');
  assert.ok(results.every((file) => file.chunks.length > 0));
  assert.deepEqual(
    results.find((file) => file.relPath === 'broken.ts')?.chunks[0].metadata.contextPath,
    ['broken.ts'],
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('Embedding validates and orders results; failure stops scheduling and drains workers', async () => {
  const original = globalThis.fetch;
  const client = new EmbeddingClient(config);
  try {
    globalThis.fetch = async (_url, options) => {
      assert.ok(options?.signal instanceof AbortSignal);
      return Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      });
    };
    assert.deepEqual(
      (await client.embedBatch(['a', 'b'])).map((result) => result.embedding),
      [
        [1, 0],
        [0, 1],
      ],
    );
    for (const [data, expectedError] of [
      [[], /result count mismatch/],
      [
        [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [1, 0] },
        ],
        /duplicate index/,
      ],
      [
        [
          { index: -1, embedding: [1, 0] },
          { index: 1, embedding: [1, 0] },
        ],
        /index out of range/,
      ],
      [
        [
          { index: 0, embedding: [1] },
          { index: 1, embedding: [1, 0] },
        ],
        /vector dimension mismatch.*expected=2.*actual=1/,
      ],
      [
        [
          { index: 0, embedding: [null, 0] },
          { index: 1, embedding: [1, 0] },
        ],
        /vector contains non-finite value/,
      ],
    ] as const) {
      globalThis.fetch = async () => Response.json({ data });
      await assert.rejects(client.embedBatch(['a', 'b']), expectedError);
    }
    let calls = 0;
    let active = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      const input: string[] = JSON.parse(String(options?.body)).input;
      if (input[0] === 'bad')
        return Response.json({ error: { message: 'invalid input' } }, { status: 400 });
      active++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return response(input);
    };
    await assert.rejects(
      client.embedBatch(['bad', 'good', 'not-started', 'not-started'], 1),
      /HTTP 400/,
    );
    assert.equal(active, 0);
    assert.equal(calls, 2);
    await assert.rejects(client.embedBatch(['a'], 0), /positive integer/);
    assert.throws(() => new EmbeddingClient({ ...config, maxConcurrency: 0 }), /positive integers/);
  } finally {
    globalThis.fetch = original;
  }
});

test('FTS replacement rollback keeps old rows and leaves failed files pending', async () => {
  configure();
  const db = initDb(`fts-failure-${process.pid}`);
  const file: FileMeta = {
    path: 'file.ts',
    hash: 'new',
    content: 'const value = 1;',
    language: 'typescript',
    size: 16,
    mtime: 1,
    vectorIndexHash: null,
  };
  batchUpsert(db, [file]);
  db.exec(`DROP TABLE chunks_fts;
    CREATE TABLE chunks_fts(chunk_id TEXT, file_path TEXT, chunk_index INTEGER, breadcrumb TEXT, content TEXT);
    INSERT INTO chunks_fts VALUES ('old', 'file.ts', 0, '', 'old');
    CREATE TRIGGER fail_chunk_insert BEFORE INSERT ON chunks_fts BEGIN SELECT RAISE(ABORT, 'injected FTS failure'); END;`);
  const indexer = new Indexer('mock', 2);
  Reflect.set(indexer, 'vectorStore', { batchUpsertFiles: async () => {} });
  Reflect.set(indexer, 'embeddingClient', {
    embedBatch: async (texts: string[]) =>
      texts.map((text, index) => ({ text, index, embedding: [1, 0] })),
  });
  const files = [
    {
      absPath: '',
      relPath: file.path,
      hash: file.hash,
      mtime: 1,
      size: 16,
      content: file.content,
      language: file.language,
      status: 'modified' as const,
      chunks: new SemanticSplitter().splitPlainText(file.content ?? '', file.path, file.language),
    },
  ];
  try {
    assert.equal((await indexer.indexFiles(db, files)).errors, 1);
    assert.deepEqual(getFilesNeedingVectorIndex(db), ['file.ts']);
    assert.deepEqual(db.prepare('SELECT chunk_id FROM chunks_fts').all(), [{ chunk_id: 'old' }]);
    db.exec('DROP TRIGGER fail_chunk_insert');
    assert.equal((await indexer.indexFiles(db, files)).indexed, 1);
    assert.deepEqual(getFilesNeedingVectorIndex(db), []);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM chunks_fts').get() as { n: number }).n, 1);

    db.exec(`DROP TABLE files_fts; CREATE TABLE files_fts(path TEXT, content TEXT);
      INSERT INTO files_fts VALUES ('file.ts', 'old');
      CREATE TRIGGER fail_file_insert BEFORE INSERT ON files_fts BEGIN SELECT RAISE(ABORT, 'injected file FTS failure'); END;`);
    assert.throws(() => batchUpsert(db, [{ ...file, hash: 'later' }]), /injected/);
    assert.deepEqual(db.prepare('SELECT hash FROM files').get(), { hash: 'new' });
    assert.deepEqual(db.prepare('SELECT content FROM files_fts').get(), { content: 'old' });
  } finally {
    closeDb(db);
  }
});

test('FTS upserts use one bulk delete and remain idempotent', () => {
  const db = new Database(':memory:');
  initChunksFts(db);
  const prepare = db.prepare.bind(db);
  let deleteRuns = 0;
  Reflect.set(db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('DELETE FROM chunks_fts')) {
      const run = statement.run.bind(statement);
      Reflect.set(statement, 'run', (...args: unknown[]) => {
        deleteRuns++;
        return run(...args);
      });
    }
    return statement;
  });
  const chunks = Array.from({ length: 4000 }, (_, i) => ({
    chunkId: `c${i}`,
    filePath: 'file.ts',
    chunkIndex: i,
    breadcrumb: 'file',
    content: 'const value = 1;',
  }));
  try {
    batchUpsertChunkFts(db, chunks);
    assert.equal(deleteRuns, 1);
    batchUpsertChunkFts(db, chunks, ['file.ts']);
    assert.equal(deleteRuns, 2);
    assert.equal(
      (db.prepare('SELECT COUNT(*) n FROM chunks_fts').get() as { n: number }).n,
      chunks.length,
    );
  } finally {
    db.close();
  }
});

test('scan retries deleted vectors, cleans skipped files, migrates models and avoids no-op writes', async () => {
  configure();
  const root = path.join(fixture, 'scan');
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'file.ts');
  const project = generateProjectId(root);
  const originalFetch = globalThis.fetch;
  const originalDelete = VectorStore.prototype.deleteFiles;
  let calls = 0;
  const models: string[] = [];
  globalThis.fetch = async (_url, options) => {
    calls++;
    const request = JSON.parse(String(options?.body));
    models.push(request.model);
    return response(request.input);
  };
  const db = initDb(project);
  try {
    await fs.writeFile(file, 'const value = 1;');
    assert.equal((await scan(root)).vectorIndex?.indexed, 1);
    db.exec(
      'CREATE TABLE updates(n INTEGER); CREATE TRIGGER count_updates AFTER UPDATE ON files BEGIN INSERT INTO updates VALUES (1); END;',
    );
    const before = calls;
    assert.equal((await scan(root)).unchanged, 1);
    assert.equal(calls, before);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM updates').get() as { n: number }).n, 0);

    process.env.EMBEDDINGS_MODEL = 'new-model';
    assert.equal((await scan(root)).vectorIndex?.indexed, 1);
    assert.equal(models.at(-1), 'new-model');
    await fs.unlink(file);
    VectorStore.prototype.deleteFiles = async () => {
      throw new Error('injected vector delete failure');
    };
    await assert.rejects(scan(root), /injected vector delete failure/);
    assert.deepEqual(getPendingDeletions(db), ['file.ts']);
    VectorStore.prototype.deleteFiles = originalDelete;
    assert.equal((await scan(root)).vectorIndex?.deleted, 1);
    assert.deepEqual(getPendingDeletions(db), []);
    assert.equal(await (await getVectorStore(project, 2)).count(), 0);
    await closeAllVectorStores();

    await fs.writeFile(file, 'const value = 2;');
    await scan(root);
    await fs.writeFile(file, 'x'.repeat(102401));
    assert.equal((await scan(root)).skipped, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n, 0);
    assert.equal(await (await getVectorStore(project, 2)).count(), 0);
    await closeAllVectorStores();

    process.env.MAX_FILE_SIZE_BYTES = '200000';
    assert.equal(getMaxFileSize(), 200000);
    assert.equal((await scan(root)).vectorIndex?.indexed, 1);
    delete process.env.MAX_FILE_SIZE_BYTES;
    await fs.writeFile(file, 'const value = 3;');
    await scan(root);
    await fs.unlink(file);
    await scan(root, { vectorIndex: false });
    assert.deepEqual(getPendingDeletions(db), ['file.ts']);
    assert.equal((await scan(root)).vectorIndex?.deleted, 1);
    assert.deepEqual(getPendingDeletions(db), []);
  } finally {
    globalThis.fetch = originalFetch;
    VectorStore.prototype.deleteFiles = originalDelete;
    delete process.env.MAX_FILE_SIZE_BYTES;
    configure();
    closeDb(db);
    await closeAllVectorStores();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scan commits bounded batches and retries only failed files', async () => {
  configure();
  const root = path.join(fixture, 'batches');
  await fs.mkdir(root, { recursive: true });
  for (let i = 0; i < 101; i++)
    await fs.writeFile(path.join(root, `file-${i}.ts`), `const value${i} = ${i};`);
  const db = initDb(generateProjectId(root));
  const originalFetch = globalThis.fetch;
  const observedFileCounts: number[] = [];
  let fail = true;
  globalThis.fetch = async (_url, options) => {
    const input: string[] = JSON.parse(String(options?.body)).input;
    observedFileCounts.push((db.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n);
    if (fail) {
      fail = false;
      return Response.json({ error: { message: 'injected invalid input' } }, { status: 400 });
    }
    return response(input);
  };
  try {
    const progress: number[] = [];
    const onProgress = (current: number) => progress.push(current);
    const first = await scan(root, { onProgress });
    assertProgressMonotonic(progress); // 覆盖 100+1 两批的批间边界
    assert.equal(observedFileCounts[0], 100);
    assert.equal(observedFileCounts.at(-1), 101);
    assert.equal(first.vectorIndex?.errors, 50);
    assert.equal(first.vectorIndex?.indexed, 51);
    assert.equal(getFilesNeedingVectorIndex(db).length, 50);
    progress.length = 0;
    const retry = await scan(root, { onProgress });
    assertProgressMonotonic(progress);
    assert.equal(retry.vectorIndex?.indexed, 50);
    assert.equal(retry.vectorIndex?.errors, 0);
    assert.deepEqual(getFilesNeedingVectorIndex(db), []);
  } finally {
    globalThis.fetch = originalFetch;
    closeDb(db);
    await closeAllVectorStores();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('nested ignore rules, IGNORE_PATTERNS overrides and separate repository snapshots are respected', async () => {
  const root = path.join(fixture, 'ignore');
  const other = path.join(fixture, 'other');
  for (const directory of ['sub/deep/cache', 'sub/cache', '[pkg]'])
    await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(
    path.join(root, 'sub/.gitignore'),
    '\uFEFFprivate.json\n \t \n/only.ts\ncache/   \n\\!secret.ts\n',
  );
  await fs.writeFile(path.join(root, 'sub/deep/.gitignore'), '!private.json\n');
  await fs.writeFile(path.join(root, '[pkg]/.gitignore'), 'secret.ts\n');
  for (const name of [
    'sub/private.json',
    'sub/only.ts',
    'sub/deep/only.ts',
    'sub/deep/private.json',
    'sub/cache/keep.ts',
    'sub/deep/cache/hidden.ts',
    'sub/!secret.ts',
    '[pkg]/secret.ts',
  ])
    await fs.writeFile(path.join(root, name), 'const value = 1;');
  const firstFilter = await initFilter(root);
  await initFilter(other);
  assert.deepEqual([...(await crawl(root, firstFilter))].sort(), [
    'sub/deep/only.ts',
    'sub/deep/private.json',
  ]);
  const previousOverrides = process.env.IGNORE_PATTERNS;
  process.env.IGNORE_PATTERNS = '!sub/cache/,!sub/cache/keep.ts';
  try {
    const paths = await crawl(root, await initFilter(root));
    assert.ok(paths.includes('sub/cache/keep.ts'));
    assert.ok(!paths.includes('sub/private.json'));
  } finally {
    if (previousOverrides === undefined) delete process.env.IGNORE_PATTERNS;
    else process.env.IGNORE_PATTERNS = previousOverrides;
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(other, { recursive: true, force: true });
});

test('generateProjectId 归一化路径拼写变体，同一目录产生同一 ID', async () => {
  const root = path.resolve('test-output', `IdNormalize-${process.pid}`);
  await fs.mkdir(root, { recursive: true });
  const id = generateProjectId(root);
  assert.equal(generateProjectId(`${root}/`), id);
  assert.equal(generateProjectId(`${root}/.`), id);

  const link = `${root}-link`;
  await fs.rm(link, { force: true });
  await fs.symlink(root, link);
  assert.equal(generateProjectId(link), id);

  // 大小写变体仅在大小写不敏感文件系统（macOS/Windows）上等价
  const variant = root.toUpperCase() === root ? root.toLowerCase() : root.toUpperCase();
  if (
    variant !== root &&
    (await fs
      .stat(variant)
      .then(() => true)
      .catch(() => false))
  ) {
    assert.equal(generateProjectId(variant), id);
  }

  await fs.rm(link, { force: true });
  await fs.rm(root, { recursive: true, force: true });
});

test('generateProjectId 不会合并大小写敏感文件系统上的不同目录', async () => {
  const base = path.resolve('test-output', `IdCase-${process.pid}`);
  const upper = path.join(base, 'Foo');
  const lower = path.join(base, 'foo');
  await fs.mkdir(upper, { recursive: true });
  try {
    const upperId = generateProjectId(upper);
    let lowerExists = true;
    try {
      await fs.mkdir(lower, { recursive: true });
    } catch {
      lowerExists = false;
    }
    if (lowerExists) {
      const upperIno = (await fs.stat(upper)).ino;
      const lowerIno = (await fs.stat(lower)).ino;
      if (upperIno !== lowerIno) {
        // 大小写敏感文件系统：Foo 与 foo 是不同目录，ID 必须不同
        assert.notEqual(generateProjectId(lower), upperId);
      } else {
        // 大小写不敏感文件系统：两个拼写命中同一目录，ID 必须相同
        assert.equal(generateProjectId(lower), upperId);
      }
    }
    // 大小写敏感系统上：不存在的 EXISTING 变体不得拿到已存在 Existing 目录的 ID
    // （回归：修复前 canonicalCase 会把不存在的变体映射到同名目录）
    const existing = path.join(base, 'Existing');
    await fs.mkdir(existing, { recursive: true });
    const existingId = generateProjectId(existing);
    const variant = path.join(base, 'EXISTING');
    const variantExists = await fs.stat(variant).then(
      () => true,
      () => false,
    );
    if (!variantExists) {
      assert.notEqual(generateProjectId(variant), existingId);
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('scan 进度在 Embedding 阶段持续可见且全程单调递增', async () => {
  configure();
  const root = path.join(fixture, 'progress');
  await fs.mkdir(root, { recursive: true });
  // 45 个文件仍在单个 scan 批次（batchSize=100）内，但 Embedding 文本数 >20，
  // 索引阶段会分多个 API 批次多次回报进度。
  for (let i = 0; i < 45; i++)
    await fs.writeFile(path.join(root, `file-${i}.ts`), `const value${i} = ${i};`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const input: string[] = JSON.parse(String(options?.body)).input;
    return response(input);
  };
  const steps: Array<{ current: number; message?: string }> = [];
  try {
    const stats = await scan(root, {
      onProgress: (current, _total, message) => steps.push({ current, message }),
    });
    assert.equal(stats.vectorIndex?.indexed, 45);
    assertProgressMonotonic(steps.map((step) => step.current));

    // 修复前：扫描阶段已到 99%，Embedding 回报从 ~1% 重新计数，低于已过里程碑
    // 被 ProgressBar 吞掉，表现为 92% 卡一百多秒。修复后 Embedding 阶段必须有
    // 高于扫描末值、低于 99 的中间进度。
    const scanValues = steps
      .filter((step) => step.message === '正在扫描文件...')
      .map((step) => step.current);
    const lastScan = Math.max(...scanValues);
    const embedMidsteps = steps
      .filter((step) => step.message === '正在更新索引...')
      .map((step) => step.current)
      .filter((value) => value < 99);
    assert.ok(
      embedMidsteps.length > 0 && embedMidsteps.every((value) => value > lastScan),
      `Embedding 阶段应有 (${lastScan}, 99) 区间的中间进度，实际序列: ${steps
        .map((step) => step.current)
        .join(',')}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await closeAllVectorStores();
    await fs.rm(root, { recursive: true, force: true });
  }
});
