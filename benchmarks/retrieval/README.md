# Retrieval Benchmark

A small, file-level benchmark for tracking ContextWeaver retrieval quality over time.

## Run

```bash
pnpm benchmark:retrieval
```

By default the runner refreshes the repository index first and writes:

```text
benchmarks/retrieval/results/baseline.json
```

Useful options:

```bash
pnpm benchmark:retrieval -- --no-index
pnpm benchmark:retrieval -- --output benchmarks/retrieval/results/exact-symbol.json
pnpm benchmark:retrieval -- --repo /path/to/repository
```

`benchmarks/` is excluded from the indexed corpus so benchmark questions and labels cannot leak into retrieval results.

## v1 cases

The v1 baseline contains 40 curated cases:

- 8 symbol
- 7 feature
- 5 path
- 5 reference
- 5 call-chain
- 5 overview
- 5 compound

Each case declares one or more `relevantFiles`. Technical terms are appended to the natural-language request in the same way the MCP retrieval tool builds its query.

## Metrics

Metrics are computed from the final packed file ranking:

- **Top1 File Accuracy**: the first returned file is relevant.
- **Recall@5 / Recall@10**: at least one relevant file appears in the first K returned files.
- **MRR**: reciprocal rank of the first relevant file.
- **Relevant File Coverage**: fraction of all labeled relevant files present in the final context pack.
- **Avg Unique Files**: average number of returned files.
- **Avg Returned Chars**: average final context size in JavaScript string units.
- **Latency**: average and p50 retrieve, rerank, and total query time.

The JSON result also keeps `seeds`, `expanded`, and final packed file summaries for failure diagnosis without storing source-code contents.
