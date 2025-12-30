/**
 * FTS (Full-Text Search) 模块
 *
 * 基于 SQLite FTS5 实现词法检索能力：
 * - 自动探测 tokenizer 支持（trigram > unicode61）
 * - 初始化和同步 files_fts 表
 * - 提供文件级和 chunk 级搜索接口
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

// FTS Tokenizer 探测

/** 支持的 tokenizer 类型 */
type FtsTokenizer = 'trigram' | 'unicode61';

/** 缓存已探测的 tokenizer */
const tokenizerCache = new WeakMap<Database.Database, FtsTokenizer>();

/**
 * FTS tokenizer 能力探测
 * @returns 'trigram' | 'unicode61'
 */
function detectFtsTokenizer(db: Database.Database): FtsTokenizer {
  // 检查缓存
  const cached = tokenizerCache.get(db);
  if (cached) return cached;

  let tokenizer: FtsTokenizer;
  try {
    // 尝试创建 trigram 表
    db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(content, tokenize='trigram');
            DROP TABLE IF EXISTS _fts_probe;
        `);
    tokenizer = 'trigram';
    logger.debug('FTS tokenizer: trigram 可用');
  } catch (_err) {
    // trigram 不可用，降级到 unicode61
    tokenizer = 'unicode61';
    logger.debug('FTS tokenizer: 降级到 unicode61');
  }

  tokenizerCache.set(db, tokenizer);
  return tokenizer;
}

// FTS 表初始化

/**
 * 初始化 files_fts 表
 *
 * 创建虚拟表并同步已有文件数据
 */
export function initFilesFts(db: Database.Database): void {
  const tokenizer = detectFtsTokenizer(db);

  // 检查表是否已存在
  const tableExists = db
    .prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='files_fts'
    `)
    .get();

  if (!tableExists) {
    // 创建 FTS 表
    db.exec(`
            CREATE VIRTUAL TABLE files_fts USING fts5(
                path,
                content,
                tokenize='${tokenizer}'
            );
        `);
    logger.info(`创建 files_fts 表，tokenizer=${tokenizer}`);

    // 同步已有文件数据
    syncFilesFts(db);
  }
}

/**
 * 同步 files 表到 files_fts
 *
 * 检查两表记录数差异，必要时重建索引
 */
function syncFilesFts(db: Database.Database): void {
  const fileCount = (
    db.prepare('SELECT COUNT(*) as c FROM files WHERE content IS NOT NULL').get() as { c: number }
  ).c;
  const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM files_fts').get() as { c: number }).c;

  if (ftsCount < fileCount) {
    logger.info(`同步 FTS 索引: files=${fileCount}, fts=${ftsCount}`);

    // 重建 FTS 索引
    db.exec(`
            DELETE FROM files_fts;
            INSERT INTO files_fts(path, content) 
            SELECT path, content FROM files WHERE content IS NOT NULL;
        `);

    logger.info(`FTS 索引同步完成: ${fileCount} 条记录`);
  }
}

// Chunk 级 FTS（chunks_fts）

/** Chunk FTS 搜索结果 */
export interface ChunkFtsResult {
  chunkId: string;
  filePath: string;
  chunkIndex: number;
  score: number;
}

/**
 * 初始化 chunks_fts 表
 */
export function initChunksFts(db: Database.Database): void {
  const tokenizer = detectFtsTokenizer(db);

  const tableExists = db
    .prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='chunks_fts'
    `)
    .get();

  if (!tableExists) {
    // 创建 chunk 级 FTS 表
    // chunk_id, file_path, chunk_index 为 UNINDEXED（不参与全文搜索，但可返回）
    db.exec(`
            CREATE VIRTUAL TABLE chunks_fts USING fts5(
                chunk_id UNINDEXED,
                file_path UNINDEXED,
                chunk_index UNINDEXED,
                breadcrumb,
                content,
                tokenize='${tokenizer}'
            );
        `);
    logger.info(`创建 chunks_fts 表，tokenizer=${tokenizer}`);
  }
}

/**
 * 检查 chunks_fts 是否已初始化
 */
export function isChunksFtsInitialized(db: Database.Database): boolean {
  const result = db
    .prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='chunks_fts'
    `)
    .get();
  return !!result;
}

