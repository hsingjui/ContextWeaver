import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProgressBar, Spinner } from '../src/cli/progress.js';
import { maskSecret } from '../src/cli/theme.js';
import { buildDefaultEnvContent, buildEnvContent, parseEnvVars } from '../src/utils/envTemplate.js';

function collect(): { chunks: string[]; write: (text: string) => void } {
  const chunks: string[] = [];
  return { chunks, write: (text: string) => chunks.push(text) };
}

test('buildEnvContent 生成完整 Embedding + Reranker 配置', () => {
  const content = buildEnvContent({
    embedding: {
      baseUrl: 'http://localhost:11434/v1/embeddings',
      model: 'bge-m3',
      apiKey: 'local-model',
      dimensions: '1024',
    },
    reranker: {
      baseUrl: 'https://api.siliconflow.cn/v1/rerank',
      model: 'BAAI/bge-reranker-v2-m3',
      apiKey: 'sk-test',
      topN: '20',
    },
  });

  assert.match(content, /EMBEDDINGS_BASE_URL=http:\/\/localhost:11434\/v1\/embeddings/);
  assert.match(content, /EMBEDDINGS_MODEL=bge-m3/);
  assert.match(content, /EMBEDDINGS_API_KEY=local-model/);
  assert.match(content, /EMBEDDINGS_DIMENSIONS=1024/);
  assert.match(content, /RERANK_BASE_URL=https:\/\/api\.siliconflow\.cn\/v1\/rerank/);
  assert.match(content, /RERANK_API_KEY=sk-test/);
  assert.match(content, /RERANK_MODEL=BAAI\/bge-reranker-v2-m3/);
  assert.match(content, /RERANK_TOP_N=20/);
});

test('buildEnvContent 跳过 Reranker 时写入占位值与提醒注释', () => {
  const content = buildEnvContent({
    embedding: {
      baseUrl: 'https://api.siliconflow.cn/v1/embeddings',
      model: 'BAAI/bge-m3',
      apiKey: 'sk-abc',
      dimensions: '1024',
    },
    reranker: null,
  });

  assert.match(content, /尚未配置/);
  assert.match(content, /RERANK_API_KEY=your-api-key-here/);
  assert.match(content, /RERANK_BASE_URL=https:\/\/api\.siliconflow\.cn\/v1\/rerank/);
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
  assert.equal(vars.RERANK_BASE_URL, 'https://api.siliconflow.cn/v1/rerank');
  assert.equal(vars.RERANK_MODEL, 'BAAI/bge-reranker-v2-m3');
  assert.equal(vars.RERANK_TOP_N, '20');
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
