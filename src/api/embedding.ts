/**
 * Embedding 客户端
 *
 * 调用 SiliconFlow Embedding API，将文本转换为向量
 * 支持并发控制、批量处理和智能速率限制
 *
 * 速率限制策略：
 * - 遇到 429 时，暂停所有批次请求
 * - 使用指数退避等待（初始 5s，每次加倍，最大 60s）
 * - 恢复后从并发=1 开始，逐步恢复到 maxConcurrency
 * - 连续成功 N 次后才提升并发数
 */

import {
  type EmbeddingConfig,
  getEmbeddingConfig,
  type RemoteEmbeddingConfig,
  type RemoteEmbeddingConfigInput,
} from '../config.js';
import { resolveEndpointUrl } from '../utils/endpointUrl.js';
import { logger } from '../utils/logger.js';
import { LocalEmbeddingClient } from './localEmbedding.js';

/** Embedding 请求体 */
interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
}

/** 单个 Embedding 结果 */
interface EmbeddingData {
  object: 'embedding';
  index: number;
  embedding: number[];
}

/** Embedding 响应体 */
interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

/** Embedding 结果 */
export interface EmbeddingResult {
  text: string;
  embedding: number[];
  index: number;
}

/** 索引、搜索和 MCP 共用的最小 Embedding 提供方契约。 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(
    texts: string[],
    batchSize?: number,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<EmbeddingResult[]>;
  getConfig(): EmbeddingConfig;
}

interface ExpandedEmbeddingInputs {
  texts: string[];
  originalIndexes: number[];
}

interface EmbeddingBatch {
  texts: string[];
  startIndex: number;
}

/** 检查值是否为普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从 SiliconFlow API 响应中提取错误消息 */
function extractErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const msg = payload.message;
  if (typeof msg === 'string' && msg.trim()) {
    return msg.trim();
  }
  const nestedError = payload.error;
  if (isRecord(nestedError)) {
    const nestedMessage = nestedError.message;
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
  }
  return null;
}

/** 轻量结构校验：只验证顶层形态；向量取值的严格校验由结果循环统一负责 */
function isEmbeddingResponse(payload: unknown): payload is EmbeddingResponse {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return false;
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.index !== 'number' || !Array.isArray(item.embedding)) {
      return false;
    }
  }
  return true;
}

/**
 * 进度追踪器
 * 定时输出进度，避免每个批次都打印日志
 */
class ProgressTracker {
  private completed = 0;
  private total: number;
  private totalTokens = 0;
  private startTime: number;
  private lastLogTime = 0;
  private readonly logIntervalMs = 2000; // 每 2 秒输出一次
  private onProgress?: (completed: number, total: number) => void;
  /** 是否跳过日志（单批次时跳过，避免与索引日志混淆） */
  private readonly skipLogs: boolean;

  constructor(total: number, onProgress?: (completed: number, total: number) => void) {
    this.total = total;
    this.startTime = Date.now();
    this.onProgress = onProgress;
    // 单批次（如查询 embedding）时跳过进度日志
    this.skipLogs = total <= 1;
  }

  /** 记录一个批次完成 */
  recordBatch(tokens: number): void {
    this.completed++;
    this.totalTokens += tokens;

    // 调用外部回调
    this.onProgress?.(this.completed, this.total);

    const now = Date.now();
    if (now - this.lastLogTime >= this.logIntervalMs) {
      this.logProgress();
      this.lastLogTime = now;
    }
  }

  /**
   * 扩展总批次数（用于长度错误二分重试时修正进度）
   */
  expandTotal(extra: number): void {
    if (extra > 0) {
      this.total += extra;
    }
  }

  /** 输出进度 */
  private logProgress(): void {
    if (this.skipLogs) return;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const percent = Math.round((this.completed / this.total) * 100);
    const rate = this.completed / elapsed;
    const eta = rate > 0 ? Math.round((this.total - this.completed) / rate) : 0;

    logger.info(
      {
        progress: `${this.completed}/${this.total}`,
        percent: `${percent}%`,
        tokens: this.totalTokens,
        elapsed: `${elapsed.toFixed(1)}s`,
        eta: `${eta}s`,
      },
      'Embedding 进度',
    );
  }

