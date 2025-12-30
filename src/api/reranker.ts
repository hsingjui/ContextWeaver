/**
 * Reranker 客户端
 *
 * 调用 SiliconFlow Rerank API，对文档进行重排序以提升搜索精度
 */

import { getRerankerConfig, type RerankerConfig } from '../config.js';
import { logger } from '../utils/logger.js';

/** Rerank 请求体 */
interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
  max_chunks_per_doc?: number;
  overlap?: number;
}

/** 单个 Rerank 结果 */
interface RerankResult {
  index: number;
  relevance_score: number;
  document?: {
    text: string;
  };
}

/** Rerank 响应体 */
interface RerankResponse {
  id: string;
  results: RerankResult[];
  meta?: {
    api_version?: {
      version: string;
    };
    billed_units?: {
      search_units?: number;
    };
    tokens?: {
      input_tokens?: number;
    };
  };
}

/** Rerank 错误响应 */
interface RerankErrorResponse {
  error?: {
    message: string;
    type?: string;
    code?: string;
  };
}

/** 重排序结果 */
export interface RerankedDocument<T = unknown> {
  /** 原始索引 */
  originalIndex: number;
  /** 相关性得分 (0-1) */
  score: number;
  /** 原始文档文本 */
  text: string;
  /** 附带的原始数据（可选） */
  data?: T;
}

/** Reranker 选项 */
export interface RerankOptions {
  /** 返回的最大结果数 */
  topN?: number;
  /** 每个文档的最大分块数（用于长文档） */
  maxChunksPerDoc?: number;
  /** 分块之间的 token 重叠数 */
  chunkOverlap?: number;
  /** 重试次数 */
  retries?: number;
}

/**
 * Reranker 客户端类
 */
export class RerankerClient {
  private config: RerankerConfig;

  constructor(config?: RerankerConfig) {
    this.config = config || getRerankerConfig();
  }

  /**
   * 对文档进行重排序
   * @param query 查询文本
   * @param documents 待排序的文档文本数组
   * @param options 选项
   */
  async rerank(
    query: string,
    documents: string[],
    options: RerankOptions = {},
  ): Promise<RerankedDocument[]> {
    if (documents.length === 0) {
      return [];
    }

    const { topN = this.config.topN, maxChunksPerDoc, chunkOverlap, retries = 3 } = options;

    const requestBody: RerankRequest = {
      model: this.config.model,
      query,
      documents,
      top_n: Math.min(topN, documents.length),
      return_documents: false, // 不需要返回原文，节省带宽
    };

    // 可选参数
    if (maxChunksPerDoc !== undefined) {
      requestBody.max_chunks_per_doc = maxChunksPerDoc;
    }
    if (chunkOverlap !== undefined) {
      requestBody.overlap = chunkOverlap;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(this.config.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(requestBody),
        });

        const data = (await response.json()) as RerankResponse & RerankErrorResponse;

        // 检查 API 错误
        if (!response.ok || data.error) {
          const errorMsg = data.error?.message || `HTTP ${response.status}`;
          throw new Error(`Rerank API 错误: ${errorMsg}`);
        }

        // 转换结果
        const results: RerankedDocument[] = data.results.map((item) => ({
          originalIndex: item.index,
          score: item.relevance_score,
          text: documents[item.index],
        }));

        logger.debug(
          {
            query: query.slice(0, 50),
            inputCount: documents.length,
            outputCount: results.length,
          },
          'Rerank 完成',
        );

        return results;
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        const isRateLimited = error.message?.includes('429') || error.message?.includes('rate');

        if (attempt < retries) {
          const delay = isRateLimited ? 1000 * attempt : 500 * attempt;
          logger.warn(
            { attempt, maxRetries: retries, delay, error: error.message },
            'Rerank 请求失败，准备重试',
          );
          await sleep(delay);
        } else {
          logger.error(
            { error: error.message, stack: error.stack, query: query.slice(0, 50) },
            'Rerank 请求最终失败',
          );
          throw err;
        }
      }
    }

    throw new Error('Rerank 处理异常');
  }

  /**
   * 对带有元数据的文档进行重排序
   * @param query 查询文本
   * @param items 文档项数组
   * @param textExtractor 从文档项中提取文本的函数
   * @param options 选项
   */
  async rerankWithData<T>(
    query: string,
    items: T[],
    textExtractor: (item: T) => string,
    options: RerankOptions = {},
  ): Promise<RerankedDocument<T>[]> {
    if (items.length === 0) {
      return [];
    }

    const texts = items.map(textExtractor);
    const results = await this.rerank(query, texts, options);

    // 附加原始数据
    return results.map((result) => ({
      ...result,
      data: items[result.originalIndex],
    }));
  }

  /**
   * 获取当前配置
   */
  getConfig(): RerankerConfig {
    return { ...this.config };
  }
}

/**
 * 创建默认的 Reranker 客户端实例（惰性初始化）
 */
let defaultClient: RerankerClient | null = null;

/**
 * 获取 Reranker 客户端
 * @throws 如果 Reranker 未配置
 */
export function getRerankerClient(): RerankerClient {
  if (!defaultClient) {
    defaultClient = new RerankerClient();
  }
  return defaultClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
