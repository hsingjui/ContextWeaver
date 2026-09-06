import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { RerankerClient } from '../src/api/reranker.ts';

let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

function createClient(): RerankerClient {
  return new RerankerClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/rerank',
    model: 'test-model',
    topN: 5,
  });
}

test('rerank throws clear error when API returns 200 with error message', async () => {
  const client = createClient();

  globalThis.fetch = (async () => {
    // SiliconFlow 格式：HTTP 200 但 message 字段表示错误
    return new Response(
      JSON.stringify({ code: 20042, message: 'input must have less than 8192 tokens', data: null }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;

  await assert.rejects(
    client.rerank('query', ['doc-a'], { retries: 1 }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes('Rerank API 错误') &&
      err.message.includes('input must have less than'),
  );
});

test('rerank throws clear error when API returns nested error message', async () => {
  const client = createClient();

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ error: { message: 'input must have less than 8192 tokens' } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;

  await assert.rejects(
    client.rerank('query', ['doc-a'], { retries: 1 }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes('Rerank API 错误') &&
      err.message.includes('input must have less than'),
  );
});

test('rerank throws clear error when response index is out of range', async () => {
  const client = createClient();

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        results: [{ index: 9, relevance_score: 0.95 }],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;

  await assert.rejects(
    client.rerank('query', ['doc-a'], { retries: 1 }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes('Rerank API 错误') &&
      err.message.includes('响应索引越界'),
  );
});
