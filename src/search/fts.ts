/**
 * FTS (Full-Text Search) 模块
 *
 * 基于 SQLite FTS5 实现词法检索能力：
 * - 自动探测 tokenizer 支持（trigram > unicode61）
 * - 初始化和同步 files_fts 表
 * - 为短 token 维护 SQLite 倒排索引
 * - 提供文件级和 chunk 级搜索接口
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

// FTS Tokenizer 探测

/** 支持的 tokenizer 类型 */
type FtsTokenizer = 'trigram' | 'unicode61';

/** 缓存已探测的 tokenizer */
const tokenizerCache = new WeakMap<Database.Database, FtsTokenizer>();

type ShortTokenKind = 'file' | 'chunk';
const SHORT_TOKEN_INDEX_VERSION = 5;

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

/** 短 token 倒排索引；每条记录只保存去重后的单字符和连续汉字二元组。 */
function ensureShortTokenIndex(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fts_short_tokens (
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      token TEXT NOT NULL,
      PRIMARY KEY (kind, record_id, token)
    );
    CREATE INDEX IF NOT EXISTS idx_fts_short_tokens_lookup
      ON fts_short_tokens(kind, token, record_id);
    CREATE TABLE IF NOT EXISTS fts_short_records (
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_index INTEGER,
      source_rowid INTEGER NOT NULL,
      PRIMARY KEY (kind, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fts_short_records_path
      ON fts_short_records(kind, file_path);
    CREATE TABLE IF NOT EXISTS fts_short_tokens_meta (
      kind TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
  `);
  try {
    db.exec('ALTER TABLE fts_short_records ADD COLUMN source_rowid INTEGER');
  } catch {
    // 列已存在，或表刚按最新 schema 创建。
  }
}

/**
 * 生成可索引的短 token。
 * token 不跨空白，因此不会改变原 instr() 的匹配语义。
 */
function isHan(char: string): boolean {
  return /^\p{Script=Han}$/u.test(char);
}

function canUseShortTokenIndex(token: string): boolean {
  const chars = Array.from(token);
  return chars.length === 1 || (chars.length === 2 && chars.every(isHan));
}

function getShortTokens(values: string[]): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    const chars = Array.from(value.toLowerCase());
    for (let i = 0; i < chars.length; i++) {
      if (!/\s/u.test(chars[i])) tokens.add(chars[i]);
      if (i + 1 < chars.length && isHan(chars[i]) && isHan(chars[i + 1])) {
        tokens.add(chars[i] + chars[i + 1]);
      }
    }
  }
  return Array.from(tokens);
}

/** 重建某一类记录的短 token 索引。 */
function syncShortTokenIndex(db: Database.Database, kind: ShortTokenKind): void {
  ensureShortTokenIndex(db);
  const version = db
    .prepare('SELECT version FROM fts_short_tokens_meta WHERE kind = ?')
    .get(kind) as { version: number } | undefined;
  if (version?.version === SHORT_TOKEN_INDEX_VERSION) return;

  const sources =
    kind === 'file'
      ? (
          db.prepare('SELECT rowid, path, content FROM files_fts').all() as Array<{
            rowid: number;
            path: string;
            content: string | null;
          }>
        ).map((row) => ({
          recordId: row.path,
          filePath: row.path,
          chunkIndex: null,
          sourceRowid: row.rowid,
          values: [row.path, row.content ?? ''],
        }))
      : (
          db
            .prepare(
              'SELECT rowid, chunk_id, file_path, chunk_index, breadcrumb, content FROM chunks_fts',
            )
            .all() as Array<{
            rowid: number;
            chunk_id: string;
            file_path: string;
            chunk_index: number;
            breadcrumb: string | null;
            content: string | null;
          }>
        ).map((row) => ({
          recordId: row.chunk_id,
          filePath: row.file_path,
          chunkIndex: row.chunk_index,
          sourceRowid: row.rowid,
          values: [row.breadcrumb ?? '', row.content ?? ''],
        }));

  const deleteTokens = db.prepare('DELETE FROM fts_short_tokens WHERE kind = ?');
  const deleteRecords = db.prepare('DELETE FROM fts_short_records WHERE kind = ?');
  const insertRecord = db.prepare(
    'INSERT OR REPLACE INTO fts_short_records(kind, record_id, file_path, chunk_index, source_rowid) VALUES (?, ?, ?, ?, ?)',
  );
  const insertToken = db.prepare(
    'INSERT OR IGNORE INTO fts_short_tokens(kind, record_id, token) VALUES (?, ?, ?)',
  );
  const setVersion = db.prepare(`
    INSERT INTO fts_short_tokens_meta(kind, version) VALUES (?, ?)
    ON CONFLICT(kind) DO UPDATE SET version = excluded.version
  `);

  db.transaction((items: typeof sources) => {
    deleteTokens.run(kind);
    deleteRecords.run(kind);
    for (const source of items) {
      insertRecord.run(
        kind,
        source.recordId,
        source.filePath,
        source.chunkIndex,
        source.sourceRowid,
      );
      for (const token of getShortTokens(source.values)) {
        insertToken.run(kind, source.recordId, token);
      }
    }
    setVersion.run(kind, SHORT_TOKEN_INDEX_VERSION);
  })(sources);
}

/** 主 FTS 被重建后，短 token 索引也必须重新生成。 */
function invalidateShortTokenIndex(db: Database.Database, kind: ShortTokenKind): void {
  ensureShortTokenIndex(db);
  db.prepare('DELETE FROM fts_short_tokens_meta WHERE kind = ?').run(kind);
}

/**
 * 短 token 使用 SQLite 倒排索引；不支持的 tokenizer 或短 token 形式保留 substring fallback。
 * ponytail: 倒排索引以写入和存储换取短查询延迟；若存储占比过高，再改为压缩 posting list。
 */
function searchShortTokenIndex<T>(
  db: Database.Database,
  kind: ShortTokenKind,
  tokens: string[],
  limit: number,
): T[] {
  syncShortTokenIndex(db, kind);
  const tokenJson = JSON.stringify(tokens.map((token) => token.toLowerCase()));
  const query =
    kind === 'file'
      ? `SELECT r.record_id AS path, COUNT(*) AS score
         FROM fts_short_tokens AS s
         JOIN fts_short_records AS r
           ON r.kind = s.kind AND r.record_id = s.record_id
         WHERE s.kind = 'file' AND s.token IN (SELECT value FROM json_each(?))
         GROUP BY r.record_id
         ORDER BY score DESC, r.record_id
         LIMIT ?`
      : `SELECT r.record_id AS chunkId, r.file_path AS filePath, r.chunk_index AS chunkIndex,
                COUNT(*) AS score
         FROM fts_short_tokens AS s
         JOIN fts_short_records AS r
           ON r.kind = s.kind AND r.record_id = s.record_id
         WHERE s.kind = 'chunk' AND s.token IN (SELECT value FROM json_each(?))
         GROUP BY r.record_id
         ORDER BY score DESC, r.record_id
         LIMIT ?`;
  return db.prepare(query).all(tokenJson, limit) as T[];
}

/** 直接扫描原文的兼容 fallback。 */
function searchSubstringsScan<T>(
  db: Database.Database,
  table: 'files_fts' | 'chunks_fts',
  columns: string[],
  select: string,
  tokens: string[],
  limit: number,
): T[] {
  const score = tokens
    .map(() => `(${columns.map((column) => `instr(lower(${column}), ?) > 0`).join(' OR ')})`)
    .join(' + ');
  const params = tokens.flatMap((token) => columns.map(() => token.toLowerCase()));
  return db
    .prepare(`SELECT ${select}, (${score}) AS score FROM ${table}
      WHERE (${score}) > 0 ORDER BY score DESC, rowid LIMIT ?`)
    .all(...params, ...params, limit) as T[];
}

/** 用短 token 倒排索引和 trigram MATCH 先取候选，再精确计算原有 substring score。 */
function searchIndexedSubstrings<T>(
  db: Database.Database,
  kind: ShortTokenKind,
  table: 'files_fts' | 'chunks_fts',
  columns: string[],
  select: string,
  tokens: string[],
  limit: number,
): T[] {
  const shortTokens = tokens.filter((token) => Array.from(token).length < 3);
  if (
    shortTokens.length === 0 ||
    shortTokens.length === tokens.length ||
    !shortTokens.every(canUseShortTokenIndex) ||
    detectFtsTokenizer(db) !== 'trigram'
  ) {
    return searchSubstringsScan(db, table, columns, select, tokens, limit);
  }

  syncShortTokenIndex(db, kind);
  const longTokens = tokens.filter((token) => Array.from(token).length >= 3);
  const longQuery = longTokens.map((token) => `"${token.replace(/"/g, '')}"`).join(' OR ');
  const score = tokens
    .map(() => `(${columns.map((column) => `instr(lower(${column}), ?) > 0`).join(' OR ')})`)
    .join(' + ');
  const scoreParams = tokens.flatMap((token) => columns.map(() => token.toLowerCase()));
  const shortTokenJson = JSON.stringify(shortTokens.map((token) => token.toLowerCase()));
  const query = `WITH candidates AS (
      SELECT r.source_rowid
      FROM fts_short_tokens AS s
      JOIN fts_short_records AS r
        ON r.kind = s.kind AND r.record_id = s.record_id
      WHERE s.kind = ? AND s.token IN (SELECT value FROM json_each(?))
      UNION
      SELECT rowid FROM ${table} WHERE ${table} MATCH ?
    )
    SELECT ${select}, (${score}) AS score
    FROM ${table}
    WHERE rowid IN (SELECT source_rowid FROM candidates)
      AND (${score}) > 0
    ORDER BY score DESC, rowid
    LIMIT ?`;
  return db
    .prepare(query)
    .all(kind, shortTokenJson, longQuery, ...scoreParams, ...scoreParams, limit) as T[];
}

/** 混合长短 token 查询优先走索引；不支持的 tokenizer 保留原 fallback。 */
function searchSubstrings<T>(
  db: Database.Database,
  table: 'files_fts' | 'chunks_fts',
  columns: string[],
  select: string,
  tokens: string[],
  limit: number,
): T[] {
  const shortTokens = tokens.filter((token) => Array.from(token).length < 3);
  if (shortTokens.length > 0) {
    const kind = table === 'files_fts' ? 'file' : 'chunk';
    return searchIndexedSubstrings(db, kind, table, columns, select, tokens, limit);
  }
  return searchSubstringsScan(db, table, columns, select, tokens, limit);
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

  syncShortTokenIndex(db, 'file');
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
    invalidateShortTokenIndex(db, 'file');

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

  syncShortTokenIndex(db, 'chunk');
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
  replacePaths?: string[],
): void {
  syncShortTokenIndex(db, 'chunk');
  // 文件替换路径不需要逐 chunk 查重；普通 upsert 也只扫描一次。
  const ids = JSON.stringify(replacePaths ?? chunks.map((item) => item.chunkId));
  const deleteShortTokens = db.prepare(
    replacePaths
      ? `DELETE FROM fts_short_tokens
         WHERE kind = 'chunk' AND record_id IN (
           SELECT record_id FROM fts_short_records
           WHERE kind = 'chunk' AND file_path IN (SELECT value FROM json_each(?))
         )`
      : `DELETE FROM fts_short_tokens
         WHERE kind = 'chunk' AND record_id IN (SELECT value FROM json_each(?))`,
  );
  const deleteShortRecords = db.prepare(
    replacePaths
      ? `DELETE FROM fts_short_records
         WHERE kind = 'chunk' AND file_path IN (SELECT value FROM json_each(?))`
      : `DELETE FROM fts_short_records
         WHERE kind = 'chunk' AND record_id IN (SELECT value FROM json_each(?))`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM chunks_fts WHERE ${replacePaths ? 'file_path' : 'chunk_id'} IN (SELECT value FROM json_each(?))`,
  );
  const insertStmt = db.prepare(
    'INSERT INTO chunks_fts(chunk_id, file_path, chunk_index, breadcrumb, content) VALUES (?, ?, ?, ?, ?)',
  );
  const insertShortRecord = db.prepare(
    'INSERT OR REPLACE INTO fts_short_records(kind, record_id, file_path, chunk_index, source_rowid) VALUES (?, ?, ?, ?, ?)',
  );
  const insertShortToken = db.prepare(
    'INSERT OR IGNORE INTO fts_short_tokens(kind, record_id, token) VALUES (?, ?, ?)',
  );

  const transaction = db.transaction((items: typeof chunks) => {
    deleteShortTokens.run(ids);
    deleteShortRecords.run(ids);
    deleteStmt.run(ids);
    for (const item of items) {
      const inserted = insertStmt.run(
        item.chunkId,
        item.filePath,
        item.chunkIndex,
        item.breadcrumb,
        item.content,
      );
      insertShortRecord.run(
        'chunk',
        item.chunkId,
        item.filePath,
        item.chunkIndex,
        Number(inserted.lastInsertRowid),
      );
      for (const token of getShortTokens([item.breadcrumb, item.content])) {
        insertShortToken.run('chunk', item.chunkId, token);
      }
    }
  });

  transaction(chunks);
}

/**
 * 批量删除文件的 chunk FTS 索引
 */
export function batchDeleteFileChunksFts(db: Database.Database, filePaths: string[]): void {
  if (filePaths.length === 0) return;
  syncShortTokenIndex(db, 'chunk');
  const paths = JSON.stringify(filePaths);
  db.transaction(() => {
    db.prepare(
      `DELETE FROM fts_short_tokens
       WHERE kind = 'chunk' AND record_id IN (
         SELECT record_id FROM fts_short_records
         WHERE kind = 'chunk' AND file_path IN (SELECT value FROM json_each(?))
       )`,
    ).run(paths);
    db.prepare(
      `DELETE FROM fts_short_records
       WHERE kind = 'chunk' AND file_path IN (SELECT value FROM json_each(?))`,
    ).run(paths);
    db.prepare('DELETE FROM chunks_fts WHERE file_path IN (SELECT value FROM json_each(?))').run(
      paths,
    );
  })();
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

  const shortTokens = tokens.filter((token) => Array.from(token).length < 3);
  if (shortTokens.length === tokens.length && tokens.every(canUseShortTokenIndex)) {
    return searchShortTokenIndex<ChunkFtsResult>(db, 'chunk', shortTokens, limit);
  }
  if (shortTokens.length > 0) {
    return searchSubstrings<ChunkFtsResult>(
      db,
      'chunks_fts',
      ['breadcrumb', 'content'],
      'chunk_id AS chunkId, file_path AS filePath, chunk_index AS chunkIndex',
      tokens,
      limit,
    );
  }

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
  if (files.length === 0) return;
  syncShortTokenIndex(db, 'file');
  const paths = JSON.stringify(files.map((item) => item.path));
  const deleteFts = db.prepare(
    'DELETE FROM files_fts WHERE path IN (SELECT value FROM json_each(?))',
  );
  const deleteShortTokens = db.prepare(
    `DELETE FROM fts_short_tokens
     WHERE kind = 'file' AND record_id IN (SELECT value FROM json_each(?))`,
  );
  const deleteShortRecords = db.prepare(
    `DELETE FROM fts_short_records
     WHERE kind = 'file' AND record_id IN (SELECT value FROM json_each(?))`,
  );
  const insertFts = db.prepare('INSERT INTO files_fts(path, content) VALUES (?, ?)');
  const insertShortRecord = db.prepare(
    'INSERT OR REPLACE INTO fts_short_records(kind, record_id, file_path, chunk_index, source_rowid) VALUES (?, ?, ?, ?, ?)',
  );
  const insertShortToken = db.prepare(
    'INSERT OR IGNORE INTO fts_short_tokens(kind, record_id, token) VALUES (?, ?, ?)',
  );

  const transaction = db.transaction((items: Array<{ path: string; content: string }>) => {
    deleteShortTokens.run(paths);
    deleteShortRecords.run(paths);
    deleteFts.run(paths);
    for (const item of items) {
      const inserted = insertFts.run(item.path, item.content);
      insertShortRecord.run('file', item.path, item.path, null, Number(inserted.lastInsertRowid));
      for (const token of getShortTokens([item.path, item.content])) {
        insertShortToken.run('file', item.path, token);
      }
    }
  });

  transaction(files);
}

/**
 * 批量删除 FTS 索引记录
 */
export function batchDeleteFileFts(db: Database.Database, paths: string[]): void {
  if (paths.length === 0) return;
  syncShortTokenIndex(db, 'file');
  const pathJson = JSON.stringify(paths);
  db.transaction(() => {
    db.prepare(
      `DELETE FROM fts_short_tokens
       WHERE kind = 'file' AND record_id IN (SELECT value FROM json_each(?))`,
    ).run(pathJson);
    db.prepare(
      `DELETE FROM fts_short_records
       WHERE kind = 'file' AND record_id IN (SELECT value FROM json_each(?))`,
    ).run(pathJson);
    db.prepare('DELETE FROM files_fts WHERE path IN (SELECT value FROM json_each(?))').run(
      pathJson,
    );
  })();
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

const tokenBoundaryRegexCache = new Map<string, RegExp>();

/** 搜索与 import 扩展共享预编译的 token 边界正则。 */
export function getTokenBoundaryRegex(token: string): RegExp {
  let regex = tokenBoundaryRegexCache.get(token);
  if (!regex) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(`\\b${escaped}\\b`);
    tokenBoundaryRegexCache.set(token, regex);
  }
  return regex;
}

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

  const shortTokens = tokens.filter((token) => Array.from(token).length < 3);
  if (shortTokens.length === tokens.length && tokens.every(canUseShortTokenIndex)) {
    return searchShortTokenIndex<FtsSearchResult>(db, 'file', shortTokens, limit);
  }
  if (shortTokens.length > 0) {
    return searchSubstrings<FtsSearchResult>(
      db,
      'files_fts',
      ['path', 'content'],
      'path',
      tokens,
      limit,
    );
  }

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
