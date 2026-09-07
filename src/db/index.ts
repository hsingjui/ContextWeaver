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
 * 迁移旧版索引布局（~/.contextweaver/<projectId>/ → ~/.contextweaver/index/<projectId>/）
 * 幂等：保留锁文件；目标存在同名文件时停止，避免覆盖或删除已有索引。
 */
export function migrateProjectIndex(projectId: string): void {
  const oldDir = path.join(BASE_DIR, projectId);
  const newDir = path.join(BASE_DIR, 'index', projectId);
  if (!fs.existsSync(oldDir)) return;
  // 只迁移真正的索引目录，避免误动其他文件
  const hasIndex =
    fs.existsSync(path.join(oldDir, 'index.db')) ||
    fs.existsSync(path.join(oldDir, 'vectors.lance'));
  if (!hasIndex) return;
  if (!fs.existsSync(newDir)) {
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    return;
  }

  // withLock 可能已创建目标目录；迁移内容时不能覆盖当前持有的锁。
  // 主文件最后搬移，中途失败时旧目录仍可识别，重试能继续处理剩余文件。
  const lastEntry = fs.existsSync(path.join(oldDir, 'index.db')) ? 'index.db' : 'vectors.lance';
  const entries = fs
    .readdirSync(oldDir)
    .filter((entry) => entry !== 'index.lock')
    .sort((a, b) => Number(a === lastEntry) - Number(b === lastEntry));
  for (const entry of entries) {
    if (fs.existsSync(path.join(newDir, entry))) {
      throw new Error(
        `索引迁移冲突，请先处理新旧目录中的同名文件：${oldDir} -> ${newDir} (${entry})`,
      );
    }
  }
  for (const entry of entries) {
    fs.renameSync(path.join(oldDir, entry), path.join(newDir, entry));
  }
  if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
}

/**
 * 初始化数据库连接
 * @param projectId 项目 ID
 * @returns 数据库实例
 */
export function initDb(projectId: string): Database.Database {
  migrateProjectIndex(projectId);
  // 确保目录存在
  const projectDir = path.join(BASE_DIR, 'index', projectId);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  const dbPath = path.join(projectDir, 'index.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
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

  // 文件删除的重试依据，必须在派生索引清理成功前保留。
  db.exec('CREATE TABLE IF NOT EXISTS pending_deletions (path TEXT PRIMARY KEY)');

  // 初始化 FTS 表（词法搜索支持）
  initFilesFts(db);
  initChunksFts(db);

  return db;
}

const sharedDbs = new Map<string, Database.Database>();

/** 搜索组件共享连接；扫描仍使用独立连接并自行关闭。 */
export function getSharedDb(projectId: string): Database.Database {
  let db = sharedDbs.get(projectId);
  if (!db?.open) {
    db = initDb(projectId);
    sharedDbs.set(projectId, db);
  }
  return db;
}

process.once('exit', () => {
  for (const db of sharedDbs.values()) {
    if (db.open) db.close();
  }
});

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
  if (files.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO files (path, hash, mtime, size, content, language)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      hash = excluded.hash,
      mtime = excluded.mtime,
      size = excluded.size,
      content = excluded.content,
      language = excluded.language,
      vector_index_hash = NULL
  `);

  const transaction = db.transaction((items: FileMeta[]) => {
    for (const item of items) {
      insert.run(item.path, item.hash, item.mtime, item.size, item.content, item.language);
    }
  });

  // 同步 FTS 索引
  // 使用类型守卫过滤 null，TypeScript 可以正确推断类型
  const ftsFiles: Array<{ path: string; content: string }> = [];
  for (const f of files) {
    if (f.content !== null) {
      ftsFiles.push({ path: f.path, content: f.content });
    }
  }
  db.transaction(() => {
    transaction(files);
    batchDeleteFileFts(
      db,
      files.filter((file) => file.content === null).map((file) => file.path),
    );
    if (ftsFiles.length > 0) batchUpsertFileFts(db, ftsFiles);
  })();
}

/**
 * 批量更新 mtime 和 size
 */
export function batchUpdateMtime(
  db: Database.Database,
  items: Array<{ path: string; mtime: number; size: number }>,
): void {
  if (items.length === 0) return;
  const update = db.prepare(`UPDATE files SET mtime = ?, size = ?
    WHERE path = ? AND (mtime != ? OR size != ?)`);

  const transaction = db.transaction((data: typeof items) => {
    for (const item of data) {
      update.run(item.mtime, item.size, item.path, item.mtime, item.size);
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
  if (paths.length === 0) return;
  const stmt = db.prepare('DELETE FROM files WHERE path = ?');
  const pending = db.prepare('INSERT OR IGNORE INTO pending_deletions(path) VALUES (?)');
  db.transaction(() => {
    for (const filePath of paths) {
      pending.run(filePath);
      stmt.run(filePath);
    }
    batchDeleteFileFts(db, paths);
  })();
}

export function getPendingDeletions(db: Database.Database): string[] {
  return (db.prepare('SELECT path FROM pending_deletions').all() as Array<{ path: string }>).map(
    (row) => row.path,
  );
}

export function completeDeletions(db: Database.Database, paths: string[]): void {
  db.prepare('DELETE FROM pending_deletions WHERE path IN (SELECT value FROM json_each(?))').run(
    JSON.stringify(paths),
  );
}

/** 使所有文件的派生索引过期；与配置指纹一起提交，失败后仍能继续补索引。 */
export function invalidateIndex(db: Database.Database, fingerprint?: string): void {
  db.transaction(() => {
    db.exec('UPDATE files SET vector_index_hash = NULL');
    if (fingerprint !== undefined) setMetadata(db, 'index_fingerprint', fingerprint);
  })();
}

export function getStoredIndexFingerprint(db: Database.Database): string | null {
  return getMetadata(db, 'index_fingerprint');
}

/**
 * 清空数据库
 */
export function clear(db: Database.Database): void {
  db.transaction(() => {
    db.exec(
      'DELETE FROM files; DELETE FROM files_fts; DELETE FROM chunks_fts; DELETE FROM fts_short_tokens; DELETE FROM fts_short_records; DELETE FROM fts_short_tokens_meta;',
    );
  })();
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
