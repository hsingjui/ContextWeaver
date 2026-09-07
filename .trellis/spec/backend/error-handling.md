# Error Handling

> How errors are handled in this project.

---

## Overview

- **不定义自定义错误类**，统一 `throw new Error('中文消息')`，消息包含可诊断上下文
  （文件、状态码、索引等）。错误消息使用中文，与日志语言一致。
- 三层处理策略：CLI 命令层、MCP 工具层、基础设施层（锁/API 客户端）。

## Error Types

项目没有自定义 error 类型。分类靠消息前缀约定：

- 配置缺失：`EMBEDDINGS_API_KEY 环境变量未设置`（`src/config.ts` 启动时抛）
- 初始化顺序：`VectorStore not initialized` / `SearchService not initialized`
- API 错误：`Embedding API 错误: HTTP ${response.status} - ${detail}`
- 并发锁冲突：`无法获取项目锁 (...)，其他进程正在操作索引`（`src/utils/lock.ts`）

## How Errors Are Propagated

- **内部模块**：抛错向上传播，不做包装。调用方决定是终止、降级还是重试。
- **可重试路径**（embedding API 429）：内部指数退避重试，重试耗尽才抛。

## CLI Layer (`src/index.ts`)

- 命令 action 内 try/catch：`logger.error({ err, stack }, '消息')` 后 `process.exit(1)`。
- 可恢复情况用 `logger.warn` 并继续（如 `.env` 已存在）。
- 环境变量加载失败是致命错误，此时 logger 未初始化，只能用 `console.error` + `process.exit(1)`。

## MCP Layer (`src/mcp/server.ts`)

所有工具调用统一在最外层 catch，返回 MCP 错误内容而非让异常逃逸：

```ts
} catch (err) {
  const error = err as { message?: string; stack?: string };
  logger.error({ error: error.message, stack: error.stack, tool: name }, '工具调用失败');
  return {
    content: [{ type: 'text', text: `Error: ${error.message}` }],
    isError: true,
  };
}
```

## Error Handling for Non-Fatal Paths

- 派生索引清理（`cleanupOldLogs`、`completeDeletions` 等）失败时静默忽略或仅 debug 日志，
  不中断主流程——用注释说明"失败不影响主流程"。
- `ALTER TABLE` 迁移冲突用空 catch 忽略（见 database-guidelines）。

## What NOT To Do

- 禁止把堆栈直接拼进给用户/LLM 的 MCP 返回文本（堆栈只进日志）。
- 禁止吞掉致命错误后继续写库（如 `vector_index_hash` 只在向量完整写入后更新）。