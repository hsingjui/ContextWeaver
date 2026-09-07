# Logging Guidelines

> How logging is done in this project.

---

## Overview

- 日志库：**pino**（v10）。日志消息用**中文**。
- 统一通过 `src/utils/logger.ts` 导出的单例 `logger` 使用；不直接 `console.log`
  （会污染 stdout，MCP 模式需要纯净 stdout，见下）。

## Output & Format

- 写入文件 `~/.contextweaver/logs/app.YYYY-MM-DD.log`（按天轮转），保留 7 天（启动时清理）。
- logger 内部自定义 Writable stream，把 pino JSON 格式化为人类可读单行：

```
2026-09-07 10:13:00 [INFO] 索引完成 {"projectId":"a1b2c3d4e5","totalFiles":120}
```

- 非 MCP 模式：同时输出到文件 + 彩色控制台（自定义 stream，不依赖 pino-pretty）。
- **MCP 模式**（`isMcpMode`，进程参数含 `mcp`）：控制台输出被禁用，日志只写文件。

## Log Levels

- 级别：`NODE_ENV=dev` 时 `debug`，否则 `info`（`src/config.ts` 的 `isDev`）。
- 语义：`debug` = 内部流程细节（FTS 命中、tokenizer 降级、重试退避）；
  `info` = 生命周期事件（初始化、索引完成、MCP 启动）；
  `warn` = 可恢复异常（文件已存在、速率限制节流）；
  `error` = 失败操作（工具调用失败、目录创建失败）。

## Structured Fields

按 pino 惯例，字段对象放第一个参数，消息放第二个：

```ts
logger.info(
  { projectId: projectId.slice(0, 10), totalFiles: stats.totalFiles, elapsedMs },
  '索引完成',
);
logger.error({ error: error.message, stack: error.stack, tool: name }, '工具调用失败');
```

- 项目 ID 只记前 10 位；敏感信息（API key）一律不记。
- 惰性求值：debug 日志的构造开销用 `isDebugEnabled()` 保护：

```ts
if (isDebugEnabled()) {
  logger.debug({ stats: computeExpensive() }, '调试信息');
}
```

## What Should NOT Be Logged

- API key / token / 完整 .env 内容。
- 完整 embedding 向量数组。
- `console.log` 一律禁止用于日志（MCP 下污染 stdio）；logger 不可用时的兜底用
  `console.error`（如 config 加载失败、日志写入失败降级）。