# 技术设计：本地嵌入模型

## 1. 方案概览

使用 `@huggingface/transformers` 在 Node.js CPU 上运行三款 Transformers.js 兼容的 ONNX q8 模型。首版采用固定目录，不开放任意 Hugging Face 模型或自定义推理参数。

| 配置值 | 展示名称 | Hugging Face 仓库与固定 revision | 维度 / 上下文 | 推理规则 |
| --- | --- | --- | --- | --- |
| `jina-embeddings-v2-base-code` | `jina-embeddings-v2-base-code（161M）` | `jinaai/jina-embeddings-v2-base-code@516f4baf13dec4ddddda8631e019b5737c8bc250` | 768 / 8192 | query/document 原文；attention-mask mean pooling；L2 normalize |
| `embeddinggemma-300m` | `EmbeddingGemma-300M（300M）` | `onnx-community/embeddinggemma-300m-ONNX@5090578d9565bb06545b4552f76e6bc2c93e4a66` | 768 / 2048 | query 前缀 `task: code retrieval | query: `；document 前缀 `title: none | text: `；读取 `sentence_embedding`；L2 normalize |
| `qwen3-embedding-0.6b` | `Qwen3-Embedding-0.6B（600M）` | `onnx-community/Qwen3-Embedding-0.6B-ONNX@c25a394dd583836952667c12f008335071b3f43d` | 1024 / 32768 | query 使用固定代码检索 instruction；document 原文；last-token pooling；L2 normalize |

默认模型为 `embeddinggemma-300m`。revision、dtype、输入变换和 pooling 都属于内置目录常量，避免上游 `main` 更新或配置漂移导致新旧向量混用。

## 2. 配置契约

`src/config.ts` 将 Embedding 配置改为 `local` / `remote` 判别联合：

- `local`：由 `EMBEDDINGS_MODEL` 查找内置目录，返回固定 repo、revision、dtype、dimensions、上下文长度、缓存目录和向量空间版本；不要求 API Key 或 Base URL。
- `remote`：保留当前 API Key、Base URL、模型、并发、维度和长文本拆分配置。

新增 `EMBEDDINGS_PROVIDER=local|remote`：

- 新生成的 `.env` 显式写入 `local`，默认 `EMBEDDINGS_MODEL=embeddinggemma-300m`。
- 未声明 provider 但存在任一旧版 `EMBEDDINGS_API_KEY`、`EMBEDDINGS_BASE_URL` 或非内置 `EMBEDDINGS_MODEL` 时按 `remote` 解析，保证已有配置升级兼容。
- 没有 provider 且没有旧版远程配置时默认 `local`。
- 显式 `remote` 继续执行当前必填项校验；显式 `local` 拒绝未知模型，并忽略远程 API 配置和用户提供的本地维度覆盖。

`checkEmbeddingEnv()` 按 provider 校验：本地只检查模型值合法，远程保持现有三项检查。`src/utils/envTemplate.ts` 继续作为 CLI `init` 与 MCP 自动配置的单一模板来源，不另建模板。

Ollama、LM Studio 及其他 OpenAI 兼容 HTTP 服务仍属于 `remote`，因为它们通过 HTTP API 工作；`local` 专指 ContextWeaver 进程内模型。

## 3. 模型目录与生命周期

新增一个固定本地模型目录模块，保存上述三条模型描述和生命周期操作。每款模型使用独立目录：

```text
~/.contextweaver/models/<配置值>/
```

模型目录包含 Transformers.js 缓存及一个 ContextWeaver 安装标记。标记记录模型配置值、repo、revision 和 dtype，仅在对应模型以允许联网模式成功加载后原子写入。

- `install`：已存在匹配标记时幂等成功；否则允许 Transformers.js 下载到模型专属缓存，完成一次加载后释放模型并写标记。中断时不写标记，后续安装复用已有缓存文件。
- `list`：只读取目录、标记和当前配置，不访问网络、不加载大模型。
- `use`：要求目标模型已安装；原子更新 `~/.contextweaver/.env` 中的 `EMBEDDINGS_PROVIDER` 与 `EMBEDDINGS_MODEL`，保留无关配置和注释。重复启用同一模型幂等成功。
- `remove`：递归删除单个模型目录；目录不存在时幂等成功。允许删除 active 模型，后续使用会按缺失模型路径给出重装提示。

正常索引、搜索、MCP 和 `doctor` 都不下载模型。正常推理以 `local_files_only: true` 和模型专属缓存目录加载；缺少安装标记或离线加载失败时，错误包含准确命令：

```bash
contextweaver model install <配置值>
```

## 4. Embedding 客户端边界

保留现有 `EmbeddingClient` 作为远程客户端，避免改变 HTTP、限流、重试、长文本拆分和直接调用者行为。新增最小公共契约：

```ts
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(
    texts: string[],
    batchSize?: number,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<EmbeddingResult[]>;
}
```