/**
 * 批量插入 chunk FTS 索引
 */
export function batchUpsertChunkFts(
  db: Database.Database,
  chunks: Array<{
    chunkId: string;
    filePath: string;
    chunkIndex: number;
    breadcrumb: string;
    content: string;
  }>,
): void {
  const deleteStmt = db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO chunks_fts(chunk_id, file_path, chunk_index, breadcrumb, content) VALUES (?, ?, ?, ?, ?)',
  );

  const transaction = db.transaction((items: typeof chunks) => {
    for (const item of items) {
      deleteStmt.run(item.chunkId);
      insertStmt.run(item.chunkId, item.filePath, item.chunkIndex, item.breadcrumb, item.content);
    }
  });

  transaction(chunks);
}

/**
 * 批量删除文件的 chunk FTS 索引
 */
export function batchDeleteFileChunksFts(db: Database.Database, filePaths: string[]): void {
  const stmt = db.prepare('DELETE FROM chunks_fts WHERE file_path = ?');
  const transaction = db.transaction((paths: string[]) => {
    for (const p of paths) {
      stmt.run(p);
    }
  });
  transaction(filePaths);
}

/**
 * 搜索 chunks_fts（直接返回 chunk 级别结果）
 *
 * @param db 数据库实例
 * @param query 搜索查询
 * @param limit 最大返回数量
 * @returns 按 BM25 得分排序的 chunk 列表
 */
export function searchChunksFts(
  db: Database.Database,
  query: string,
  limit: number,
): ChunkFtsResult[] {
  // 使用统一分词器
  const tokens = segmentQuery(query);

  if (tokens.length === 0) {
    logger.debug('Chunk FTS 分词后无有效 token，跳过搜索');
    return [];
  }

  logger.debug(
    {
      rawQuery: query,
      tokens: tokens,
    },
    'Chunk FTS 分词结果',
  );

  // 辅助：执行 SQL 查询
  const runQuery = (qStr: string, queryLimit: number): ChunkFtsResult[] => {
    try {
      const rows = db
        .prepare(`
                SELECT chunk_id, file_path, chunk_index, bm25(chunks_fts) as score
                FROM chunks_fts
                WHERE chunks_fts MATCH ?
                ORDER BY score
                LIMIT ?
            `)
        .all(qStr, queryLimit) as Array<{
        chunk_id: string;
        file_path: string;
        chunk_index: number;
        score: number;
      }>;

      // BM25 返回负值，转正
      return rows.map((r) => ({
        chunkId: r.chunk_id,
        filePath: r.file_path,
        chunkIndex: r.chunk_index,
        score: -r.score,
      }));
    } catch (e) {
      logger.debug({ error: e }, 'Chunk FTS 查询出错');
      return [];
    }
  };

  // 策略一：精准查询 (AND)
  const strictQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
  const results = runQuery(strictQuery, limit);

  logger.debug({ type: 'strict', count: results.length, query: strictQuery }, 'Chunk FTS 精准搜索');

  // 策略二：宽容查询 (OR) - 仅当结果不足时触发
  if (results.length < limit && tokens.length > 1) {
    const beforeCount = results.length;
    const remainingLimit = limit - results.length;
    const relaxedQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');

    const relaxedResults = runQuery(relaxedQuery, remainingLimit + 10);

    const existingIds = new Set(results.map((r) => r.chunkId));

    for (const row of relaxedResults) {
      if (!existingIds.has(row.chunkId)) {
        if (results.length >= limit) break;
        results.push(row);
        existingIds.add(row.chunkId);
      }
    }

    logger.debug(
      { type: 'relaxed', added: results.length - beforeCount, query: relaxedQuery },
      'Chunk FTS 宽容搜索补录',
    );
  }

  logger.debug(
    {
      chunkCount: results.length,
      topChunks: results.slice(0, 5).map((r) => ({
        path: r.filePath.split('/').slice(-2).join('/'),
        chunkIndex: r.chunkIndex,
        bm25: r.score.toFixed(3),
      })),
    },
    'Chunk FTS 召回结果',
  );

  return results.sort((a, b) => b.score - a.score);
}

