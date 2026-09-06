import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getEmbeddingConfig } from '../src/config.ts';

const ENV_KEYS = [
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_MODEL',
  'EMBEDDINGS_MAX_CONCURRENCY',
  'EMBEDDINGS_DIMENSIONS',
  'EMBEDDINGS_MAX_CONTEXT_TOKENS',
  'EMBEDDINGS_AUTO_SPLIT_LONG_TEXT',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

function withEnv(overrides: Partial<Record<EnvKey, string | undefined>>, run: () => void): void {
  const snapshot = new Map<EnvKey, string | undefined>();
  for (const key of ENV_KEYS) {
    snapshot.set(key, process.env[key]);
  }

  try {
    for (const key of ENV_KEYS) {
      const value = overrides[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    run();
  } finally {
    for (const key of ENV_KEYS) {
      const previous = snapshot.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  }
}

test('maxInputChars/maxBatchChars follow EMBEDDINGS_MAX_CONTEXT_TOKENS when not overridden', () => {
  withEnv(
    {
      EMBEDDINGS_API_KEY: 'test-key',
      EMBEDDINGS_BASE_URL: 'https://example.invalid/embeddings',
      EMBEDDINGS_MODEL: 'BAAI/bge-m3',
      EMBEDDINGS_MAX_CONTEXT_TOKENS: '4096',
    },
    () => {
      const config = getEmbeddingConfig();
      assert.equal(config.maxInputChars, 4014);
      assert.equal(config.maxBatchChars, 12042);
    },
  );
});

test('default context 8192 is used when EMBEDDINGS_MAX_CONTEXT_TOKENS is not set', () => {
  withEnv(
    {
      EMBEDDINGS_API_KEY: 'test-key',
      EMBEDDINGS_BASE_URL: 'https://example.invalid/embeddings',
      EMBEDDINGS_MODEL: 'custom/model-without-mapping',
      EMBEDDINGS_MAX_CONTEXT_TOKENS: undefined,
    },
    () => {
      const config = getEmbeddingConfig();
      assert.equal(config.maxInputChars, 8028);
      assert.equal(config.maxBatchChars, 24084);
    },
  );
});

test('invalid context value falls back to default 8192', () => {
  withEnv(
    {
      EMBEDDINGS_API_KEY: 'test-key',
      EMBEDDINGS_BASE_URL: 'https://example.invalid/embeddings',
      EMBEDDINGS_MODEL: 'BAAI/bge-m3',
      EMBEDDINGS_MAX_CONTEXT_TOKENS: 'not-a-number',
    },
    () => {
      const config = getEmbeddingConfig();
      assert.equal(config.maxInputChars, 8028);
      assert.equal(config.maxBatchChars, 24084);
    },
  );
});

test('auto split long text defaults to true', () => {
  withEnv(
    {
      EMBEDDINGS_API_KEY: 'test-key',
      EMBEDDINGS_BASE_URL: 'https://example.invalid/embeddings',
      EMBEDDINGS_MODEL: 'BAAI/bge-m3',
      EMBEDDINGS_AUTO_SPLIT_LONG_TEXT: undefined,
    },
    () => {
      const config = getEmbeddingConfig();
      assert.equal(config.autoSplitLongText, true);
    },
  );
});

test('auto split long text can be disabled by env', () => {
  withEnv(
    {
      EMBEDDINGS_API_KEY: 'test-key',
      EMBEDDINGS_BASE_URL: 'https://example.invalid/embeddings',
      EMBEDDINGS_MODEL: 'BAAI/bge-m3',
      EMBEDDINGS_AUTO_SPLIT_LONG_TEXT: 'false',
    },
    () => {
      const config = getEmbeddingConfig();
      assert.equal(config.autoSplitLongText, false);
    },
  );
});
