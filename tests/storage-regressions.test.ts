import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';

// 必须在动态加载存储模块前隔离 HOME，其目录常量在模块初始化时计算。
const previousHome = process.env.HOME;
const output = path.resolve('test-output');
await fs.mkdir(output, { recursive: true });
const home = await fs.mkdtemp(path.join(output, 'storage-regressions-'));
process.env.HOME = home;

const { initDb, migrateProjectIndex } = await import('../src/db/index.js');
const { VectorStore } = await import('../src/vectorStore/index.js');
const { withLock } = await import('../src/utils/lock.js');
const { runModelCommand } = await import('../src/cli/model.js');
const { getLocalModelDir, listLocalModelStatuses } = await import('../src/models/index.js');
const base = path.join(home, '.contextweaver');

after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

async function seedLegacyIndex(project: string): Promise<{ oldDir: string; newDir: string }> {
  const newDir = path.join(base, 'index', project);
  const oldDir = path.join(base, project);
  const db = initDb(project);
  try {
    db.exec(
      "CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES ('saved')",
    );
  } finally {
    db.close();
  }
  const store = new VectorStore(project, 2);
  await store.init();
  try {
    await store.upsertFile('saved.ts', 'hash', [
      {
        chunk_id: 'saved.ts#hash#0',
        file_path: 'saved.ts',
        file_hash: 'hash',
        chunk_index: 0,
        vector: [1, 0],
        display_code: 'saved',
        vector_text: 'saved',
        language: 'typescript',
        breadcrumb: 'saved.ts',
        start_index: 0,
        end_index: 5,
        raw_start: 0,
        raw_end: 5,
        vec_start: 0,
        vec_end: 5,
      },
    ]);
  } finally {
    await store.close();
  }
  await fs.rename(newDir, oldDir);
  return { oldDir, newDir };
}

async function assertIndexPreserved(project: string): Promise<void> {
  // 与直接搜索一致：先打开向量库，随后打开 SQLite。
  const store = new VectorStore(project, 2);
  await store.init();
  try {
    assert.equal(await store.count(), 1);
    assert.equal((await store.search([1, 0], 1))[0]?.display_code, 'saved');
    const db = initDb(project);
    try {
      assert.deepEqual(db.prepare('SELECT value FROM migration_probe').all(), [{ value: 'saved' }]);
    } finally {
      db.close();
    }
  } finally {
    await store.close();
  }
}

test('旧索引在向量库先打开时整体迁移，重复打开不丢失数据', async () => {
  const project = 'direct-search';
  const { oldDir } = await seedLegacyIndex(project);
  await assertIndexPreserved(project);
  await assertIndexPreserved(project);
  await assert.rejects(fs.stat(oldDir), { code: 'ENOENT' });
});

test('索引锁先创建目标目录时迁移保留锁及全部索引文件', async () => {
  const project = 'locked-index';
  const { oldDir, newDir } = await seedLegacyIndex(project);
  const lockPath = path.join(newDir, 'index.lock');
  await fs.writeFile(path.join(oldDir, 'migration-extra'), 'keep');
  await withLock(project, 'index', async () => {
    const lock = await fs.readFile(lockPath, 'utf8');
    assert.equal(JSON.parse(lock).pid, process.pid);
    // 对应 CLI scan / MCP isProjectIndexed 在加锁后触发迁移。
    const db = initDb(project);
    db.close();
    await assertIndexPreserved(project);
    assert.equal(await fs.readFile(lockPath, 'utf8'), lock);
    assert.equal(await fs.readFile(path.join(newDir, 'migration-extra'), 'utf8'), 'keep');
    await assert.rejects(fs.stat(oldDir), { code: 'ENOENT' });
  });
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
});

test('迁移冲突在搬移前报错，保留新旧文件且释放锁', async () => {
  const project = 'conflict';
  const { oldDir, newDir } = await seedLegacyIndex(project);
  const oldDb = await fs.readFile(path.join(oldDir, 'index.db'));
  await fs.mkdir(newDir, { recursive: true });
  await fs.writeFile(path.join(newDir, 'index.db'), 'do not overwrite');
  await assert.rejects(
    withLock(project, 'index', async () => {
      migrateProjectIndex(project);
    }),
    /索引迁移冲突/,
  );
  assert.deepEqual(await fs.readFile(path.join(oldDir, 'index.db')), oldDb);
  assert.equal(await fs.readFile(path.join(newDir, 'index.db'), 'utf8'), 'do not overwrite');
  assert.ok((await fs.stat(path.join(oldDir, 'vectors.lance'))).isDirectory());
  await assert.rejects(fs.stat(path.join(newDir, 'vectors.lance')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(newDir, 'index.lock')), { code: 'ENOENT' });
});

test('部分文件已迁移时重试继续搬移剩余索引', async () => {
  const project = 'resume';
  const { oldDir, newDir } = await seedLegacyIndex(project);
  await fs.mkdir(newDir, { recursive: true });
  await fs.rename(path.join(oldDir, 'vectors.lance'), path.join(newDir, 'vectors.lance'));
  await withLock(project, 'index', async () => {
    migrateProjectIndex(project);
    await assertIndexPreserved(project);
  });
  await assert.rejects(fs.stat(oldDir), { code: 'ENOENT' });
});

for (const marker of [undefined, { version: 1, revision: 'outdated' }]) {
  test(`model remove 清理${marker ? '过期标记' : '未完成安装'}的缓存且保留其他模型和配置`, async () => {
    const model = 'embeddinggemma-300m';
    const cacheDir = getLocalModelDir(model);
    const otherDir = getLocalModelDir('qwen3-embedding-0.6b');
    const envFile = path.join(base, '.env');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'partial.onnx'), 'partial download');
    if (marker) await fs.writeFile(path.join(cacheDir, 'install.json'), JSON.stringify(marker));
    await fs.writeFile(path.join(otherDir, 'keep.onnx'), 'other model');
    await fs.writeFile(
      envFile,
      'EMBEDDINGS_PROVIDER=local\nEMBEDDINGS_MODEL=embeddinggemma-300m\n',
    );
    const envContent = await fs.readFile(envFile, 'utf8');
    const status = (await listLocalModelStatuses()).find((item) => item.model.id === model);
    assert.equal(status?.installed, false);
    assert.equal(status?.hasCache, true);
    assert.notEqual(process.stdin.isTTY === true && process.stdout.isTTY === true, true);
    await assert.rejects(runModelCommand('remove', model), /必须传入 --yes/);
    assert.equal(
      await fs.readFile(path.join(cacheDir, 'partial.onnx'), 'utf8'),
      'partial download',
    );
    await runModelCommand('remove', model, { yes: true });
    await assert.rejects(fs.stat(cacheDir), { code: 'ENOENT' });
    await runModelCommand('remove', model, { yes: true });
    assert.equal(await fs.readFile(path.join(otherDir, 'keep.onnx'), 'utf8'), 'other model');
    assert.equal(await fs.readFile(envFile, 'utf8'), envContent);
  });
}
