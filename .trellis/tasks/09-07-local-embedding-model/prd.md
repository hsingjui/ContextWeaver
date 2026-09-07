# 支持本地嵌入模型

## Goal

让 ContextWeaver 在无需远程 Embedding API 的情况下完成代码索引与向量检索，并允许用户通过 CLI 安装、选择和删除三款内置本地代码嵌入模型。新用户默认选择 EmbeddingGemma-300M q8。

## Background

- 当前 Embedding 实现只支持 OpenAI 兼容的远程 HTTP API，索引与查询统一通过 `src/api/embedding.ts` 的客户端执行。
- 当前配置要求 `EMBEDDINGS_API_KEY`、`EMBEDDINGS_BASE_URL` 和 `EMBEDDINGS_MODEL`；本地模式必须取消对前两项的依赖。
- 索引指纹已包含模型、服务地址和向量维度。模型配置改变时，现有机制会清理不兼容向量并触发重建。
- CLI 使用 `cac`；当前工作区正在引入交互式 `init`、`doctor`、共享 `.env` 模板和终端进度组件，但还没有模型管理命令。
- 三款候选模型均有可直接由 Transformers.js 加载的成熟 ONNX/q8 权重，不需要自定义 ONNX Runtime 适配：
  - `jinaai/jina-embeddings-v2-base-code`：161M 参数、768 维、8192 token、mean pooling、Apache-2.0，官方仓库直接提供 Transformers.js 量化权重，专门面向 30 种编程语言与代码检索。
  - `onnx-community/embeddinggemma-300m-ONNX`：300M 参数、768 维、2048 token、Gemma license，提供 q8 与明确的 code-retrieval query/document prompt，官方模型卡报告 MTEB Code q8 得分 68.70。
  - `onnx-community/Qwen3-Embedding-0.6B-ONNX`：600M 参数、1024 维、最长 32K token、last-token pooling、Apache-2.0，提供 q8 与 instruction-aware 检索。
- Transformers.js 支持三款模型的下载缓存、本地 tokenizer、CPU 推理和离线加载，可用单一依赖实现。

## Requirements

- R1：支持 `local` 和现有 `remote` 两种 Embedding provider；本地模式不要求 Embedding API Key 或 Base URL。
- R2：内置模型目录必须包含以下三款 q8/INT8 模型：
  - `jina-embeddings-v2-base-code`（161M，768 维）
  - `EmbeddingGemma-300M`（300M，768 维）
  - `Qwen3-Embedding-0.6B`（600M，1024 维）
- R3：每款本地模型使用 `~/.contextweaver/models/` 下的独立缓存目录，可以同时安装，不写入被索引项目。
- R4：CLI 只管理上述三款内置模型，支持安装、列出、选择和删除；交互式选择项在模型名旁显示参数量。`model use` 必须同时记录当前模型并将用户配置切换到本地 provider。
- R5：索引、CLI 搜索和 MCP 检索共用同一本地 Embedding 实现；模型在进程内延迟加载并复用。
- R6：本地推理按内置目录执行每款模型固定的 tokenizer、输入前缀、pooling、归一化和维度规则，返回数量、顺序、有限数值及维度与输入和所选模型一致。
- R7：切换 provider、模型、精度或维度后，不复用旧向量索引；下一次索引自动重建不兼容向量。
- R8：保留现有远程 Embedding 配置与行为，已有用户可以继续使用远程 provider。
- R9：`contextweaver init` 只写入默认本地配置并提示显式安装命令，不自动下载模型；索引、搜索和 MCP 也不静默下载。模型已安装后，本地 Embedding 推理不得依赖网络；模型缺失时错误信息必须包含安装命令。
- R10：README、交互式/默认 `contextweaver init`、`doctor` 和 MCP 自动配置流程必须识别本地 provider，并说明本地默认值、远程回退配置及模型管理命令。

## Acceptance Criteria

- [ ] AC1：全新执行 `contextweaver init` 后会得到以 EmbeddingGemma-300M 为默认模型的本地配置和明确的 `contextweaver model install` 提示；执行该显式安装命令后，无需 Embedding API Key 即可建立向量索引。
- [ ] AC2：模型选择界面显示 `jina-embeddings-v2-base-code（161M）`、`EmbeddingGemma-300M（300M）`、`Qwen3-Embedding-0.6B（600M）`，并能选择其中任一模型。
- [ ] AC3：`contextweaver model install|list|use|remove` 可以按模型安装、查看安装/启用状态、切换当前模型并删除单个模型缓存；重复安装、启用和删除具备幂等行为。
- [ ] AC4：模型安装完成后，`contextweaver index` 的 Embedding 全程离线；`search` 和 MCP 的 Embedding 阶段同样不发起网络请求，但完整检索仍按现状依赖远程 Reranker。
- [ ] AC5：本地模式缺少模型文件时快速失败，错误信息包含对应安装命令；不会在 MCP stdio 中输出协议外内容。
- [ ] AC6：远程 provider 仍接受现有 `EMBEDDINGS_*` 配置，并保持现有批处理、限流、长文本拆分与响应校验行为。
- [ ] AC7：三款模型分别生成正确维度的 L2 归一化向量，并正确处理各自的 query/document prompt 与 pooling；空批次、批量顺序、非有限值及模型加载失败均有明确且一致的处理。
- [ ] AC8：provider/模型/revision/精度/维度任一变化都会改变索引指纹并触发向量重建。
- [ ] AC9：交互式 `init` 默认提供 ContextWeaver 内置本地模型；Ollama、LM Studio 和其他 OpenAI 兼容 HTTP 服务仍按远程 API provider 配置；`doctor` 能正确展示和检查两类 provider。

## Out of Scope

- 不提供 `init` 自动下载；该首次使用体验留待后续优化。
- 不支持三款内置模型之外的任意 Hugging Face 模型 ID，也不允许用户自定义 pooling、归一化策略或 query/document prompt。
- 本任务不把 Reranker 改为本地运行；现有远程 Reranker 行为保持不变。
- 不实现 GPU/CUDA/WebGPU 自动调度，首版以 Node.js CPU 推理为目标。
- 不自行训练、转换或量化模型。
- 不提供模型镜像服务或后台守护进程。
