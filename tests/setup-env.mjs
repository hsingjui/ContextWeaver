// Keep unit/integration tests independent from the user's ~/.contextweaver/.env.
process.env.NODE_ENV = 'test';

for (const key of [
  'EMBEDDINGS_PROVIDER',
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_MODEL',
  'EMBEDDINGS_MAX_CONCURRENCY',
  'EMBEDDINGS_DIMENSIONS',
  'EMBEDDINGS_MAX_CONTEXT_TOKENS',
  'EMBEDDINGS_AUTO_SPLIT_LONG_TEXT',
  'RERANK_API_KEY',
  'RERANK_BASE_URL',
  'RERANK_MODEL',
  'RERANK_TOP_N',
]) {
  delete process.env[key];
}
