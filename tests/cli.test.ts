import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

import { ProgressBar, Spinner } from '../src/cli/progress.js';
import { maskSecret } from '../src/cli/theme.js';
import { resolveEndpointUrl } from '../src/utils/endpointUrl.js';
import { buildDefaultEnvContent, buildEnvContent, parseEnvVars } from '../src/utils/envTemplate.js';

function collect(): { chunks: string[]; write: (text: string) => void } {
  const chunks: string[] = [];
  return { chunks, write: (text: string) => chunks.push(text) };
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** 以子进程运行真实 CLI（tsx 直跑源码），供机器输出契约验证。 */
function runCli(args: string[], input = ''): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // stderr 保持消费，避免管道背压
    child.stderr.on('data', () => undefined);
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(input);
  });
}

test('buildEnvContent 生成完整 Embedding + Reranker 配置', () => {
  const content = buildEnvContent({
    embedding: {
      baseUrl: 'http://localhost:11434/v1',
      model: 'bge-m3',
      apiKey: 'local-model',
      dimensions: '1024',
    },
    reranker: {
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-reranker-v2-m3',
      apiKey: 'sk-test',
      topN: '20',
    },
  });

  assert.match(content, /EMBEDDINGS_BASE_URL=http:\/\/localhost:11434\/v1/);
  assert.match(content, /EMBEDDINGS_MODEL=bge-m3/);
  assert.match(content, /EMBEDDINGS_API_KEY=local-model/);
  assert.match(content, /EMBEDDINGS_DIMENSIONS=1024/);
  assert.match(content, /RERANK_BASE_URL=https:\/\/api\.siliconflow\.cn\/v1/);
  assert.match(content, /RERANK_API_KEY=sk-test/);
  assert.match(content, /RERANK_MODEL=BAAI\/bge-reranker-v2-m3/);
  assert.match(content, /RERANK_TOP_N=20/);
});

test('buildEnvContent 跳过 Reranker 时写入占位值与提醒注释', () => {
  const content = buildEnvContent({
    embedding: {
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-m3',
      apiKey: 'sk-abc',
      dimensions: '1024',
    },
    reranker: null,
  });

  assert.match(content, /尚未配置/);
  assert.match(content, /RERANK_API_KEY=your-api-key-here/);
  assert.match(content, /RERANK_BASE_URL=https:\/\/api\.siliconflow\.cn\/v1/);
});

test('buildDefaultEnvContent 生成本地 EmbeddingGemma 默认模板', () => {
  const content = buildDefaultEnvContent();
  const vars = parseEnvVars(content);

  assert.equal(vars.EMBEDDINGS_PROVIDER, 'local');
  assert.equal(vars.EMBEDDINGS_MODEL, 'embeddinggemma-300m');
  assert.equal(vars.EMBEDDINGS_MAX_CONCURRENCY, '1');
  assert.equal(vars.EMBEDDINGS_API_KEY, undefined);
  assert.match(content, /contextweaver model install embeddinggemma-300m/);
  assert.equal(vars.RERANK_API_KEY, 'your-api-key-here');
  assert.equal(vars.RERANK_BASE_URL, 'https://api.siliconflow.cn/v1');
  assert.equal(vars.RERANK_MODEL, 'BAAI/bge-reranker-v2-m3');
  assert.equal(vars.RERANK_TOP_N, '20');
});

test('resolveEndpointUrl 拼接资源路径，兼容旧版完整地址', () => {
  assert.equal(
    resolveEndpointUrl('https://api.siliconflow.cn/v1', '/embeddings'),
    'https://api.siliconflow.cn/v1/embeddings',
  );
  assert.equal(
    resolveEndpointUrl('https://api.siliconflow.cn/v1/', '/rerank'),
    'https://api.siliconflow.cn/v1/rerank',
  );
  // 旧版 .env 写入的完整接口地址保持原样
  assert.equal(
    resolveEndpointUrl('https://api.siliconflow.cn/v1/rerank', '/rerank'),
    'https://api.siliconflow.cn/v1/rerank',
  );
  assert.equal(
    resolveEndpointUrl('http://localhost:11434/v1/embeddings', '/embeddings'),
    'http://localhost:11434/v1/embeddings',
  );
});

test('resolveEndpointUrl 只修改 pathname，保留查询参数与 fragment', () => {
  for (const resource of ['/embeddings', '/rerank']) {
    const suffix = '?api-version=2024-02-01&key=a%2Fb&tag=one&tag=two#section';
    for (const pathname of ['/v1', '/v1/', `/v1${resource}`, `/v1${resource}/`]) {
      assert.equal(
        resolveEndpointUrl(`https://example.invalid${pathname}${suffix}`, resource),
        `https://example.invalid/v1${resource}${suffix}`,
      );
    }
  }
});