/**
 * 批量更新 FTS 索引
 */
export function batchUpsertFileFts(
  db: Database.Database,
  files: Array<{ path: string; content: string }>,
): void {
  const deleteFts = db.prepare('DELETE FROM files_fts WHERE path = ?');
  const insertFts = db.prepare('INSERT INTO files_fts(path, content) VALUES (?, ?)');

  const transaction = db.transaction((items: Array<{ path: string; content: string }>) => {
    for (const item of items) {
      deleteFts.run(item.path);
      insertFts.run(item.path, item.content);
    }
  });

  transaction(files);
}

/**
 * 批量删除 FTS 索引记录
 */
export function batchDeleteFileFts(db: Database.Database, paths: string[]): void {
  const stmt = db.prepare('DELETE FROM files_fts WHERE path = ?');
  const transaction = db.transaction((items: string[]) => {
    for (const path of items) {
      stmt.run(path);
    }
  });
  transaction(paths);
}

// FTS 搜索接口

/** FTS 搜索结果 */
export interface FtsSearchResult {
  path: string;
  score: number;
}

/**
 * 清理搜索查询
 *
 * FTS5 对特殊字符敏感，需要转义或清理
 * trigram tokenizer 对 . / _ - 等也敏感
 */
function sanitizeQuery(query: string): string {
  // 移除 FTS5 特殊字符和标点符号，保留基本搜索词
  // 特殊字符: AND, OR, NOT, (, ), ", *, ^, NEAR, ., /, \, :, etc.
  return query
    .replace(/[():"*^./\\:@#$%&=+[\]{}<>|~`!?,;]/g, ' ') // 移除特殊字符
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ') // 移除保留关键字
    .replace(/\s+/g, ' ') // 合并空白
    .trim();
}

// 核心工具：统一分词器

// 性能优化：Intl.Segmenter 单例（避免每次搜索都创建新实例）
let zhSegmenter: Intl.Segmenter | null = null;
function getZhSegmenter(): Intl.Segmenter | null {
  if (zhSegmenter === null) {
    try {
      zhSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    } catch {
      // 环境不支持，返回 null
      return null;
    }
  }
  return zhSegmenter;
}

/**
 * camelCase → snake_case 转换
 * 例: apiKey → api_key, AuthService → auth_service
 */
function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * snake_case → camelCase 转换
 * 例: api_key → apiKey, auth_service → authService
 */
function toCamelCase(str: string): string {
  return str.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * 生成 token 变体（用于提升召回率）
 *
 * 对于 apiKey，生成: apikey, api_key
 * 对于 api_key，生成: apikey, apiKey
 */
function generateVariants(token: string): string[] {
  const variants: string[] = [token.toLowerCase()];

  // 去掉所有分隔符的版本 (api_key → apikey, api.key → apikey)
  const stripped = token.replace(/[._-]/g, '').toLowerCase();
  if (stripped !== token.toLowerCase() && stripped.length > 0) {
    variants.push(stripped);
  }

  // camelCase → snake_case
  if (/[a-z][A-Z]/.test(token)) {
    const snake = toSnakeCase(token);
    if (!variants.includes(snake)) {
      variants.push(snake);
    }
  }

  // snake_case → camelCase
  if (/_/.test(token)) {
    const camel = toCamelCase(token);
    if (!variants.includes(camel)) {
      variants.push(camel);
    }
  }

  return variants;
}

/**
 * 混合分词策略
 * 1. 提取代码特征 (CamelCase, snake_case, dots)
 * 2. 使用 Intl.Segmenter 进行自然语言分词 (支持中文)
 * 3. 生成变体扩展 (apiKey ↔ api_key)
 *
 * 导出供 SearchService 复用，确保召回和评分逻辑一致
 */
export function segmentQuery(query: string): string[] {
  const uniqueTokens = new Set<string>();

  // A. 清理
  const cleanRaw = sanitizeQuery(query);
  if (!cleanRaw) return [];

  // B. 代码特征提取 (保留 index.ts, someVar 这种整体)
  for (const t of query.split(/\s+/)) {
    // 只有包含特殊符号或大小写混合的才作为代码 token 保留
    if (/[._/]/.test(t) || /[a-z][A-Z]/.test(t)) {
      // 生成变体扩展
      const variants = generateVariants(t);
      for (const v of variants) {
        uniqueTokens.add(v);
      }
    }
  }

  // C. 自然语言分词 (Intl.Segmenter)
  const segmenter = getZhSegmenter();
  if (segmenter) {
    const segments = segmenter.segment(cleanRaw);
    for (const seg of segments) {
      if (seg.isWordLike) {
        const t = seg.segment.toLowerCase();
        if (t.trim().length > 0) {
          // 对分词结果也生成变体
          const variants = generateVariants(seg.segment);
          for (const v of variants) {
            uniqueTokens.add(v);
          }
        }
      }
    }
  } else {
    // 兜底：仅按空格和标点切分 (对中文无效，但聊胜于无)
    logger.warn('Intl.Segmenter 不可用，中文搜索将退化为精确匹配');
    for (const t of cleanRaw.split(/[\s\p{P}]+/u)) {
      if (t.length > 0) {
        const variants = generateVariants(t);
        for (const v of variants) {
          uniqueTokens.add(v);
        }
      }
    }
  }

  return Array.from(uniqueTokens);
}

/**
 * 词法搜索文件（双重查询策略）
 *
 * 策略一：精准查询 (AND) - 要求所有分词都存在
 * 策略二：宽容查询 (OR) - 结果不足时补录部分匹配
 *
 * @param db 数据库实例
 * @param query 搜索查询
 * @param limit 最大返回数量
 * @returns 按 BM25 得分排序的文件路径列表
 */
export function searchFilesFts(
  db: Database.Database,
  query: string,
  limit: number,
): FtsSearchResult[] {
  // 1. 使用统一分词器
  const tokens = segmentQuery(query);

  if (tokens.length === 0) {
    logger.debug('FTS 分词后无有效 token，跳过搜索');
    return [];
  }

  logger.debug(
    {
      rawQuery: query,
      tokens: tokens,
    },
    'FTS 分词结果',
  );

  // 辅助：执行 SQL 查询
  const runQuery = (qStr: string, queryLimit: number): FtsSearchResult[] => {
    try {
      const rows = db
        .prepare(`
                SELECT path, bm25(files_fts) as score
                FROM files_fts
                WHERE files_fts MATCH ?
                ORDER BY score
                LIMIT ?
            `)
        .all(qStr, queryLimit) as Array<{ path: string; score: number }>;

      // BM25 返回负值，转正
      return rows.map((r) => ({ path: r.path, score: -r.score }));
    } catch (_e) {
      return [];
    }
  };

  // 2. 策略一：精准查询 (AND)
  const strictQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
  const results = runQuery(strictQuery, limit);

  logger.debug({ type: 'strict', count: results.length, query: strictQuery }, 'FTS 精准搜索');

  // 3. 策略二：宽容查询 (OR) - 仅当结果不足时触发
  if (results.length < limit && tokens.length > 1) {
    const beforeCount = results.length;
    const remainingLimit = limit - results.length;
    const relaxedQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');

    const relaxedResults = runQuery(relaxedQuery, remainingLimit + 10); // 多取一点用于去重

    const existingPaths = new Set(results.map((r) => r.path));

    for (const row of relaxedResults) {
      if (!existingPaths.has(row.path)) {
        if (results.length >= limit) break;
        // 不做硬编码降权，BM25 自身会对缺词的结果打低分
        results.push(row);
        existingPaths.add(row.path);
      }
    }

    logger.debug(
      { type: 'relaxed', added: results.length - beforeCount, query: relaxedQuery },
      'FTS 宽容搜索补录',
    );
  }

  // 详细的召回日志
  logger.debug(
    {
      fileCount: results.length,
      topFiles: results.slice(0, 5).map((r) => ({
        path: r.path.split('/').slice(-2).join('/'),
        bm25: r.score.toFixed(3),
      })),
    },
    'FTS 召回结果',
  );

  return results.sort((a, b) => b.score - a.score);
}

/**
 * 检查 FTS 表是否已初始化
 */
export function isFtsInitialized(db: Database.Database): boolean {
  const result = db
    .prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='files_fts'
    `)
    .get();
  return !!result;
}
