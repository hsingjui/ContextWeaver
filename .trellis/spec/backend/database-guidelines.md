# Database Guidelines

> Database patterns and conventions for this project.

---

## Overview

- **SQLite**，驱动为 **better-sqlite3**（同步 API，无 ORM、无 query builder、无迁移框架）。
- 每个索引项目一个独立数据库文件：`~/.contextweaver/<projectId>/index.db`，
  `projectId` 由 `generateProjectId()` 生成（路径 + 目录 birthtime 的 MD5 前 10 位）。
- 除 SQLite 外还有 **LanceDB**（向量存储，见 `src/vectorStore/`），两者通过
  `vector_index_hash` 字段保持一致性（自愈机制）。

## Schema & Migration

- 建表用 `CREATE TABLE IF NOT EXISTS`（`src/db/index.ts` 的 `initDb()`）。
- 加列等迁移用手写 `ALTER TABLE`，包在 try/catch 里忽略"已存在"错误：

```ts
try {
  db.exec('ALTER TABLE files ADD COLUMN vector_index_hash TEXT');
} catch {
  // 列已存在，忽略错误
}
```

- 表结构（snake_case 列名）：
  - `files(path TEXT PRIMARY KEY, hash, mtime, size, content, language, vector_index_hash)`
  - `metadata(key TEXT PRIMARY KEY, value TEXT)` — 项目级配置（embedding 维度、索引指纹）
  - `pending_deletions(path TEXT PRIMARY KEY)` — 删除重试依据，派生索引清理成功前保留
  - FTS5 虚拟表 `files_fts` / `chunks_fts` 及短 token 倒排表，定义在 `src/search/fts.ts`

## Query Patterns

- 总是使用 prepared statement + 类型化参数，批量操作包在 `db.transaction()` 中：

```ts
const insert = db.prepare(`INSERT INTO files (path, hash, mtime, size, content, language)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET ...`);
const tx = db.transaction((items: FileMeta[]) => {
  for (const item of items) insert.run(item.path, ...);
});
tx(files);
```

- 读取结果手动断言行类型（`as Array<{ path: string }>`），没有 ORM 类型映射。
- 函数签名显式接收 `db: Database.Database` 作为第一个参数（模块级纯函数，不持有连接状态）。

## Connections

- `initDb()` 时设置 `pragma('busy_timeout = 5000')` 和 `journal_mode = WAL`。
- 搜索组件通过 `getSharedDb(projectId)` 共享连接（进程退出时统一关闭）；
  索引（scan）流程使用独立连接并在结束时自行 `closeDb()`。

## Naming Conventions

- 表名：复数 snake_case（`files`、`pending_deletions`）。
- 列名：snake_case（`vector_index_hash`、`mtime`）。
- 批量函数以 `batch*` 前缀命名（`batchUpsert`、`batchDelete`、`batchUpdateMtime`）。

## Forbidden Patterns

- 禁止 ORM/迁移框架（项目用原生 better-sqlite3 + 手写 SQL）。
- 禁止在事务中途做网络请求（embedding 调用在写库之前完成）。
- 禁止字符串拼接 SQL 用户输入；`pending_deletions` 清理用 `json_each(?)` 传 JSON 数组。