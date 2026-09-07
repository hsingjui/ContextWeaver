/**
 * Transformers.js 本地 Embedding 客户端。
 *
 * 只接受 models 目录中的固定模型定义。正常推理始终离线加载；网络访问只由显式
 * model install 命令通过 localFilesOnly=false 触发。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  PretrainedModelOptions,
  PretrainedTokenizerOptions,
  ProgressInfo,
} from '@huggingface/transformers';
import type { LocalEmbeddingConfig } from '../config.js';
import {
  getLocalModelDefinition,
  getLocalModelDir,
  isLocalModelInstalled,
  type LocalModelDefinition,
  type ModelProgress,
} from '../models/index.js';
import type { EmbeddingProvider, EmbeddingResult } from './embedding.js';

type InputKind = 'query' | 'document';
type FeaturePooling = 'mean' | 'last_token';

const DEFAULT_MODEL_HOST = 'https://huggingface.co/';

type TensorLike = {
  dims: number[];
  data: ArrayLike<number>;
  dispose?: () => void;
};

type FeatureExtractor = {
  (
    texts: string | string[],
    options?: { pooling?: FeaturePooling; normalize?: boolean },
  ): Promise<unknown>;
  tokenizer: { config: Record<string, unknown> };
  dispose?: () => Promise<void>;
};

type Tokenizer = (
  texts: string | string[],
  options: { padding: boolean; truncation: boolean; max_length: number },
) => unknown;

type Model = {
  (inputs: unknown): Promise<unknown>;
  dispose?: () => Promise<unknown>;
};

export interface LocalModelLoadOptions {
  localFilesOnly: boolean;
  onProgress?: (progress: ModelProgress) => void;
}

export interface LoadedLocalModel {
  embed(texts: string[], kind: InputKind): Promise<number[][]>;
  dispose(): Promise<void>;
}

/** 由模型管理命令和 LocalEmbeddingClient 共用的加载入口。 */
export async function loadLocalModel(
  definition: LocalModelDefinition,
  options: LocalModelLoadOptions,
): Promise<LoadedLocalModel> {
  const transformers = await import('@huggingface/transformers');
  const cacheDir = getLocalModelDir(definition.id);
  const remoteHost = getModelHost();
  transformers.env.allowRemoteModels = !options.localFilesOnly;
  transformers.env.cacheDir = cacheDir;
  transformers.env.remoteHost = remoteHost;
  // Transformers.js 4.2 的 tokenizer 文件探测会丢失 revision/cache_dir。
  // 固定探测 URL 到 catalog revision；实际文件仍使用显式 revision 缓存。
  transformers.env.remotePathTemplate = `{model}/resolve/${encodeURIComponent(definition.revision)}/`;

  const progressCallback = (info: ProgressInfo): void => {
    options.onProgress?.({
      status: info.status,
      ...('file' in info ? { file: info.file } : {}),
      ...('progress' in info ? { progress: info.progress } : {}),
    });
  };
  const tokenizerOptions: PretrainedTokenizerOptions = {
    cache_dir: cacheDir,
    local_files_only: options.localFilesOnly,
    revision: definition.revision,
    progress_callback: progressCallback,
  };
  const modelOptions: PretrainedModelOptions = {
    ...tokenizerOptions,
    dtype: definition.dtype,
    device: 'cpu',
  };

  let tokenizer: Awaited<ReturnType<typeof transformers.AutoTokenizer.from_pretrained>>;
  try {
    if (options.localFilesOnly) await materializeTokenizerFiles(definition, cacheDir, false);
    tokenizer = await transformers.AutoTokenizer.from_pretrained(
      options.localFilesOnly ? cacheDir : definition.repo,
      tokenizerOptions,
    );
    if (!options.localFilesOnly) await materializeTokenizerFiles(definition, cacheDir, true);
  } catch (error) {
    throw describeLoadError(error, 'tokenizer', remoteHost, options.localFilesOnly);
  }

  let model: Awaited<ReturnType<typeof transformers.AutoModel.from_pretrained>>;
  try {
    model = await transformers.AutoModel.from_pretrained(definition.repo, modelOptions);
  } catch (error) {
    throw describeLoadError(error, '模型权重', remoteHost, options.localFilesOnly);
  }

  if (definition.runtime === 'sentence-embedding') {
    return new SentenceEmbeddingModel(
      definition,
      tokenizer as unknown as Tokenizer,
      model as unknown as Model,
    );
  }

  // pipeline() 会先用默认 Hub 选项探测文件；直接构造 pipeline 才能保证固定 revision 和离线缓存。
  const extractor = new transformers.FeatureExtractionPipeline({
    task: 'feature-extraction',
    tokenizer,
    model,
  }) as unknown as FeatureExtractor;
  // FeatureExtractionPipeline 不透传 max_length，直接限制其 tokenizer 的固定上下文窗口。
  extractor.tokenizer.config.model_max_length = definition.maxContextTokens;
  return new FeatureExtractionModel(definition, extractor);
}

