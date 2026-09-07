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

The benchmark uses dedicated project/index snapshots and excludes `tests/`, `test/`, `__tests__/`, and `benchmarks/` from its corpus. This keeps benchmark questions/labels and test fixtures out of retrieval results without changing the normal ContextWeaver index.

## Multiple benchmark indexes

Retrieval benchmark indexes are automatically versioned by embedding index identity. Switching between Jina, Qwen, EmbeddingGemma, or a different embedding revision/dimension uses a different benchmark `projectId`; normal ContextWeaver project indexes are unchanged.

The runner prints the selected key before indexing, for example:

```text
Benchmark index: local-jina-embeddings-v2-base-code-xxxxxxxxxxxx
Benchmark index: local-qwen3-embedding-0.6b-yyyyyyyyyyyy
```

The first run for a model builds that model's benchmark index:

```bash
contextweaver model use qwen3-embedding-0.6b
pnpm benchmark:retrieval -- --output benchmarks/retrieval/results/qwen3-0.6b.json
```

After switching away and back to the same model, its frozen benchmark index can be reused without rebuilding:

```bash
contextweaver model use qwen3-embedding-0.6b
pnpm benchmark:retrieval -- --no-index --output benchmarks/retrieval/results/qwen3-rerun.json
```

`--no-index` fails fast when no benchmark index exists for the currently selected embedding identity, instead of accidentally using another model's index.

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

## Baseline metadata

Schema v3 keeps enough metadata in every result to reproduce or explain a run without relying on shell history:

- run start/end timestamps, total duration, index mode/duration, and query-phase duration
- Git commit, dirty flag, and dirty file list
- embedding provider/model plus non-secret dimensions, batching, context, local revision, or remote endpoint metadata
- reranker model, endpoint, and configured top-N
- the full `DEFAULT_CONFIG` search configuration used by the run
- platform, CPU architecture/model/count, OS release, Node version, and total memory
- SHA-256 fingerprints for corpus, cases, search config, corpus rules, model config, and benchmark index identity

API keys and other credentials are never written to benchmark output.

To establish a fresh baseline, clear prior result snapshots and write the new run explicitly as `baseline.json`:

```bash
rm -f benchmarks/retrieval/results/*.json
pnpm benchmark:retrieval -- --output benchmarks/retrieval/results/baseline.json
```

## Strict A/B comparison on a frozen corpus

Schema v3 records the reproducibility metadata above. `compare.ts` refuses incompatible corpus/cases/search/model snapshots by default instead of reporting a misleading delta.

For an algorithm-only A/B, build the isolated benchmark index once for the baseline, then reuse that same frozen index for the candidate:

```bash
pnpm benchmark:retrieval -- --output benchmarks/retrieval/results/baseline-v3.json
# change retrieval code, but do not refresh the benchmark corpus
pnpm benchmark:retrieval -- --no-index --output benchmarks/retrieval/results/candidate-v3.json
pnpm benchmark:retrieval:compare -- \
  --baseline benchmarks/retrieval/results/baseline-v3.json \
  --candidate benchmarks/retrieval/results/candidate-v3.json
```

Legacy schema-v1/v2 results do not contain enough metadata for the current strict comparison and must be regenerated. If a specific experiment intentionally changes exactly one controlled dimension, the comparator exposes explicit `--allow-model-change`, `--allow-corpus-change`, or `--allow-search-config-change` flags.

The comparison reports overall quality/size/latency deltas and per-category Top-1/coverage deltas.
