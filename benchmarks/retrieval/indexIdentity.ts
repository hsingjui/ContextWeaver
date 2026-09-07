import { createHash } from 'node:crypto';
import type { EmbeddingConfig } from '../../src/config.js';
import { generateProjectId } from '../../src/db/index.js';

export interface BenchmarkIndexIdentity {
  key: string;
  projectId: string;
  fingerprint: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return (normalized || 'embedding').slice(0, 48);
}

function embeddingIndexConfig(embedding: EmbeddingConfig): object {
  if (embedding.provider === 'local') {
    return {
      provider: embedding.provider,
      model: embedding.model,
      repo: embedding.repo,
      revision: embedding.revision,
      dtype: embedding.dtype,
      dimensions: embedding.dimensions,
      maxContextTokens: embedding.maxContextTokens,
      pooling: embedding.pooling,
      documentInputSpaceVersion: embedding.documentInputSpaceVersion,
    };
  }

  return {
    provider: embedding.provider,
    model: embedding.model,
    baseUrl: embedding.baseUrl,
    dimensions: embedding.dimensions,
    maxInputChars: embedding.maxInputChars,
    autoSplitLongText: embedding.autoSplitLongText,
  };
}

/**
 * 只用于 retrieval benchmark 的多版本索引命名。
 * 不影响普通项目索引；reranker、RRF、TopK、并发和 batch 大小等 query/runtime 参数也不会进入 key。
 */
export function getBenchmarkIndexIdentity(
  repoPath: string,
  embedding: EmbeddingConfig,
): BenchmarkIndexIdentity {
  const fingerprint = sha256(JSON.stringify(embeddingIndexConfig(embedding)));
  const shortFingerprint = fingerprint.slice(0, 12);
  const modelSlug = slugify(`${embedding.provider}-${embedding.model}`);
  const key = `${modelSlug}-${shortFingerprint}`;

  return {
    key,
    projectId: `${generateProjectId(repoPath)}-retrieval-benchmark-${key}`,
    fingerprint,
  };
}
