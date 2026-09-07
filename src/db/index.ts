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
  /** 已成功写入 exact-symbol 索引的 hash；失败时保留旧 rows 并保持待重试。 */
  symbolIndexHash: string | null;
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
      vector_index_hash TEXT,
      symbol_index_hash TEXT
    )
  `);

  // 迁移：补齐派生索引状态列。
  try {
    db.exec('ALTER TABLE files ADD COLUMN vector_index_hash TEXT');
  } catch {
    // 列已存在，忽略错误
  }
  try {
    db.exec('ALTER TABLE files ADD COLUMN symbol_index_hash TEXT');
  } catch {
    // 列已存在，忽略错误
  }

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime);
  `);

  // 创建 metadata 表（存储项目级配置）
  initMetadata(db);

  // 文件删除的重试依据，必须在派生索引清理成功前保留。
  db.exec('CREATE TABLE IF NOT EXISTS pending_deletions (path TEXT PRIMARY KEY)');

  // 派生代码索引。
  initSymbolOccurrences(db);
  initDependencyGraph(db);

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
): Map<string, Pick<FileMeta, 'mtime' | 'hash' | 'size' | 'vectorIndexHash' | 'symbolIndexHash'>> {
  const rows = db
    .prepare('SELECT path, hash, mtime, size, vector_index_hash, symbol_index_hash FROM files')
    .all() as Array<{
    path: string;
    hash: string;
    mtime: number;
    size: number;
    vector_index_hash: string | null;
    symbol_index_hash: string | null;
  }>;

  const map = new Map();
  for (const row of rows) {
    map.set(row.path, {
      mtime: row.mtime,
      hash: row.hash,
      size: row.size,
      vectorIndexHash: row.vector_index_hash,
      symbolIndexHash: row.symbol_index_hash,
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

/** 仅在 exact-symbol extraction 成功后推进 symbol_index_hash。 */
export function batchUpdateSymbolIndexHash(
  db: Database.Database,
  items: Array<{ path: string; hash: string }>,
): void {
  if (items.length === 0) return;
  const update = db.prepare('UPDATE files SET symbol_index_hash = ? WHERE path = ?');
  for (const item of items) update.run(item.hash, item.path);
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
      vector_index_hash = NULL,
      symbol_index_hash = NULL
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

export function initSymbolOccurrences(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbol_occurrences (
      identifier TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_index INTEGER NOT NULL,
      end_index INTEGER NOT NULL,
      PRIMARY KEY (file_path, identifier, kind, start_index, end_index)
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_identifier ON symbol_occurrences(identifier);
    CREATE INDEX IF NOT EXISTS idx_symbol_file_path ON symbol_occurrences(file_path);
  `);
}

export type DependencyKind = 'import' | 'export' | 'reexport';

export interface DependencyEdge {
  fromPath: string;
  toPath: string;
  kind: DependencyKind;
}

export function initDependencyGraph(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dependencies (
      from_path TEXT NOT NULL,
      to_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (from_path, to_path, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_dependencies_from ON dependencies(from_path);
    CREATE INDEX IF NOT EXISTS idx_dependencies_to ON dependencies(to_path);
  `);
}

export function replaceDependencyGraph(db: Database.Database, edges: DependencyEdge[]): void {
  initDependencyGraph(db);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO dependencies(from_path, to_path, kind) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    db.exec('DELETE FROM dependencies');
    for (const edge of edges) insert.run(edge.fromPath, edge.toPath, edge.kind);
  })();
}

/** Replace only outgoing edges for changed source files. Incoming edges remain valid. */
export function replaceDependencyEdgesForSources(
  db: Database.Database,
  sourcePaths: string[],
  edges: DependencyEdge[],
): void {
  if (sourcePaths.length === 0) return;
  initDependencyGraph(db);
  const remove = db.prepare('DELETE FROM dependencies WHERE from_path = ?');
  const insert = db.prepare(
    'INSERT OR IGNORE INTO dependencies(from_path, to_path, kind) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    for (const sourcePath of sourcePaths) remove.run(sourcePath);
    for (const edge of edges) insert.run(edge.fromPath, edge.toPath, edge.kind);
  })();
}

function deleteDependencyEdges(db: Database.Database, filePaths: string[]): void {
  if (filePaths.length === 0) return;
  initDependencyGraph(db);
  db.prepare(`
    DELETE FROM dependencies
    WHERE from_path IN (SELECT value FROM json_each(?))
       OR to_path IN (SELECT value FROM json_each(?))
  `).run(JSON.stringify(filePaths), JSON.stringify(filePaths));
}

export function getDependencyEdges(
  db: Database.Database,
  filePaths: string[],
  direction: 'forward' | 'reverse' | 'both',
): DependencyEdge[] {
  if (filePaths.length === 0) return [];
  initDependencyGraph(db);
  const json = JSON.stringify(filePaths);
  const clauses: string[] = [];
  const params: string[] = [];
  if (direction === 'forward' || direction === 'both') {
    clauses.push('from_path IN (SELECT value FROM json_each(?))');
    params.push(json);
  }
  if (direction === 'reverse' || direction === 'both') {
    clauses.push('to_path IN (SELECT value FROM json_each(?))');
    params.push(json);
  }
  return db
    .prepare(
      `SELECT from_path, to_path, kind FROM dependencies WHERE ${clauses.join(' OR ')} ORDER BY from_path, to_path`,
    )
    .all(...params)
    .map((row) => {
      const item = row as { from_path: string; to_path: string; kind: DependencyKind };
      return { fromPath: item.from_path, toPath: item.to_path, kind: item.kind };
    });
}

export interface SymbolOccurrence {
  identifier: string;
  kind: string;
  filePath: string;
  chunkIndex: number;
  startIndex: number;
  endIndex: number;
}

export function batchReplaceSymbolOccurrences(
  db: Database.Database,
  filePaths: string[],
  occurrences: SymbolOccurrence[],
): void {
  if (filePaths.length === 0) return;
  const remove = db.prepare('DELETE FROM symbol_occurrences WHERE file_path = ?');
  const insert = db.prepare(`
    INSERT INTO symbol_occurrences
      (identifier, kind, file_path, chunk_index, start_index, end_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const filePath of filePaths) remove.run(filePath);
  for (const item of occurrences) {
    insert.run(
      item.identifier,
      item.kind,
      item.filePath,
      item.chunkIndex,
      item.startIndex,
      item.endIndex,
    );
  }
}

export function batchDeleteSymbolOccurrences(db: Database.Database, filePaths: string[]): void {
  if (filePaths.length === 0) return;
  const remove = db.prepare('DELETE FROM symbol_occurrences WHERE file_path = ?');
  for (const filePath of filePaths) remove.run(filePath);
}

export function searchSymbolOccurrences(
  db: Database.Database,
  identifiers: string[],
  limit = 40,
): SymbolOccurrence[] {
  if (identifiers.length === 0) return [];
  const rows = db
    .prepare(`
      SELECT identifier, kind, file_path, chunk_index, start_index, end_index
      FROM symbol_occurrences
      WHERE identifier IN (SELECT value FROM json_each(?))
      ORDER BY
        CASE kind
          WHEN 'class' THEN 0
          WHEN 'interface' THEN 1
          WHEN 'function' THEN 2
          WHEN 'method' THEN 3
          WHEN 'constructor' THEN 4
          WHEN 'type' THEN 5
          ELSE 6
        END,
        file_path, start_index
      LIMIT ?
    `)
    .all(JSON.stringify(identifiers), limit) as Array<{
    identifier: string;
    kind: string;
    file_path: string;
    chunk_index: number;
    start_index: number;
    end_index: number;
  }>;
  const order = new Map(identifiers.map((identifier, index) => [identifier, index]));
  return rows
    .map((row) => ({
      identifier: row.identifier,
      kind: row.kind,
      filePath: row.file_path,
      chunkIndex: row.chunk_index,
      startIndex: row.start_index,
      endIndex: row.end_index,
    }))
    .sort((a, b) => (order.get(a.identifier) ?? 999) - (order.get(b.identifier) ?? 999));
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
    batchDeleteSymbolOccurrences(db, paths);
    deleteDependencyEdges(db, paths);
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
    db.exec('UPDATE files SET vector_index_hash = NULL, symbol_index_hash = NULL');
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
  // Some focused tests/consumers create a minimal DB without going through initDb.
  // Ensure newly-added derived tables exist before clearing them.
  initSymbolOccurrences(db);
  initDependencyGraph(db);
  db.transaction(() => {
    db.exec(
      'DELETE FROM files; DELETE FROM files_fts; DELETE FROM chunks_fts; DELETE FROM symbol_occurrences; DELETE FROM dependencies; DELETE FROM fts_short_tokens; DELETE FROM fts_short_records; DELETE FROM fts_short_tokens_meta;',
    );
  })();
}

// ===========================================
// Metadata 操作
// ===========================================

const METADATA_KEY_EMBEDDING_DIMENSIONS = 'embedding_dimensions';
const METADATA_KEY_DEPENDENCY_GRAPH_VERSION = 'dependency_graph_version';

function initMetadata(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/**
 * 获取 metadata 值
 */
function getMetadata(db: Database.Database, key: string): string | null {
  initMetadata(db);
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * 设置 metadata 值
 */
function setMetadata(db: Database.Database, key: string, value: string): void {
  initMetadata(db);
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/**
 * 设置 embedding dimensions
 */
export function setStoredEmbeddingDimensions(db: Database.Database, dimensions: number): void {
  setMetadata(db, METADATA_KEY_EMBEDDING_DIMENSIONS, String(dimensions));
}

/** Dependency graph parser/schema version stored with the project index. */
export function getStoredDependencyGraphVersion(db: Database.Database): number | null {
  const value = getMetadata(db, METADATA_KEY_DEPENDENCY_GRAPH_VERSION);
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function setStoredDependencyGraphVersion(db: Database.Database, version: number): void {
  setMetadata(db, METADATA_KEY_DEPENDENCY_GRAPH_VERSION, String(version));
}

/** Return indexed symbol names that actually exist, preserving query-token order. */
export function findExistingSymbolIdentifiers(
  db: Database.Database,
  identifiers: string[],
): string[] {
  if (identifiers.length === 0) return [];
  initSymbolOccurrences(db);
  const rows = db
    .prepare(`
      SELECT DISTINCT identifier
      FROM symbol_occurrences
      WHERE identifier IN (SELECT value FROM json_each(?))
    `)
    .all(JSON.stringify(identifiers)) as Array<{ identifier: string }>;
  const existing = new Set(rows.map((row) => row.identifier));
  return identifiers.filter((identifier) => existing.has(identifier));
}
