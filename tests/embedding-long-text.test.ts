import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { EmbeddingClient } from '../src/api/embedding.ts';

type FetchCall = {
  inputs: string[];
};

let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

function installFetchMock(handler: (inputs: string[]) => { status: number; body: unknown }): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const rawBody = init?.body ? String(init.body) : '{}';
    const parsed = JSON.parse(rawBody) as { input: string | string[] };
    const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];

    calls.push({ inputs });

    const { status, body } = handler(inputs);
    const responseBody = JSON.stringify(body);

    return new Response(responseBody, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  return { calls };
}

function okEmbeddingResponse(inputs: string[]) {
  return {
    object: 'list',
    data: inputs.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: [text.length],
    })),
    model: 'test-model',
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

test('embedBatch splits long text and averages embeddings', async () => {
  const client = new EmbeddingClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/embeddings',
    model: 'test-model',
    maxConcurrency: 2,
    dimensions: 1,
    maxInputChars: 10,
    maxBatchChars: 40,
    autoSplitLongText: true,
  });

  const { calls } = installFetchMock((inputs) => ({
    status: 200,
    body: okEmbeddingResponse(inputs),
  }));

  const longText = 'a'.repeat(25);
  const results = await client.embedBatch([longText], 20);

  const allSegments = calls.flatMap((call) => call.inputs);
  assert.ok(allSegments.length > 1, 'expected input to be split into segments');
  assert.ok(
    allSegments.every((text) => text.length <= 10),
    'segment exceeds maxInputChars',
  );

  const expected = allSegments.reduce((sum, text) => sum + text.length, 0) / allSegments.length;

  assert.equal(results.length, 1);
  assert.equal(results[0].embedding.length, 1);
  assert.equal(results[0].embedding[0], expected);
});

test('embedBatch keeps original text when auto split is disabled', async () => {
  const client = new EmbeddingClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/embeddings',
    model: 'test-model',
    maxConcurrency: 2,
    dimensions: 1,
    maxInputChars: 10,
    maxBatchChars: 40,
    autoSplitLongText: false,
  });

  const { calls } = installFetchMock((inputs) => ({
    status: 200,
    body: okEmbeddingResponse(inputs),
  }));

  const longText = 'a'.repeat(25);
  const results = await client.embedBatch([longText], 20);

  const allInputs = calls.flatMap((call) => call.inputs);
  assert.deepEqual(allInputs, [longText]);
  assert.equal(results.length, 1);
  assert.equal(results[0].embedding[0], longText.length);
});

test('embedBatch retries by binary split on input too long errors', async () => {
  const client = new EmbeddingClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/embeddings',
    model: 'test-model',
    maxConcurrency: 2,
    dimensions: 1,
    maxInputChars: 1000,
    maxBatchChars: 1000,
    autoSplitLongText: true,
  });

  const threshold = 39;
  const { calls } = installFetchMock((inputs) => {
    if (inputs.some((text) => text.length > threshold)) {
      // SiliconFlow 实际返回格式
      return {
        status: 413,
        body: { code: 20042, message: 'input must have less than 8192 tokens', data: null },
      };
    }

    return { status: 200, body: okEmbeddingResponse(inputs) };
  });

  const longText = 'b'.repeat(40);
  const results = await client.embedBatch([longText], 20);

  const allSegments = calls.flatMap((call) => call.inputs);
  assert.ok(
    allSegments.some((text) => text.length > threshold),
    'expected at least one failing call for long input',
  );
  assert.ok(
    allSegments.some((text) => text.length <= threshold),
    'expected retry calls with shorter segments',
  );

  const retrySegments = allSegments.filter((text) => text.length <= threshold);
  const expected = retrySegments.reduce((sum, text) => sum + text.length, 0) / retrySegments.length;

  assert.equal(results.length, 1);
  assert.equal(results[0].embedding.length, 1);
  assert.equal(results[0].embedding[0], expected);
});

test('embedBatch retries when API returns 200 with error message', async () => {
  const client = new EmbeddingClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/embeddings',
    model: 'test-model',
    maxConcurrency: 2,
    dimensions: 1,
    maxInputChars: 1000,
    maxBatchChars: 1000,
    autoSplitLongText: true,
  });

  const threshold = 39;
  const { calls } = installFetchMock((inputs) => {
    if (inputs.some((text) => text.length > threshold)) {
      // SiliconFlow 格式：HTTP 200 但 message 字段表示错误
      return {
        status: 200,
        body: { code: 20042, message: 'input must have less than 8192 tokens', data: null },
      };
    }

    return { status: 200, body: okEmbeddingResponse(inputs) };
  });

  const longText = 'c'.repeat(40);
  const results = await client.embedBatch([longText], 20);

  const allSegments = calls.flatMap((call) => call.inputs);
  assert.ok(
    allSegments.some((text) => text.length > threshold),
    'expected at least one failing call for long input',
  );
  assert.ok(
    allSegments.some((text) => text.length <= threshold),
    'expected retry calls with shorter segments',
  );

  const retrySegments = allSegments.filter((text) => text.length <= threshold);
  const expected = retrySegments.reduce((sum, text) => sum + text.length, 0) / retrySegments.length;

  assert.equal(results.length, 1);
  assert.equal(results[0].embedding.length, 1);
  assert.equal(results[0].embedding[0], expected);
});

test('embedBatch retries when API returns nested error message', async () => {
  const client = new EmbeddingClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/embeddings',
    model: 'test-model',
    maxConcurrency: 2,
    dimensions: 1,
    maxInputChars: 1000,
    maxBatchChars: 1000,
    autoSplitLongText: true,
  });

  const threshold = 39;
  const { calls } = installFetchMock((inputs) => {
    if (inputs.some((text) => text.length > threshold)) {
      return {
        status: 200,
        body: { error: { message: 'input must have less than 8192 tokens' } },
      };
    }

    return { status: 200, body: okEmbeddingResponse(inputs) };
  });

  const longText = 'd'.repeat(40);
  const results = await client.embedBatch([longText], 20);

  const allSegments = calls.flatMap((call) => call.inputs);
  const retrySegments = allSegments.filter((text) => text.length <= threshold);
  const expected = retrySegments.reduce((sum, text) => sum + text.length, 0) / retrySegments.length;

  assert.ok(retrySegments.length > 0, 'expected retry calls with shorter segments');
  assert.equal(results.length, 1);
  assert.equal(results[0].embedding[0], expected);
});