async function materializeTokenizerFiles(
  definition: LocalModelDefinition,
  cacheDir: string,
  overwrite: boolean,
): Promise<void> {
  await Promise.all(
    ['tokenizer.json', 'tokenizer_config.json'].map(async (file) => {
      const target = path.join(cacheDir, file);
      if (!overwrite) {
        try {
          await fs.access(target);
          return;
        } catch {
          // 兼容旧版 pinned-revision 缓存布局。
        }
      }
      await fs.copyFile(path.join(cacheDir, definition.repo, definition.revision, file), target);
    }),
  );
}

function getModelHost(): string {
  const configured = process.env.HF_ENDPOINT?.trim() || DEFAULT_MODEL_HOST;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`HF_ENDPOINT 不是有效 URL: ${configured}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`HF_ENDPOINT 仅支持 http/https: ${configured}`);
  }
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

function describeLoadError(
  error: unknown,
  artifact: string,
  remoteHost: string,
  localFilesOnly: boolean,
): Error {
  if (localFilesOnly) return error instanceof Error ? error : new Error(String(error));
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `从模型源 ${remoteHost} 加载${artifact}失败：${message}。请检查网络，或通过 HF_ENDPOINT 设置镜像重试（例如: export HF_ENDPOINT=https://hf-mirror.com，或写入 ~/.contextweaver/.env）`,
  );
}

export class LocalEmbeddingClient implements EmbeddingProvider {
  private readonly config: LocalEmbeddingConfig;
  private loaded: Promise<LoadedLocalModel> | null = null;

  constructor(config: LocalEmbeddingConfig) {
    this.config = config;
    if (!Number.isSafeInteger(config.dimensions) || config.dimensions <= 0) {
      throw new Error('本地 Embedding 维度必须是正整数');
    }
  }

  async embed(text: string): Promise<number[]> {
    const model = await this.getLoadedModel();
    const vectors = await model.embed([text], 'query');
    const vector = vectors[0];
    if (!vector) throw new Error('本地 Embedding 未返回查询向量');
    return vector;
  }

  async embedBatch(
    texts: string[],
    batchSize = 20,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error('Embedding batchSize must be a positive integer');
    }

    const model = await this.getLoadedModel();
    const total = Math.ceil(texts.length / batchSize);
    // 按长度排序分批：减少批次内 padding 到最长序列的浪费（混合长度实测 ~1.4x）。
    const ordered = texts
      .map((text, index) => ({ text, index }))
      .sort((a, b) => a.text.length - b.text.length);
    const results: EmbeddingResult[] = new Array(texts.length);
    for (let start = 0, batchIndex = 0; start < texts.length; start += batchSize, batchIndex++) {
      const batch = ordered.slice(start, start + batchSize);
      const vectors = await model.embed(
        batch.map((item) => item.text),
        'document',
      );
      if (vectors.length !== batch.length) {
        throw new Error(
          `本地 Embedding 结果数量不一致: expected=${batch.length}, actual=${vectors.length}`,
        );
      }
      for (let index = 0; index < batch.length; index++) {
        const vector = vectors[index];
        if (!vector) throw new Error(`本地 Embedding 结果缺失: index=${batch[index].index}`);
        results[batch[index].index] = {
          text: batch[index].text,
          embedding: vector,
          index: batch[index].index,
        };
      }
      onProgress?.(batchIndex + 1, total);
    }
    return results;
  }

  getConfig(): LocalEmbeddingConfig {
    return { ...this.config };
  }

  async dispose(): Promise<void> {
    const loaded = this.loaded;
    this.loaded = null;
    if (loaded) await (await loaded).dispose();
  }

  private async getLoadedModel(): Promise<LoadedLocalModel> {
    const modelId = this.config.model;
    if (!(await isLocalModelInstalled(modelId))) {
      throw new Error(
        `本地模型 ${modelId} 未安装，请先运行: contextweaver model install ${modelId}`,
      );
    }

    if (!this.loaded) {
      const definition = getLocalModelDefinition(modelId);
      const loading = loadLocalModel(definition, { localFilesOnly: true });
      this.loaded = loading;
      try {
        return await loading;
      } catch (error) {
        if (this.loaded === loading) this.loaded = null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `本地模型加载失败（${modelId}）：${message}；请重新安装: contextweaver model install ${modelId}`,
        );
      }
    }
    return this.loaded;
  }
}

