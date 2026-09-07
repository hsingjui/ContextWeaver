# Retrieval Benchmark

A small, file-level benchmark for tracking ContextWeaver retrieval quality over time.

## Run

```bash
pnpm benchmark:retrieval
```

By default the runner refreshes the repository index first and writes:

```text
benchmarks/retrieval/results/latest.json
```

Useful options:

```bash
pnpm benchmark:retrieval -- --no-index
pnpm benchmark:retrieval -- --output benchmarks/retrieval/results/exact-symbol.json
pnpm benchmark:retrieval -- --repo /path/to/repository
```

The benchmark uses a dedicated project/index snapshot and excludes `tests/`, `test/`, `__tests__/`, and `benchmarks/` from its corpus. This keeps benchmark questions/labels and test fixtures out of retrieval results without changing the normal ContextWeaver index.

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

## Strict A/B comparison on a frozen corpus

Schema v2 records SHA-256 fingerprints for the corpus snapshot, cases file, search config, and corpus rules, plus model and Git metadata. `compare.ts` refuses incompatible snapshots by default instead of reporting a misleading delta.

For an algorithm-only A/B, build the isolated benchmark index once for the baseline, then reuse that same frozen index for the candidate:

```bash
pnpm benchmark:retrieval -- --output benchmarks/retrieval/results/baseline-v2.json
# change retrieval code, but do not refresh the benchmark corpus
pnpm benchmark:retrieval -- --no-index --output benchmarks/retrieval/results/candidate-v2.json
pnpm benchmark:retrieval:compare -- \
  --baseline benchmarks/retrieval/results/baseline-v2.json \
  --candidate benchmarks/retrieval/results/candidate-v2.json
```

Legacy schema-v1 results do not contain enough metadata for a strict comparison and must be regenerated. If a specific experiment intentionally changes exactly one controlled dimension, the comparator exposes explicit `--allow-model-change`, `--allow-corpus-change`, or `--allow-search-config-change` flags.

The comparison reports overall quality/size/latency deltas and per-category Top-1/coverage deltas.