  /** 完成时输出最终统计 */
  complete(): void {
    if (this.skipLogs) return;

    const elapsed = (Date.now() - this.startTime) / 1000;
    logger.info(
      {
        batches: this.total,
        tokens: this.totalTokens,
        elapsed: `${elapsed.toFixed(1)}s`,
        avgTokensPerBatch: Math.round(this.totalTokens / this.total),
      },
      'Embedding 完成',
    );
  }
}

/**
 * 全局速率限制控制器
 *
 * 实现自适应并发控制，遇到 429 时协调所有请求暂停和恢复
 */
class RateLimitController {
  /** 是否处于暂停状态 */
  private isPaused = false;
  /** 暂停恢复的 Promise（所有请求等待此 Promise） */
  private pausePromise: Promise<void> | null = null;
  /** 当前有效并发数 */
  private currentConcurrency: number;
  /** 配置的最大并发数 */
  private maxConcurrency: number;
  /** 当前活跃请求数 */
  private activeRequests = 0;
  /** 连续成功次数（用于渐进恢复并发） */
  private consecutiveSuccesses = 0;
  /** 当前退避时间（毫秒） */
  private backoffMs = 5000;
  /** 恢复并发所需的连续成功次数 */
  private readonly successesPerConcurrencyIncrease = 3;
  /** 最小退避时间 */
  private readonly minBackoffMs = 5000;
  /** 最大退避时间 */
  private readonly maxBackoffMs = 60000;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
    this.currentConcurrency = maxConcurrency;
  }

  /**
   * 获取执行槽位
   * 如果当前暂停或并发已满，则等待
   */
  async acquire(): Promise<void> {
    // 如果暂停中，等待恢复
    if (this.pausePromise) {
      await this.pausePromise;
    }

    // 等待并发槽位
    while (this.activeRequests >= this.currentConcurrency) {
      await sleep(50);
      // 再次检查是否暂停（可能在等待期间触发了 429）
      if (this.pausePromise) {
        await this.pausePromise;
      }
    }

    this.activeRequests++;
  }

  /**
   * 释放执行槽位（请求成功时调用）
   */
  releaseSuccess(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.consecutiveSuccesses++;

    // 渐进恢复并发数
    if (
      this.currentConcurrency < this.maxConcurrency &&
      this.consecutiveSuccesses >= this.successesPerConcurrencyIncrease
    ) {
      this.currentConcurrency++;
      this.consecutiveSuccesses = 0;
    }

    // 连续成功 10 次后，逐步减少退避时间
    if (this.consecutiveSuccesses > 0 && this.consecutiveSuccesses % 10 === 0) {
      this.backoffMs = Math.max(this.minBackoffMs, this.backoffMs / 2);
    }
  }

  /**
   * 释放执行槽位（请求失败但非 429 时调用）
   */
  releaseFailure(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    // 普通失败不重置成功计数
  }

  /**
   * 释放执行槽位（429 重试前调用）
   * 释放槽位并重置成功计数
   */
  releaseForRetry(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.consecutiveSuccesses = 0;
  }

  /**
   * 触发 429 暂停
   * 所有请求将等待恢复
   */
  async triggerRateLimit(): Promise<void> {
    // 如果已经在暂停中，等待现有的暂停结束
    if (this.isPaused && this.pausePromise) {
      logger.debug('速率限制：等待现有暂停结束');
      await this.pausePromise;
      return;
    }

    this.isPaused = true;
    this.consecutiveSuccesses = 0;

    // 降低并发数
    const previousConcurrency = this.currentConcurrency;
    this.currentConcurrency = 1;

    logger.warn(
      {
        backoffMs: this.backoffMs,
        previousConcurrency,
        newConcurrency: this.currentConcurrency,
        activeRequests: this.activeRequests,
      },
      '速率限制：触发 429，暂停所有请求',
    );

    // 创建暂停 Promise
    let resumeResolve: () => void = () => {};
    this.pausePromise = new Promise<void>((resolve) => {
      resumeResolve = resolve;
    });

    // 等待退避时间
    await sleep(this.backoffMs);

    // 增加下次的退避时间（指数退避）
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);

    // 恢复
    this.isPaused = false;
    this.pausePromise = null;
    resumeResolve();

    logger.info({ waitMs: this.backoffMs }, '速率限制：恢复请求');
  }

  /**
   * 获取当前状态（用于调试）
   */
  getStatus(): {
    isPaused: boolean;
    currentConcurrency: number;
    maxConcurrency: number;
    activeRequests: number;
    backoffMs: number;
  } {
    return {
      isPaused: this.isPaused,
      currentConcurrency: this.currentConcurrency,
      maxConcurrency: this.maxConcurrency,
      activeRequests: this.activeRequests,
      backoffMs: this.backoffMs,
    };
  }
}

