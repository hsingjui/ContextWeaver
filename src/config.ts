/**
 * 统一配置模块
 *
 * 整合环境变量加载、API 配置、排除模式等所有配置项
 *
 * 加载策略：
 * - 开发环境 (NODE_ENV !== "production"): 加载项目根目录的 .env 文件
 * - 生产环境 (NODE_ENV === "production"): 加载 ~/.contextweaver/.env 文件
 *
 * 此模块必须在应用启动时最先导入，以确保环境变量在其他模块加载前可用。
 */
import dotenv from "dotenv";
import path from "path";
import os from "os";
import fs from "fs";

// 环境变量加载

const isDev = process.env.NODE_ENV !== "dev";

function loadEnv(): void {
    // 可能的 .env 文件路径（按优先级排序）
    const candidates = isDev
        ? [
            path.join(process.cwd(), ".env"),           // 1. 当前目录（开发用）
            path.join(os.homedir(), ".contextweaver", ".env"),  // 2. 用户配置目录（回退）
        ]
        : [
            path.join(os.homedir(), ".contextweaver", ".env"),  // 生产环境只用用户配置
        ];

    // 找到第一个存在的文件
    const envPath = candidates.find(p => fs.existsSync(p));

    if (envPath) {
        const result = dotenv.config({ path: envPath, quiet: true });
        if (result.error) {
            // 环境变量加载失败是致命错误，此时 logger 尚未初始化，只能用 console
            console.error(`[config] 加载环境变量失败: ${result.error.message}`);
            process.exit(1);
        }
    }
    // 所有路径都不存在时静默跳过，允许无 .env 文件运行
}

// 立即执行加载
loadEnv();

// API 配置类型定义

export interface EmbeddingConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    maxConcurrency: number;
    /** 向量维度 */
    dimensions: number;
}

export interface RerankerConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    topN: number;
}

// API 配置获取

/**
 * 环境变量检查结果
 */
export interface EnvCheckResult {
    isValid: boolean;
    missingVars: string[];
}

/**
 * 检查 Embedding 相关环境变量是否已配置（不抛出错误）
 * @returns 检查结果，包含是否有效和缺失的变量列表
 */
export function checkEmbeddingEnv(): EnvCheckResult {
    const missingVars: string[] = [];

    if (!process.env.EMBEDDINGS_API_KEY) {
        missingVars.push("EMBEDDINGS_API_KEY");
    }
    if (!process.env.EMBEDDINGS_BASE_URL) {
        missingVars.push("EMBEDDINGS_BASE_URL");
    }
    if (!process.env.EMBEDDINGS_MODEL) {
        missingVars.push("EMBEDDINGS_MODEL");
    }

    return {
        isValid: missingVars.length === 0,
        missingVars,
    };
}

/**
 * 检查 Reranker 相关环境变量是否已配置（不抛出错误）
 * @returns 检查结果，包含是否有效和缺失的变量列表
 */
export function checkRerankerEnv(): EnvCheckResult {
    const missingVars: string[] = [];

    if (!process.env.RERANK_API_KEY) {
        missingVars.push("RERANK_API_KEY");
    }
    if (!process.env.RERANK_BASE_URL) {
        missingVars.push("RERANK_BASE_URL");
    }
    if (!process.env.RERANK_MODEL) {
        missingVars.push("RERANK_MODEL");
    }

    return {
        isValid: missingVars.length === 0,
        missingVars,
    };
}

/**
 * 获取 Embedding 配置
 * @throws 如果必需的配置项缺失
 */
export function getEmbeddingConfig(): EmbeddingConfig {
    const apiKey = process.env.EMBEDDINGS_API_KEY;
    const baseUrl = process.env.EMBEDDINGS_BASE_URL;
    const model = process.env.EMBEDDINGS_MODEL;
    const maxConcurrency = parseInt(process.env.EMBEDDINGS_MAX_CONCURRENCY || "10", 10);

    if (!apiKey) {
        throw new Error("EMBEDDINGS_API_KEY 环境变量未设置");
    }
    if (!baseUrl) {
        throw new Error("EMBEDDINGS_BASE_URL 环境变量未设置");
    }
    if (!model) {
        throw new Error("EMBEDDINGS_MODEL 环境变量未设置");
    }

    const dimensions = parseInt(process.env.EMBEDDINGS_DIMENSIONS || "1024", 10);

    return {
        apiKey,
        baseUrl,
        model,
        maxConcurrency: isNaN(maxConcurrency) ? 4 : maxConcurrency,
        dimensions: isNaN(dimensions) ? 1024 : dimensions,
    };
}

/**
 * 获取 Reranker 配置
 * @throws 如果必需的配置项缺失
 */
export function getRerankerConfig(): RerankerConfig {
    const apiKey = process.env.RERANK_API_KEY;
    const baseUrl = process.env.RERANK_BASE_URL;
    const model = process.env.RERANK_MODEL;
    const topN = parseInt(process.env.RERANK_TOP_N || "10", 10);

    if (!apiKey) {
        throw new Error("RERANK_API_KEY 环境变量未设置");
    }
    if (!baseUrl) {
        throw new Error("RERANK_BASE_URL 环境变量未设置");
    }
    if (!model) {
        throw new Error("RERANK_MODEL 环境变量未设置");
    }

    return {
        apiKey,
        baseUrl,
        model,
        topN: isNaN(topN) ? 10 : topN,
    };
}

// 排除模式配置

/**
 * 默认排除黑名单模式
 */
export const DEFAULT_EXCLUDE_PATTERNS = [
    // 虚拟环境
    ".venv", "venv", ".env", "env",
    "node_modules",

    // 版本控制
    ".git", ".svn", ".hg",

    // Python 缓存
    "__pycache__", ".pytest_cache", ".mypy_cache",
    ".tox", ".eggs", "*.egg-info",

    // 构建产物
    "dist", "build", "target", "out",

    // IDE 配置
    ".idea", ".vscode", ".vs",

    // 系统文件
    ".DS_Store", "Thumbs.db",

    // 编译文件
    "*.pyc", "*.pyo", "*.pyd", "*.so", "*.dll"
];

/**
 * 获取合并后的排除模式列表
 * @returns 排除模式数组
 */
export function getExcludePatterns(): string[] {
    const envPatterns = process.env.IGNORE_PATTERNS;
    const patterns = [...DEFAULT_EXCLUDE_PATTERNS];

    if (envPatterns) {
        // 解析逗号分隔的环境变量
        const additional = envPatterns.split(",").map(p => p.trim()).filter(Boolean);
        patterns.push(...additional);
    }

    return patterns;
}

export { isDev };
