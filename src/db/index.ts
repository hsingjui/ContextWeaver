import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  batchDeleteFileFts,
  batchUpsertFileFts,
  initChunksFts,
  initFilesFts,
} from '../search/fts.js';

const BASE_DIR = path.join(os.homedir(), '.contextweaver');

/**
 * 文件元数据接口
 */
export interface FileMeta {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  content: string | null;
  language: string;
  /** 已成功写入向量索引的 hash（自愈机制核心字段） */
  vectorIndexHash: string | null;
}

/**
 * 获取目录的创建时间（birthtime）
 * 优先使用 .git 目录的创建时间，否则使用根目录的创建时间
 * @param projectPath 项目根路径
 * @returns 创建时间的毫秒时间戳，如果无法获取则返回 0
 */
function getDirectoryBirthtime(projectPath: string): number {
  // 优先检查 .git 目录（更稳定的仓库标识）
  const gitDir = path.join(projectPath, '.git');
  try {
    const gitStats = fs.statSync(gitDir);
    if (gitStats.isDirectory() && gitStats.birthtimeMs) {
      return Math.floor(gitStats.birthtimeMs);
    }
  } catch {
    // .git 目录不存在，继续检查根目录
  }

  // 使用根目录的创建时间
  try {
    const rootStats = fs.statSync(projectPath);
    if (rootStats.birthtimeMs) {
      return Math.floor(rootStats.birthtimeMs);
    }
  } catch {
    // 无法获取根目录信息
  }

  return 0;
}

/**
 * 生成项目唯一 ID
 * 基于路径 + 目录创建时间生成，确保删除后重建的同路径代码库会生成不同的 ID
 * @param projectPath 项目根路径
 * @returns 项目 ID (MD5 hash)
 */
export function generateProjectId(projectPath: string): string {
  const birthtime = getDirectoryBirthtime(projectPath);
  const uniqueKey = `${projectPath}::${birthtime}`;
  return crypto.createHash('md5').update(uniqueKey).digest('hex').slice(0, 10);
}

/**
 * 初始化数据库连接
 * @param projectId 项目 ID
 * @returns 数据库实例
 */
export function initDb(projectId: string): Database.Database {
  // 确保目录存在
  const projectDir = path.join(BASE_DIR, projectId);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  const dbPath = path.join(projectDir, 'index.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // 创建 files 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content TEXT,
      language TEXT NOT NULL,
      vector_index_hash TEXT
    )
  `);

  // 迁移：如果表已存在但缺少 vector_index_hash 列，添加它
  try {
    db.exec('ALTER TABLE files ADD COLUMN vector_index_hash TEXT');
  } catch {
    // 列已存在，忽略错误
  }

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime);
  `);

  // 创建 metadata 表（存储项目级配置）
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // 初始化 FTS 表（词法搜索支持）
  initFilesFts(db);
  initChunksFts(db);

  return db;
}

/**
 * 关闭数据库连接
 */
export function closeDb(db: Database.Database): void {
  db.close();
}

/**
 * 获取所有文件元数据
 */
export function getAllFileMeta(
  db: Database.Database,
): Map<string, Pick<FileMeta, 'mtime' | 'hash' | 'size' | 'vectorIndexHash'>> {
  const rows = db
    .prepare('SELECT path, hash, mtime, size, vector_index_hash FROM files')
    .all() as Array<{
    path: string;
    hash: string;
    mtime: number;
    size: number;
    vector_index_hash: string | null;
  }>;

  const map = new Map();
  for (const row of rows) {
    map.set(row.path, {
      mtime: row.mtime,
      hash: row.hash,
      size: row.size,
      vectorIndexHash: row.vector_index_hash,
    });
  }
  return map;
}

/**
 * 获取需要向量索引的文件路径
 * 自愈机制：返回 vector_index_hash != hash 的文件
 */