/** 全局速率限制控制器实例 */
let globalRateLimitController: RateLimitController | null = null;

/**
 * 获取或创建全局速率限制控制器
 */
function getRateLimitController(maxConcurrency: number): RateLimitController {
  if (!globalRateLimitController) {
    globalRateLimitController = new RateLimitController(maxConcurrency);
  }
  return globalRateLimitController;
}

/**
 * Embedding 客户端类
 */
export class EmbeddingClient implements EmbeddingProvider {
  private config: RemoteEmbeddingConfig;
  private rateLimiter: RateLimitController;

  constructor(config?: RemoteEmbeddingConfigInput) {
    const resolved = config ?? getEmbeddingConfig();
    if (resolved.provider === 'local') {
      throw new Error('EmbeddingClient 仅支持 remote provider');
    }
    this.config = { ...resolved, provider: 'remote' };
    if (
      !Number.isSafeInteger(this.config.dimensions) ||
      this.config.dimensions <= 0 ||
      !Number.isSafeInteger(this.config.maxConcurrency) ||
      this.config.maxConcurrency <= 0
    ) {
      throw new Error('Embedding dimensions and maxConcurrency must be positive integers');
    }
    this.rateLimiter = getRateLimitController(this.config.maxConcurrency);
  }

  /**
   * 获取单个文本的 Embedding
   */
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0].embedding;
  }

  /**
   * 批量获取 Embedding
   * @param texts 待处理的文本数组
   * @param batchSize 每批次发送的文本数量（默认 20）
   * @param onProgress 可选的进度回调 (completed, total) => void
   */
  async embedBatch(
    texts: string[],
    batchSize = 20,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error('Embedding batchSize must be a positive integer');
    }

    if (!this.config.autoSplitLongText) {
      const batches = this.createBatches(texts, batchSize);
      const progress = new ProgressTracker(batches.length, onProgress);
      const batchResults = await this.runBatches(batches, progress);
      progress.complete();
      return batchResults.flat().sort((left, right) => left.index - right.index);
    }

    // 超长文本先拆分，再按字符预算动态分批，避免请求体过大触发 500
    const expanded = this.expandInputs(texts);
    const batches = this.createBatches(expanded.texts, batchSize);

    // 创建进度追踪器（传入外部回调）
    const progress = new ProgressTracker(batches.length, onProgress);

    // 使用速率限制控制器处理各批次
    const batchResults = await this.runBatches(batches, progress);

    // 输出完成统计
    progress.complete();

    // expandedIndex -> embedding 映射
    const flattened = batchResults.flat();
    const embeddingByExpandedIndex: Array<number[] | undefined> = new Array(expanded.texts.length);
    for (const result of flattened) {
      embeddingByExpandedIndex[result.index] = result.embedding;
    }

    // 原始文本索引 -> expanded 索引列表
    const expandedIndexesByOriginal: number[][] = Array.from({ length: texts.length }, () => []);
    for (let expandedIndex = 0; expandedIndex < expanded.originalIndexes.length; expandedIndex++) {
      const originalIndex = expanded.originalIndexes[expandedIndex];
      expandedIndexesByOriginal[originalIndex].push(expandedIndex);
    }

    // 聚合回原始文本：单段直接返回，多段取均值向量
    const merged: EmbeddingResult[] = [];
    for (let originalIndex = 0; originalIndex < texts.length; originalIndex++) {
      const expandedIndexes = expandedIndexesByOriginal[originalIndex];
      if (expandedIndexes.length === 0) {
        throw new Error(`Embedding 结果缺失: text#${originalIndex}`);
      }

      const vectors: number[][] = [];
      for (const expandedIndex of expandedIndexes) {
        const embedding = embeddingByExpandedIndex[expandedIndex];
        if (!embedding) {
          throw new Error(`Embedding 结果缺失: expanded#${expandedIndex}`);
        }
        vectors.push(embedding);
      }

      merged.push({
        text: texts[originalIndex],
        embedding: vectors.length === 1 ? vectors[0] : this.averageEmbeddings(vectors),
        index: originalIndex,
      });
    }

    return merged;
  }

  /**
   * 将原始输入展开为可安全发送到 Embedding API 的输入序列
   */
  private expandInputs(texts: string[]): ExpandedEmbeddingInputs {
    const expandedTexts: string[] = [];
    const originalIndexes: number[] = [];

    let oversizedCount = 0;
    let extraSegments = 0;

    for (let originalIndex = 0; originalIndex < texts.length; originalIndex++) {
      const segments = this.splitLongText(texts[originalIndex], this.config.maxInputChars);
      if (segments.length > 1) {
        oversizedCount++;
        extraSegments += segments.length - 1;
      }

      for (const segment of segments) {
        expandedTexts.push(segment);
        originalIndexes.push(originalIndex);
      }
    }

    if (oversizedCount > 0) {
      logger.warn(
        {
          oversizedTexts: oversizedCount,
          extraSegments,
          maxInputChars: this.config.maxInputChars,
        },
        '检测到超长输入，已自动拆分并聚合向量',
      );
    }

    return { texts: expandedTexts, originalIndexes };
  }

  /**
   * 按「最大条数 + 最大字符预算」动态分批
   */
  private createBatches(texts: string[], maxBatchSize: number): EmbeddingBatch[] {
    const batches: EmbeddingBatch[] = [];
    const safeBatchSize = Math.max(1, maxBatchSize);
    const maxBatchChars = Math.max(this.config.maxBatchChars, this.config.maxInputChars);

    let current: string[] = [];
    let currentChars = 0;
    let startIndex = 0;

    for (const text of texts) {
      const nextChars = text.length;
      const exceedsSize = current.length >= safeBatchSize;
      const exceedsChars = current.length > 0 && currentChars + nextChars > maxBatchChars;

      if (exceedsSize || exceedsChars) {
        batches.push({ texts: current, startIndex });
        startIndex += current.length;
        current = [];
        currentChars = 0;
      }

      current.push(text);
      currentChars += nextChars;
    }

    if (current.length > 0) {
      batches.push({ texts: current, startIndex });
    }

    return batches;
  }

  /**
   * 拆分超长文本，优先按行断开，保留 Context 前缀
   */
  private splitLongText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) {
      return [text];
    }

    let prefix = '';
    let body = text;
    if (text.startsWith('// Context:')) {
      const newlineIndex = text.indexOf('\n');
      if (newlineIndex !== -1) {
        prefix = text.slice(0, newlineIndex + 1);
        body = text.slice(newlineIndex + 1);
      }
    }

    let bodyBudget = maxChars - prefix.length;
    if (bodyBudget < 200) {
      prefix = '';
      body = text;
      bodyBudget = maxChars;
    }

    const segments: string[] = [];
    let cursor = 0;

    while (cursor < body.length) {
      let end = Math.min(body.length, cursor + bodyBudget);
      if (end < body.length) {
        const lineBreak = body.lastIndexOf('\n', end);
        if (lineBreak > cursor + Math.floor(bodyBudget * 0.6)) {
          end = lineBreak;
        }
      }

      if (end <= cursor) {
        end = Math.min(body.length, cursor + bodyBudget);
      }

      const segmentBody = body.slice(cursor, end);
      segments.push(prefix ? `${prefix}${segmentBody}` : segmentBody);
      cursor = end;
    }

    return segments.length > 0 ? segments : [text.slice(0, maxChars)];
  }

  /**
   * 多段向量均值聚合
   */
  private averageEmbeddings(vectors: number[][]): number[] {
    const dim = vectors[0]?.length ?? 0;
    if (dim === 0) {
      throw new Error('Embedding 维度无效');
    }

    const merged = new Array<number>(dim).fill(0);
    for (const vector of vectors) {
      if (vector.length !== dim) {
        throw new Error(`Embedding 维度不一致: expected=${dim}, actual=${vector.length}`);
      }
      for (let i = 0; i < dim; i++) {
        merged[i] += vector[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      merged[i] /= vectors.length;
    }
    return merged;
  }

  /**
   * 只启动有限 worker；失败后停止取新任务，并等待在途请求结束。
   */
  private async runBatches(
    batches: EmbeddingBatch[],
    progress: ProgressTracker,
  ): Promise<EmbeddingResult[][]> {
    const batchResults: EmbeddingResult[][] = new Array(batches.length);
    let nextBatch = 0;
    let failed = false;
    let failure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(this.config.maxConcurrency, batches.length) }, async () => {
        while (!failed && nextBatch < batches.length) {
          const index = nextBatch++;
          try {
            batchResults[index] = await this.processWithRateLimit(
              batches[index].texts,
              batches[index].startIndex,
              progress,
            );
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
      }),
    );
    if (failed) throw failure;
    return batchResults;
  }

  /**
   * 带速率限制和错误重试的批次处理
   * 普通重试使用循环；长度错误时走二分递归拆分
   */
  private async processWithRateLimit(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
  ): Promise<EmbeddingResult[]> {
    const MAX_NETWORK_RETRIES = 3;
    const MAX_RATE_LIMIT_RETRIES = 3;
    const INITIAL_RETRY_DELAY_MS = 1000;

    let networkRetries = 0;
    let rateLimitRetries = 0;

    while (true) {
      // 获取执行槽位（可能等待）
      await this.rateLimiter.acquire();

      try {
        const result = await this.processBatch(texts, startIndex, progress);
        this.rateLimiter.releaseSuccess();
        return result;
      } catch (err) {
        const error = err as { message?: string; code?: string };
        const errorMessage = error.message || '';
        const isRateLimited = errorMessage.includes('429') || errorMessage.includes('rate');
        const isNetworkError = this.isNetworkError(err);
        const isInputTooLong = this.isInputTooLongError(err);

        if (isRateLimited && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          // 429 错误：有界重试，避免配额耗尽时永久挂起
          rateLimitRetries++;
          this.rateLimiter.releaseForRetry();
          await this.rateLimiter.triggerRateLimit();
          // 循环继续，重新获取槽位并重试
        } else if (isInputTooLong) {
          this.rateLimiter.releaseFailure();
          return this.retryWithBinarySplit(texts, startIndex, progress, errorMessage);
        } else if (isNetworkError && networkRetries < MAX_NETWORK_RETRIES) {
          // 网络错误：指数退避重试
          networkRetries++;
          const delayMs = INITIAL_RETRY_DELAY_MS * 2 ** (networkRetries - 1);

          logger.warn(
            {
              error: errorMessage,
              retry: networkRetries,
              maxRetries: MAX_NETWORK_RETRIES,
              delayMs,
            },
            '网络错误，准备重试',
          );

          this.rateLimiter.releaseForRetry();
          await sleep(delayMs);
          // 循环继续，重新获取槽位并重试
        } else {
          // 其他错误或重试次数耗尽：抛出异常
          this.rateLimiter.releaseFailure();

          if (isNetworkError) {
            logger.error({ error: errorMessage, retries: networkRetries }, '网络错误重试次数耗尽');
          }

          throw err;
        }
      }
    }
  }

  /**
   * 长度错误自动二分重试
   *
   * - 多条输入：按条目二分
   * - 单条输入：按字符二分并最终聚合向量
   */
  private async retryWithBinarySplit(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
    errorMessage: string,
  ): Promise<EmbeddingResult[]> {
    if (texts.length > 1) {
      const mid = Math.floor(texts.length / 2);
      if (mid <= 0 || mid >= texts.length) {
        throw new Error(`Embedding 批次二分失败: size=${texts.length}`);
      }

      progress.expandTotal(1); // 1 个失败批次替换为 2 个子批次
      logger.warn(
        {
          size: texts.length,
          left: mid,
          right: texts.length - mid,
          startIndex,
          error: errorMessage,
        },
        'Embedding 批次过长，自动二分重试',
      );

      const [left, right] = await Promise.all([
        this.processWithRateLimit(texts.slice(0, mid), startIndex, progress),
        this.processWithRateLimit(texts.slice(mid), startIndex + mid, progress),
      ]);
      return [...left, ...right];
    }

    const text = texts[0] || '';
    if (text.length <= 1) {
      throw new Error(`Embedding 文本过短且仍触发长度错误: index=${startIndex}`);
    }

    let targetChars = Math.max(100, Math.floor(text.length / 2));
    if (targetChars >= text.length) {
      targetChars = Math.max(1, text.length - 1);
    }
    const segments = this.splitLongText(text, targetChars);
    if (segments.length <= 1) {
      throw new Error(`Embedding 文本二分失败: index=${startIndex}, length=${text.length}`);
    }

    progress.expandTotal(segments.length - 1); // 1 个失败批次替换为 N 个子批次
    logger.warn(
      {
        index: startIndex,
        originalLength: text.length,
        segmentCount: segments.length,
        targetChars,
        error: errorMessage,
      },
      'Embedding 单条文本过长，自动拆分并聚合重试',
    );

    const vectors: number[][] = [];
    for (const segment of segments) {
      const result = await this.processWithRateLimit([segment], startIndex, progress);
      const embedding = result[0]?.embedding;
      if (!embedding) {
        throw new Error(`Embedding 子分片结果缺失: index=${startIndex}`);
      }
      vectors.push(embedding);
    }

    return [
      {
        text,
        embedding: this.averageEmbeddings(vectors),
        index: startIndex,
      },
    ];
  }

  /** 判断是否为输入长度超限错误 (SiliconFlow: HTTP 413 + "input must have less than") */
  private isInputTooLongError(err: unknown): boolean {
    const msg = (err as { message?: string }).message?.toLowerCase() || '';
    return msg.includes('input must have less than') || msg.includes('413');
  }

  /**
   * 判断是否为网络错误
   *
   * 常见网络错误类型：
   * - terminated: 连接被中断（TLS 断开）
   * - ECONNRESET: 连接被远端重置
   * - ETIMEDOUT: 连接超时
   * - ENOTFOUND: DNS 解析失败
   * - fetch failed: 通用 fetch 失败
   * - socket hang up: 套接字意外关闭
   */
  private isNetworkError(err: unknown): boolean {
    const error = err as { message?: string; code?: string };
    const message = (error.message || '').toLowerCase();
    const code = error.code || '';

    const networkErrorPatterns = [
      'terminated',
      'econnreset',
      'etimedout',
      'enotfound',
      'econnrefused',
      'fetch failed',
      'socket hang up',
      'network',
      'aborted',
      'timeout',
    ];

    // 检查错误消息
    for (const pattern of networkErrorPatterns) {
      if (message.includes(pattern)) {
        return true;
      }
    }

    // 检查错误代码
    const networkErrorCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'];
    if (networkErrorCodes.includes(code)) {
      return true;
    }

    return false;
  }

  /**
   * 处理单个批次（单次请求，不含重试逻辑）
   */
  private async processBatch(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
  ): Promise<EmbeddingResult[]> {
    const requestBody: EmbeddingRequest = {
      model: this.config.model,
      input: texts,
      encoding_format: 'float',
    };

    const startTime = Date.now();

    const response = await fetch(resolveEndpointUrl(this.config.baseUrl, '/embeddings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60_000),
    });

    const latencyMs = Date.now() - startTime;
    const traceId = response.headers.get('x-siliconcloud-trace-id') || undefined;

    const rawBody = await response.text();
    let parsedBody: unknown = null;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody) as unknown;
      } catch {
        if (response.ok) {
          logger.error(
            { status: response.status, latencyMs, traceId, response: rawBody },
            'Embedding API 响应解析失败',
          );
          throw new Error(`Embedding API 错误: 响应非 JSON - ${rawBody}`);
        }
      }
    }

    if (!response.ok) {
      const detail = extractErrorMessage(parsedBody) || rawBody || `HTTP ${response.status}`;
      logger.error(
        { status: response.status, latencyMs, traceId, response: detail },
        'Embedding API 错误',
      );
      throw new Error(`Embedding API 错误: HTTP ${response.status} - ${detail}`);
    }

    if (!parsedBody) {
      logger.error(
        { status: response.status, latencyMs, traceId, response: rawBody },
        'Embedding API 响应解析失败',
      );
      throw new Error(`Embedding API 错误: 响应非 JSON - ${rawBody}`);
    }

    const errMsg = extractErrorMessage(parsedBody);
    if (errMsg) {
      logger.error(
        { status: response.status, latencyMs, traceId, response: errMsg },
        'Embedding API 返回错误',
      );
      throw new Error(`Embedding API 错误: ${errMsg}`);
    }

    if (!isEmbeddingResponse(parsedBody)) {
      logger.error(
        { status: response.status, latencyMs, traceId, response: rawBody },
        'Embedding API 响应结构异常',
      );
      throw new Error(`Embedding API 错误: 响应结构异常 - ${rawBody}`);
    }

    const results: EmbeddingResult[] = new Array(texts.length);
    if (parsedBody.data.length !== texts.length) {
      throw new Error('Invalid Embedding response: result count mismatch');
    }
    for (const item of parsedBody.data) {
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length) {
        throw new Error(
          `Invalid Embedding response: index out of range (index=${item.index}, expected=0..${texts.length - 1})`,
        );
      }
      if (results[item.index] !== undefined) {
        throw new Error(`Invalid Embedding response: duplicate index (index=${item.index})`);
      }
      if (item.embedding.length !== this.config.dimensions) {
        throw new Error(
          `Invalid Embedding response: vector dimension mismatch (index=${item.index}, expected=${this.config.dimensions}, actual=${item.embedding.length})`,
        );
      }
      for (const value of item.embedding) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(
            `Invalid Embedding response: vector contains non-finite value (index=${item.index})`,
          );
        }
      }
      const text = texts[item.index];
      if (typeof text !== 'string') {
        throw new Error(`Invalid Embedding response: missing input text (index=${item.index})`);
      }
      results[item.index] = {
        text,
        embedding: item.embedding,
        index: startIndex + item.index,
      };
    }

    // 记录批次完成（进度追踪器会定时输出）
    progress.recordBatch(parsedBody.usage?.total_tokens || 0);

    return results;
  }

  /**
   * 获取当前配置
   */
  getConfig(): EmbeddingConfig {
    return { ...this.config };
  }

  /**
   * 获取速率限制器状态（用于调试）
   */
  getRateLimiterStatus(): ReturnType<RateLimitController['getStatus']> {
    return this.rateLimiter.getStatus();
  }
}

/**
 * 创建默认的 Embedding 客户端实例
 */
type CachedEmbeddingClient = EmbeddingClient | LocalEmbeddingClient;

let defaultClient: CachedEmbeddingClient | null = null;

export function getEmbeddingClient(): EmbeddingProvider {
  const config = getEmbeddingConfig();
  if (!defaultClient || JSON.stringify(defaultClient.getConfig()) !== JSON.stringify(config)) {
    defaultClient =
      config.provider === 'local' ? new LocalEmbeddingClient(config) : new EmbeddingClient(config);
  }
  return defaultClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
