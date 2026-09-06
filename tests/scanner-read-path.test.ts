/**
 * 遍历 → 读文件链路的冒烟测试
 *
 * 覆盖：crawler 目录剪枝、二进制检测（原始字节）、BOM 剥离、
 * GBK 解码、lock 文件兜底、大文件跳过、增量 unchanged 快路径
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import iconv from 'iconv-lite';
import { crawl } from '../src/scanner/crawler.js';
import { initFilter } from '../src/scanner/filter.js';
import { type KnownFileMeta, processFiles } from '../src/scanner/processor.js';

const ROOT = path.join(process.cwd(), '.tmp', 'scanner-smoke');

async function setup(): Promise<void> {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, 'src'), { recursive: true });

  // 普通文件
  await fs.writeFile(path.join(ROOT, 'src/a.ts'), 'export const a = 1;\n');
  // UTF-8 BOM 文件
  await fs.writeFile(
    path.join(ROOT, 'bom.ts'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export const b = 2;\n')]),
  );
  // GBK 编码文件（样本要有足够长度，否则 chardet 会误判为 Shift_JIS）
  await fs.writeFile(
    path.join(ROOT, 'gbk.py'),
    iconv.encode(
      "# 这是一个用于测试的中文注释样本，内容足够长以便编码检测器正确识别 GBK 编码。\n\nx = '中文内容测试'\n",
      'gbk',
    ),
  );
  // 二进制文件（含 NUL 字节）
  await fs.writeFile(path.join(ROOT, 'binary.py'), Buffer.from([0x23, 0x00, 0x41, 0x42]));
  // 非默认名单的 lock 文件（触发 processor 兜底）
  await fs.writeFile(path.join(ROOT, 'custom-lock.json'), '{}');
  // 超过 100KB 的大文件
  await fs.writeFile(path.join(ROOT, 'big.ts'), 'a'.repeat(101 * 1024));
  // 应被目录剪枝排除的内容
  await fs.mkdir(path.join(ROOT, 'node_modules', 'lib'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'node_modules/lib/x.js'), 'module.exports = 1;\n');
  await fs.mkdir(path.join(ROOT, '.git'), { recursive: true });
  await fs.writeFile(path.join(ROOT, '.git/config'), '[core]\n');
}

test.before(async () => {
  await setup();
  await initFilter(ROOT);
});

test('crawl 剪枝：node_modules/.git 不进入结果', async () => {
  const files = await crawl(ROOT);
  assert.ok(
    !files.some((p) => p.includes('node_modules') || p.includes('.git')),
    JSON.stringify(files),
  );
  // 其余文件都在
  for (const name of ['src/a.ts', 'bom.ts', 'gbk.py', 'binary.py', 'big.ts']) {
    assert.ok(
      files.some((p) => p.replace(/\\/g, '/').endsWith(name)),
      `missing ${name}`,
    );
  }
});

test('processFile：二进制/BOM/GBK/lock/大文件', async (t) => {
  const files = await crawl(ROOT);
  const results = await processFiles(ROOT, files, new Map());
  const byRel = new Map(results.map((r) => [r.relPath, r]));

  const bin = byRel.get('binary.py');
  assert.equal(bin?.status, 'skipped');
  assert.match(bin?.error ?? '', /Binary file detected/);

  const lock = byRel.get('custom-lock.json');
  assert.equal(lock?.status, 'skipped');
  assert.match(lock?.error ?? '', /Lock file/);

  const big = byRel.get('big.ts');
  assert.equal(big?.status, 'skipped');

  const bom = byRel.get('bom.ts');
  assert.equal(bom?.status, 'added');
  // BOM 已剥离：内容应与无 BOM 版本完全一致
  assert.equal(bom?.content, 'export const b = 2;\n');

  const gbk = byRel.get('gbk.py');
  assert.equal(gbk?.status, 'added');
  assert.ok((gbk?.content ?? '').includes('中文'), gbk?.content);

  const a = byRel.get('src/a.ts');
  assert.equal(a?.status, 'added');
  assert.equal(a?.content, 'export const a = 1;\n');

  // 第二遍：mtime/size 未变 → unchanged 快路径（不重读内容）
  // 真实 scan 只将 added/modified 写入 DB，skipped 文件不入 knownFiles
  const known = new Map<string, KnownFileMeta>();
  for (const r of results) {
    if (r.status === 'added' || r.status === 'modified') {
      known.set(r.relPath, { mtime: r.mtime, hash: r.hash, size: r.size });
    }
  }
  const files2 = await crawl(ROOT);
  const results2 = await processFiles(ROOT, files2, known);
  assert.equal(
    results2.filter((r) => r.status === 'unchanged').length,
    results.filter((r) => r.status === 'added').length,
  );

  t.diagnostic(
    `first pass: ${JSON.stringify(Object.fromEntries(results.map((r) => [r.relPath, r.status])))}`,
  );
});

test('扫描窗口内被删除的文件 → skipped 而非 error', async () => {
  const [result] = await processFiles(ROOT, ['ghost.ts'], new Map());
  assert.equal(result.status, 'skipped');
  assert.match(result.error ?? '', /File deleted during scan/);
});

test.after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});
