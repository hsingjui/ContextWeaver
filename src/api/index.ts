/**
 * API 模块统一导出
 */

// 配置
export {
    getEmbeddingConfig,
    getRerankerConfig,
    type EmbeddingConfig,
    type RerankerConfig,
} from "../config.js";

// Embedding 客户端
export {
    EmbeddingClient,
    getEmbeddingClient,
    resetEmbeddingClient,
    type EmbeddingResult,
} from "./embedding.js";

// Reranker 客户端
export {
    RerankerClient,
    getRerankerClient,
    resetRerankerClient,
    type RerankedDocument,
    type RerankOptions,
} from "./reranker.js";
