// Keep unit/integration tests independent from the user's ~/.contextweaver/.env.
process.env.NODE_ENV = 'test';

// 隔离索引写入目录：src/db、vectorStore、lock 的 BASE_DIR 在模块初始化时
// 由 os.homedir() 计算，而测试文件里的 `process.env.HOME = ...` 会被静态
// import 提前求值而失效。本文件经 --import 在所有测试模块之前运行，
// 在这里设置 HOME 才能真正拦截 BASE_DIR 的计算。
import path from 'node:path';

process.env.HOME = path.join(process.cwd(), 'test-output', `home-${process.pid}`);

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