test('parseEnvVars 跳过注释、空行与无等号行', () => {
  const vars = parseEnvVars('# 注释\n\nKEY_A=value-a\nINVALID LINE\n=broken\nKEY_B = spaced');
  assert.deepEqual(vars, { KEY_A: 'value-a', KEY_B: 'spaced' });
});

test('maskSecret 短值全掩码，长值保留首尾', () => {
  assert.equal(maskSecret(''), '(未设置)');
  assert.equal(maskSecret('abc'), '****');
  assert.equal(maskSecret('12345678'), '****');
  assert.equal(maskSecret('sk-1234567890abcdef'), 'sk-1****ef');
});

test('ProgressBar 非 TTY 模式按里程碑输出', () => {
  const { chunks, write } = collect();
  const bar = new ProgressBar({ write, useAnsi: false });

  bar.start();
  bar.update(1, 100, '正在更新索引');
  bar.update(5, 100, '正在更新索引');
  bar.update(15, 100, '正在更新索引');
  bar.update(25, 100, '正在更新索引');
  bar.update(26, 100, '正在更新索引');
  bar.done('索引完成');

  // 里程碑输出：1% → 15% → 25%，最后 done 补 100% 收尾行
  assert.equal(chunks.length, 4);
  assert.match(chunks[0], /1%/);
  assert.match(chunks[1], /15%/);
  assert.match(chunks[2], /25%/);
  const last = chunks[chunks.length - 1];
  assert.match(last, /100%/);
  assert.match(last, /索引完成/);
});

test('ProgressBar TTY 模式原地重绘并渲染 100% 收尾', () => {
  const { chunks, write } = collect();
  const bar = new ProgressBar({ write, useAnsi: true });

  bar.start();
  bar.update(15, 100, '正在更新索引');
  bar.update(50, 100, '正在更新索引');
  bar.done('索引完成');

  const firstFrame = chunks[0];
  assert.ok(firstFrame.includes('\r\x1b[2K'));
  assert.match(firstFrame, /15%/);
  assert.ok(firstFrame.includes('█'));
  assert.ok(firstFrame.includes('░'));
  assert.match(firstFrame, /正在更新索引/);

  const lastFrame = chunks[chunks.length - 2];
  assert.match(lastFrame, /100%/);
  assert.equal(chunks[chunks.length - 1], '\n');
});

test('ProgressBar TTY 模式渲染限频，密集更新不刷屏', () => {
  const { chunks, write } = collect();
  const bar = new ProgressBar({ write, useAnsi: true });

  bar.start();
  bar.update(10, 100);
  bar.update(11, 100);
  bar.update(12, 100);

  // 10% 一帧，紧随其后的两帧被限频丢弃
  assert.equal(chunks.length, 1);
  bar.done('');
});

test('ProgressBar 非 TTY 模式 update(100) 未跨里程碑时 done 补 100% 收尾行', () => {
  const { chunks, write } = collect();
  const bar = new ProgressBar({ write, useAnsi: false });

  bar.start();
  // 1% → 11% → ... → 91% 共 10 行；91% 后 nextMilestone 指向 101，update(100) 不会输出
  for (let p = 1; p <= 100; p += 10) bar.update(p, 100);
  bar.update(100, 100);
  bar.done('索引已就绪');

  assert.equal(chunks.length, 11);
  assert.match(chunks[9], /91%/);
  const last = chunks[chunks.length - 1];
  assert.match(last, /100%/);
  assert.match(last, /索引已就绪/);
});

test('ProgressBar 非 TTY 模式已打印 100% 时 done 不重复输出', () => {
  const { chunks, write } = collect();
  const bar = new ProgressBar({ write, useAnsi: false });

  bar.start();
  bar.update(100, 100);
  bar.done('完成');

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /100%/);
});

test('search --json 缺少 --information-request 时 stdout 输出单行 JSON 错误且退出非零', async () => {
  const { stdout, code } = await runCli(['search', '--json']);
  assert.notEqual(code, 0);
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { error?: string };
  assert.ok(parsed.error, 'stdout 必须是单行 {"error": ...}');
});

test('search --jsonl 输入全为非法行时逐行输出 JSON 错误且不触发检索', async () => {
  const input = ['{"technical_terms":"abc"}', 'not json', '{"information_request":"   "}'].join(
    '\n',
  );
  const { stdout, code } = await runCli(
    ['search', '--jsonl', '--repo-path', '/nonexistent'],
    input,
  );
  assert.notEqual(code, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 3, '每行输入对应一行输出');
  for (const line of lines) {
    const parsed = JSON.parse(line) as { error?: string };
    assert.ok(parsed.error, `应为错误行: ${line}`);
  }
});

test('Spinner 非 TTY 模式输出静态行并以结果行收尾', () => {
  const { chunks, write } = collect();
  const spinner = new Spinner({ write, useAnsi: false });

  spinner.start('正在测试连通性');
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /正在测试连通性/);

  spinner.stop('✓ 连通正常');
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /连通正常/);
});
