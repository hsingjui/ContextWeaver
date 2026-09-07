# 实施计划：本地嵌入模型

## 实施清单

- [x] 1. 增加 `@huggingface/transformers` 运行时依赖并更新 `pnpm-lock.yaml`；不直接增加 ONNX Runtime、下载器或其他模型依赖。
- [x] 2. 新增固定三模型目录，写入配置值、展示名、参数量、repo、固定 revision、q8、维度、上下文上限、query/document 变换、pooling 与向量空间版本；实现模型专属目录和安装标记读写。
- [x] 3. 实现 install/list/use/remove 生命周期：显式下载、离线状态读取、原子更新用户 `.env`、单模型幂等删除；所有模型参数只接受固定目录值。
- [x] 4. 在 `src/config.ts` 增加 local/remote 判别配置、EmbeddingGemma 默认值和旧远程配置兼容；让本地检查不再要求 API Key/Base URL，远程解析保持原语义。
- [x] 5. 扩展 `src/utils/envTemplate.ts` 的答案类型和模板：本地默认写 provider/model，远程继续写现有 API 字段；MCP 自动补建继续复用该入口。
- [x] 6. 新增本地 Embedding 客户端：离线延迟加载和进程内复用；按 Jina、EmbeddingGemma、Qwen 各自规则处理 query/document、pooling、归一化、上下文截断和输出校验。
- [x] 7. 在现有 embedding 模块增加最小公共契约和 provider 分发；保留远程 `EmbeddingClient` 的 HTTP、限流、重试、长文本拆分和校验逻辑，仅调整 `Indexer` 的成员类型。
- [x] 8. 扩展扫描索引指纹，纳入 provider、模型、local revision/dtype/dimensions/document-input-space-version 或 remote base URL，沿用现有失效和自愈事务。
- [x] 9. 在现有 `src/cli/` 中实现 `model install|list|use|remove [model]`，复用 select、Spinner、ProgressBar 和主题输出；由 `src/index.ts` 注册命令并保持非 TTY 行为确定。
- [x] 10. 扩展交互式与默认 `init`：内置本地模型为默认 provider，EmbeddingGemma 为默认模型，不自动下载；Ollama/LM Studio 等 HTTP 服务继续标记为 remote。
- [x] 11. 扩展 `doctor`：本地只检查目录和安装标记，远程保持 HTTP probe；确认 MCP 配置创建和错误输出不会污染 stdio。
- [x] 12. 更新 README：默认安装流程、三模型列表、四个模型命令、缓存位置、模型许可、远程兼容配置，以及 Reranker 仍依赖远程服务。
- [ ] 13. 增加聚焦测试，不下载真实模型：provider 解析与旧配置兼容、模板/向导分支、目录查询、状态幂等性、`use` 原子配置更新、模型输入规则、向量数量/顺序/维度/有限值校验、指纹变化和 MCP stdout 约束。
- [ ] 14. 审查最终 diff，确认没有覆盖现有 CLI 功能，没有改变远程 Embedding 行为、索引自愈事务或无关模块。

## 验证计划

以下验证在用户批准本计划（包括测试修改与命令执行）并进入实施阶段后执行：

```bash
pnpm fmt
pnpm build
pnpm test
node dist/index.js --help
node dist/index.js model list
```

使用项目内临时 HOME 验证初始化和模型管理，避免修改真实 `~/.contextweaver`：

```bash
HOME="$PWD/test-output/local-embedding-home" node dist/index.js init --defaults
HOME="$PWD/test-output/local-embedding-home" node dist/index.js model list
```

自动测试通过依赖注入或 mock Transformers.js loader 验证三模型推理契约，不访问 Hugging Face。真实 q8 安装与推理会产生数百 MB 下载和明显 CPU 开销，不纳入默认验证；如需执行，将单独取得下载与磁盘占用授权。

## 检查门槛

- 配置：未设置 provider 的旧远程 `.env` 仍解析为 remote；全新默认配置解析为本地 EmbeddingGemma。
- 离线：除显式 `model install` 外，所有本地加载都启用 `local_files_only`，缺失时错误包含目标安装命令。
- 向量：三模型 mock 输出均验证数量、顺序、维度、L2 norm 和非有限值拒绝；query/document 输入与目录规则一致。
- 索引：provider、模型、revision、dtype、dimensions 或 document-input-space-version 改变时指纹必变。
- CLI/MCP：TTY 选择显示模型名与参数量；非 TTY 不等待输入；MCP stdout 无进度或提示文本。
- 兼容：现有远程 Embedding 和 Reranker 测试全部通过。

## 风险与回滚点

- Transformers.js API 或 Tensor 输出与模型卡不一致：停在本地客户端步骤，先用 mock/类型检查固定边界，不继续接入索引与 CLI。
- Jina 旧式量化文件与当前 Transformers.js dtype 选择不兼容：保留固定仓库与 revision，验证 loader 选项后再接入；不引入自定义 ONNX 适配器作为临时绕行。
- 配置兼容判断错误：以旧 `.env` 解析覆盖为门槛，失败时回滚 provider 默认切换。
- 模型切换后指纹未变化：禁止收尾，先修复指纹字段。
- `.env` 更新失败：临时文件不得替换原文件，错误直接返回 CLI。
- 任一远程 Embedding 回归：保留原 `EmbeddingClient`，回滚范围限制在配置分发和公共类型接入。
