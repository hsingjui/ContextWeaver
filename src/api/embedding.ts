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

import { type EmbeddingConfig, getEmbeddingConfig } from '../config.js';
import { logger } from '../utils/logger.js';

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
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/** Embedding 错误响应 */
interface EmbeddingErrorResponse {
  error?: {
    message: string;
    type?: string;
    code?: string;
  };
}

/** Embedding 结果 */
export interface EmbeddingResult {
  text: string;
  embedding: number[];
  index: number;
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
  private readonly logIntervalMs = 2000; // 每 3 秒输出一次

  constructor(total: number) {
    this.total = total;
    this.startTime = Date.now();
  }

  /** 记录一个批次完成 */
  recordBatch(tokens: number): void {
    this.completed++;
    this.totalTokens += tokens;

    const now = Date.now();
    if (now - this.lastLogTime >= this.logIntervalMs) {
      this.logProgress();
      this.lastLogTime = now;
    }
  }

  /** 输出进度 */
  private logProgress(): void {
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
export class EmbeddingClient {
  private config: EmbeddingConfig;
  private rateLimiter: RateLimitController;

  constructor(config?: EmbeddingConfig) {
    this.config = config || getEmbeddingConfig();
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
   */
  async embedBatch(texts: string[], batchSize = 20): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    // 将文本分批
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      batches.push(texts.slice(i, i + batchSize));
    }

    // 创建进度追踪器
    const progress = new ProgressTracker(batches.length);

    // 使用速率限制控制器处理各批次
    const batchResults = await Promise.all(
      batches.map((batch, batchIndex) =>
        this.processWithRateLimit(batch, batchIndex * batchSize, progress),
      ),
    );

    // 输出完成统计
    progress.complete();

    // 扁平化结果
    return batchResults.flat();
  }

  /**
   * 带速率限制和网络错误重试的批次处理
   * 使用循环而非递归，避免栈溢出和槽位泄漏
   */
  private async processWithRateLimit(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
  ): Promise<EmbeddingResult[]> {
    const MAX_NETWORK_RETRIES = 3;
    const INITIAL_RETRY_DELAY_MS = 1000;

    let networkRetries = 0;

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

        if (isRateLimited) {
          // 429 错误：释放槽位，触发全局暂停
          this.rateLimiter.releaseForRetry();
          await this.rateLimiter.triggerRateLimit();
          networkRetries = 0; // 重置网络重试计数
          // 循环继续，重新获取槽位并重试
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

    const response = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = (await response.json()) as EmbeddingResponse & EmbeddingErrorResponse;

    if (!response.ok || data.error) {
      const errorMsg = data.error?.message || `HTTP ${response.status}`;
      throw new Error(`Embedding API 错误: ${errorMsg}`);
    }

    const results: EmbeddingResult[] = data.data.map((item) => ({
      text: texts[item.index],
      embedding: item.embedding,
      index: startIndex + item.index,
    }));

    // 记录批次完成（进度追踪器会定时输出）
    progress.recordBatch(data.usage?.total_tokens || 0);

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
let defaultClient: EmbeddingClient | null = null;

export function getEmbeddingClient(): EmbeddingClient {
  if (!defaultClient) {
    defaultClient = new EmbeddingClient();
  }
  return defaultClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
