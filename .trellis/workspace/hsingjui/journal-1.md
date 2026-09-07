# Journal - hsingjui (Part 1)

> AI development session journal
> Started: 2026-09-07

---


## 2026-09-07 — 00-bootstrap-guidelines

- 完成 Trellis bootstrap spec 填充。
- backend：基于实际代码（pino、better-sqlite3、biome、node:test）填写 5 个规范文件 + index，含真实示例。
- frontend：项目无前端代码（纯后端 CLI + MCP），6 个文件标记 N/A，index.md 说明占位用途与后端通用规则。
- 修正：quality-guidelines 中 env 读取模式按 reality 调整（IGNORE_PATTERNS / MAX_FILE_SIZE_BYTES 在消费模块读取）。

- 本地嵌入 benchmark（embeddinggemma-300m vs 远程 bge-m3 baseline，40 cases，reranker 未改）：
  - top1 82%→80%，r@5 100%→97.5%，r@10 持平 100%，MRR 0.900→0.887，coverage 73%→80%。
  - 退化集中在 reference（top1 80%→20%）和 compound 排序；无 recall@10 完全丢失。
  - 结果存 benchmarks/retrieval/results/local-embeddinggemma.json。
- qwen3-embedding-0.6b benchmark（40 cases，no-index 复用已建索引）：
  - top1 82.5%、r@5 97.5%、r@10 100%、MRR 0.898、coverage 79.5% —— 全面追平 bge-m3 baseline（82%/0.900），优于 gemma。
  - reference 类仍是短板（top1 20%，两个本地模型一致），召回无损。
  - 结果存 benchmarks/retrieval/results/local-qwen3-0.6b.json。
- jina-embeddings-v2-base-code benchmark（40 cases，no-index）：
  - top1 82.5%、r@5 100%（唯一恢复满召回）、r@10 100%、MRR 0.901、coverage 80.2% —— 四模型中最佳，全面≥bge-m3 baseline。
  - reference 短板依旧（top1 20%），compound r@5 从 80% 回到 100%。
  - 结果存 benchmarks/retrieval/results/local-jina-v2-base-code.json。