`getEmbeddingClient()` 根据配置返回并缓存远程或本地实例；`Indexer` 只把成员类型收窄到该公共契约。索引、CLI 搜索和 MCP 当前都通过此工厂，因此不增加平行调用路径。

本地客户端行为：

1. 首次推理时检查安装状态，动态导入 Transformers.js，并离线延迟加载所选模型；同一进程复用初始化 Promise 和模型实例。
2. 区分 query 与 document 输入：`embed()` 使用 query 规则，`embedBatch()` 使用 document 规则；输入按模型上下文上限 tokenizer truncation。
3. 按目录执行各模型固定的前缀、输出读取和 pooling，再统一做 L2 normalize 与有限数值校验。
4. 保证结果数量、顺序、索引和维度与输入及模型目录一致；空批次直接返回空数组。
5. pipeline/tokenizer/model 加载失败时保留原始错误上下文，但不输出到 MCP stdout。

三款模型只需要 Transformers.js：Jina 与 Qwen 可使用 feature-extraction pipeline；EmbeddingGemma 按模型卡使用 `AutoTokenizer`、`AutoModel` 和 `sentence_embedding`。不直接增加或封装 `onnxruntime-node`。

## 5. CLI 与初始化

在现有 `src/cli/` 结构中增加模型命令并由 `src/index.ts` 注册：

```bash
contextweaver model install [model]
contextweaver model list
contextweaver model use [model]
contextweaver model remove [model]
```

- `model` 参数使用表格中的配置值。
- TTY 下，`install`、`use`、`remove` 缺少模型参数时使用现有 `select()` 展示三款名称及参数量。
- 非 TTY 下，`install` 缺少参数时安装当前配置模型，若无配置则安装默认 EmbeddingGemma；`use` 和 `remove` 缺少参数时报错并列出合法值。
- `list` 展示每款模型的参数量、`installed` 和 `active` 状态。
- 下载反馈复用现有 `Spinner` / `ProgressBar` 与 Transformers.js progress callback；非 TTY 输出有限的阶段信息，不逐块刷屏。

`init` 增加“ContextWeaver 内置本地模型”服务选项并作为默认项；选中后再显示三模型选择器，默认 EmbeddingGemma，不询问 Embedding URL、Key 或维度，也不执行 Embedding 连通性 probe。保存后明确提示 `contextweaver model install`。SiliconFlow、OpenAI、Ollama、LM Studio 和自定义 HTTP 服务继续写入 `remote` 配置并保持现有 probe 流程。

`init --defaults` 与 MCP 自动补建配置都写入 EmbeddingGemma 本地默认值，只生成配置和安装提示，不自动下载。

## 6. Doctor 与 MCP

`doctor` 根据 provider 分支：

- 本地：展示模型、固定维度、缓存路径、安装/启用状态；检查安装标记和目录，不进行 HTTP probe，也不加载模型或下载文件。
- 远程：保持现有环境变量、HTTP 连通性和实际维度检查。
- Reranker：无论 Embedding provider 为何都保持现有远程检查；`--offline` 继续跳过网络检查。

模型命令和安装进度只经过 CLI 展示组件或 logger。MCP stdio 路径不注册交互输入，也不写协议外 stdout；本地模型缺失错误通过现有 MCP 错误响应返回。

## 7. 索引兼容

扫描索引指纹扩展为稳定的 Embedding 空间标识：

- provider
- model
- local revision / dtype / dimensions / document-input-space-version
- remote base URL / dimensions
- 现有 splitter、文件大小和 indexVersion

`document-input-space-version` 覆盖 document 前缀、pooling 和归一化规则，避免这些内置规则将来调整后复用旧文档向量。query-only instruction 不单独要求重建，但随模型目录版本发布。

任一向量空间字段变化时，继续使用现有 `index_fingerprint`、`invalidateIndex`、LanceDB 清理和 `vector_index_hash` 自愈流程，不增加数据库 schema。

## 8. 错误、安全与许可

- 不新增 Error 类，沿用当前中文 `Error` 消息约定。
- 安装路径由固定目录表生成，不接受用户路径或任意 repo，避免路径穿越和加载未知代码。
- `.env` 更新使用同目录临时文件加 rename；不记录 API Key、完整配置或模型向量。
- README 标明模型来源与许可：Jina/Qwen 为 Apache-2.0，EmbeddingGemma 使用 Gemma license；ContextWeaver 不重新分发权重，仅在用户显式安装时从模型仓库下载。
- Reranker 保持远程，因此“本地 Embedding”不等于完整搜索流程完全离线。

## 9. 兼容与回滚

- 远程 `EmbeddingClient` 语义和旧 `.env` 行为保持不变。
- 回滚代码不会删除已下载模型；旧版本可忽略 `~/.contextweaver/models/`。
- 新增唯一直接运行时依赖 `@huggingface/transformers`，不增加下载器、通用模型注册、后台服务或 GPU 调度。
