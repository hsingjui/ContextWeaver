# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

- 质量门：`pnpm build` = tsup 打包 + `tsc --noEmit` 类型检查（`strict: true`）。
- 格式化/静态检查：**Biome**（`pnpm fmt` = `biome check --write ./src`）。
- 测试：**node:test**（`node --test --import tsx tests/*.test.ts`），无第三方测试框架。
- 未使用导出检查：knip（`knip.json`）。

## Biome Rules

配置文件 `biome.json`：

- 缩进 2 空格、行宽 100、单引号。
- linter 启用 recommended + `noUnusedTemplateLiteral` error 级。
- VCS 集成：仅格式化 git 跟踪文件；忽略 `dist`、`node_modules`、benchmark results。

## TypeScript Rules

- ESM：`"type": "module"`，相对导入必须带 `.js` 后缀。
- `verbatimModuleSyntax: true` → 类型导入必须用 `import type { ... }`，禁止混用类型/值导入。
- 严格模式：不明示 `any`；JSON 响应结构体全部定义 interface/type。
- 工具函数偏好纯函数 + 显式参数（如 `getAllFileMeta(db, ...)`），避免全局可变状态
  （唯一例外是单例服务：`getSharedDb` / `getVectorStore` / logger）。

## Testing Requirements

- 测试放 `tests/*.test.ts`，使用 `node:test` + `node:assert/strict`。
- 命名：`<模块>.test.ts`（如 `chunking.test.ts`、`coverage-selector.test.ts`）。
- 涉及真实数据的测试直接读源码构造 fixture，不 mock 文件系统。
- 回归测试：`tests/regressions.test.ts` 收集历史 bug 场景，禁止删除。
- 搜索/embedding 涉及网络/外部 API 的测试必须可离线运行或显式跳过。

## Code Review Standards

- 修改核心链路（索引、检索、DB schema）时必须检查影响面：`vector_index_hash`
  自愈机制、FTS 同步、pending_deletions 不能破坏。
- 对外行为（CLI 命令、MCP 工具 schema）变更需同步文档（README、MCP tool description）。
- 新增依赖必须评估：Node >= 22 内置能力优先（node:test、node:fs）。

## Forbidden Patterns

- 禁止 `any` 逃逸到公共 API；禁止 `// @ts-ignore` / `@ts-nocheck`（无例外记录）。
- 禁止在 MCP 工具路径用 `console.log`（污染 stdio，见 logging-guidelines）。
- 环境变量**加载**集中在 `src/config.ts`（loadEnv），但作用域配置项按现有惯例在消费模块直接读取：`IGNORE_PATTERNS` 在 `src/scanner/filter.ts`，`MAX_FILE_SIZE_BYTES` 在 `src/scanner/processor.ts`。新增环境变量遵循同样模式：在 config.ts 定义默认值/类型，消费模块按需读取并校验。
- 禁止在热路径（每次检索调用）创建新 DB 连接或重复探测 FTS tokenizer
  （有 WeakMap/共享连接缓存——沿用缓存模式）。