export function getFilesNeedingVectorIndex(db: Database.Database): string[] {
  const rows = db
    .prepare('SELECT path FROM files WHERE vector_index_hash IS NULL OR vector_index_hash != hash')
    .all() as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

/**
 * 批量更新 vector_index_hash
 * 只有当向量完整写入成功后才调用
 */
export function batchUpdateVectorIndexHash(
  db: Database.Database,
  items: Array<{ path: string; hash: string }>,
): void {
  const update = db.prepare('UPDATE files SET vector_index_hash = ? WHERE path = ?');

  const transaction = db.transaction((data: Array<{ path: string; hash: string }>) => {
    for (const item of data) {
      update.run(item.hash, item.path);
    }
  });

  transaction(items);
}

/**
 * 清除文件的 vector_index_hash（用于标记需要重新索引）
 */
export function clearVectorIndexHash(db: Database.Database, paths: string[]): void {
  const update = db.prepare('UPDATE files SET vector_index_hash = NULL WHERE path = ?');

  const transaction = db.transaction((items: string[]) => {
    for (const item of items) {
      update.run(item);
    }
  });

  transaction(paths);
}

/**
 * 批量插入/更新文件记录
 */
export function batchUpsert(db: Database.Database, files: FileMeta[]): void {
  const insert = db.prepare(`
    INSERT INTO files (path, hash, mtime, size, content, language)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      hash = excluded.hash,
      mtime = excluded.mtime,
      size = excluded.size,
      content = excluded.content,
      language = excluded.language
  `);

  const transaction = db.transaction((items: FileMeta[]) => {
    for (const item of items) {
      insert.run(item.path, item.hash, item.mtime, item.size, item.content, item.language);
    }
  });

  transaction(files);

  // 同步 FTS 索引
  // 使用类型守卫过滤 null，TypeScript 可以正确推断类型
  const ftsFiles: Array<{ path: string; content: string }> = [];
  for (const f of files) {
    if (f.content !== null) {
      ftsFiles.push({ path: f.path, content: f.content });
    }
  }
  if (ftsFiles.length > 0) {
    batchUpsertFileFts(db, ftsFiles);
  }
}

/**
 * 批量更新 mtime
 */
export function batchUpdateMtime(
  db: Database.Database,
  items: Array<{ path: string; mtime: number }>,
): void {
  const update = db.prepare('UPDATE files SET mtime = ? WHERE path = ?');

  const transaction = db.transaction((data: Array<{ path: string; mtime: number }>) => {
    for (const item of data) {
      update.run(item.mtime, item.path);
    }
  });

  transaction(items);
}

/**
 * 获取所有已索引的文件路径
 */
export function getAllPaths(db: Database.Database): string[] {
  const rows = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

/**
 * 批量删除文件
 */
export function batchDelete(db: Database.Database, paths: string[]): void {
  const stmt = db.prepare('DELETE FROM files WHERE path = ?');

  const transaction = db.transaction((items: string[]) => {
    for (const item of items) {
      stmt.run(item);
    }
  });

  transaction(paths);

  // 同步删除 FTS 索引
  if (paths.length > 0) {
    batchDeleteFileFts(db, paths);
  }
}

/**
 * 清空数据库
 */
export function clear(db: Database.Database): void {
  db.exec('DELETE FROM files');
}

// ===========================================
// Metadata 操作
// ===========================================

const METADATA_KEY_EMBEDDING_DIMENSIONS = 'embedding_dimensions';

/**
 * 获取 metadata 值
 */
function getMetadata(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * 设置 metadata 值
 */
function setMetadata(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/**
 * 获取存储的 embedding dimensions
 * @returns 存储的维度值，如果没有存储则返回 null
 */
export function getStoredEmbeddingDimensions(db: Database.Database): number | null {
  const value = getMetadata(db, METADATA_KEY_EMBEDDING_DIMENSIONS);
  if (value === null) return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 设置 embedding dimensions
 */
export function setStoredEmbeddingDimensions(db: Database.Database, dimensions: number): void {
  setMetadata(db, METADATA_KEY_EMBEDDING_DIMENSIONS, String(dimensions));
}