class FeatureExtractionModel implements LoadedLocalModel {
  constructor(
    private readonly definition: LocalModelDefinition,
    private readonly extractor: FeatureExtractor,
  ) {}

  async embed(texts: string[], kind: InputKind): Promise<number[][]> {
    const pooling = this.definition.pooling;
    if (pooling !== 'mean' && pooling !== 'last_token') {
      throw new Error(`本地模型 ${this.definition.id} 的 pooling 配置无效: ${pooling}`);
    }
    const output = await this.extractor(
      texts.map((text) => prepareInput(this.definition, text, kind)),
      {
        pooling,
        normalize: true,
      },
    );
    return validateAndNormalize(output, texts.length, this.definition);
  }

  async dispose(): Promise<void> {
    await this.extractor.dispose?.();
  }
}

class SentenceEmbeddingModel implements LoadedLocalModel {
  constructor(
    private readonly definition: LocalModelDefinition,
    private readonly tokenizer: Tokenizer,
    private readonly model: Model,
  ) {}

  async embed(texts: string[], kind: InputKind): Promise<number[][]> {
    const inputs = this.tokenizer(
      texts.map((text) => prepareInput(this.definition, text, kind)),
      {
        padding: true,
        truncation: true,
        max_length: this.definition.maxContextTokens,
      },
    );
    const output = await this.model(inputs);
    const tensor = getSentenceEmbedding(output);
    try {
      return validateAndNormalize(tensor, texts.length, this.definition);
    } finally {
      tensor.dispose?.();
    }
  }

  async dispose(): Promise<void> {
    await this.model.dispose?.();
  }
}

function prepareInput(definition: LocalModelDefinition, text: string, kind: InputKind): string {
  return `${kind === 'query' ? definition.queryPrefix : definition.documentPrefix}${text}`;
}

function getSentenceEmbedding(output: unknown): TensorLike {
  if (isTensorLike(output)) return output;
  if (isRecord(output) && isTensorLike(output.sentence_embedding)) {
    return output.sentence_embedding;
  }
  throw new Error('EmbeddingGemma 未返回 sentence_embedding 向量');
}

function validateAndNormalize(
  output: unknown,
  expectedCount: number,
  definition: LocalModelDefinition,
): number[][] {
  const rows = readTensorRows(output, expectedCount, definition.dimensions);
  return rows.map((row, rowIndex) => {
    let squaredNorm = 0;
    for (const value of row) {
      if (!Number.isFinite(value)) {
        throw new Error(
          `本地 Embedding 向量包含非有限值: model=${definition.id}, index=${rowIndex}`,
        );
      }
      squaredNorm += value * value;
    }
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm <= 0) {
      throw new Error(`本地 Embedding 向量范数无效: model=${definition.id}, index=${rowIndex}`);
    }
    const normalized = row.map((value) => value / norm);
    if (normalized.some((value) => !Number.isFinite(value))) {
      throw new Error(`本地 Embedding 归一化结果无效: model=${definition.id}, index=${rowIndex}`);
    }
    return normalized;
  });
}

function readTensorRows(output: unknown, expectedCount: number, dimension: number): number[][] {
  if (!isTensorLike(output)) {
    throw new Error('本地 Embedding 输出不是有效 Tensor');
  }
  const { dims, data } = output;
  const isBatched = dims.length === 2 && dims[0] === expectedCount && dims[1] === dimension;
  const isSingle = expectedCount === 1 && dims.length === 1 && dims[0] === dimension;
  if (!isBatched && !isSingle) {
    throw new Error(
      `本地 Embedding 输出维度不一致: expected=[${expectedCount},${dimension}], actual=[${dims.join(',')}]`,
    );
  }
  if (data.length !== expectedCount * dimension) {
    throw new Error(
      `本地 Embedding 输出数量不一致: expected=${expectedCount * dimension}, actual=${data.length}`,
    );
  }

  const rows: number[][] = [];
  for (let rowIndex = 0; rowIndex < expectedCount; rowIndex++) {
    const start = rowIndex * dimension;
    rows.push(Array.from({ length: dimension }, (_, index) => data[start + index]));
  }
  return rows;
}

function isTensorLike(value: unknown): value is TensorLike {
  if (!isRecord(value) || !Array.isArray(value.dims) || !value.dims.every(Number.isInteger)) {
    return false;
  }
  const data = value.data;
  if (!Array.isArray(data) && !ArrayBuffer.isView(data)) return false;
  return typeof (data as { length?: unknown }).length === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
