#!/usr/bin/env node
// 配置必须最先加载（包含环境变量初始化）
import "./config.js";

import cac from "cac";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { logger } from "./utils/logger.js";
import { scan, type ScanStats } from "./scanner/index.js";
import { generateProjectId } from "./db/index.js";

const cli = cac("contextweaver");

cli.command("init", "初始化 ContextWeaver 配置")
    .action(async () => {
        const configDir = path.join(os.homedir(), ".contextweaver");
        const envFile = path.join(configDir, ".env");

        logger.info("开始初始化 ContextWeaver...");

        // 创建配置目录
        try {
            await fs.mkdir(configDir, { recursive: true });
            logger.info(`创建配置目录: ${configDir}`);
        } catch (err: any) {
            if (err.code !== "EEXIST") {
                logger.error({ err, stack: err.stack }, `创建配置目录失败: ${err.message}`);
                process.exit(1);
            }
            logger.info(`配置目录已存在: ${configDir}`);
        }

        // 检查是否已存在 .env 文件
        try {
            await fs.access(envFile);
            logger.warn(`.env 文件已存在: ${envFile}`);
            logger.info("初始化完成！");
            return;
        } catch {
            // 文件不存在，继续创建
        }

        // 写入默认 .env 配置
        const defaultEnvContent = `# ContextWeaver 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules
`;
        try {
            await fs.writeFile(envFile, defaultEnvContent);
            logger.info(`创建 .env 文件: ${envFile}`);
        } catch (err: any) {
            logger.error({ err, stack: err.stack }, `创建 .env 文件失败: ${err.message}`);
            process.exit(1);
        }

        logger.info("下一步操作:");
        logger.info(`   1. 编辑配置文件: ${envFile}`);
        logger.info("   2. 填写你的 API Key 和其他配置");
        logger.info("初始化完成！");
    });

cli.command("index [path]", "扫描代码库并建立索引")
    .option("-f, --force", "强制重新索引")
    .action(async (targetPath: string | undefined, options: { force?: boolean }) => {
        const rootPath = targetPath ? path.resolve(targetPath) : process.cwd();
        const projectId = generateProjectId(rootPath);

        logger.info(`开始扫描: ${rootPath}`);
        logger.info(`项目 ID: ${projectId}`);
        if (options.force) {
            logger.info("强制重新索引: 是");
        }

        const startTime = Date.now();

        try {
            const stats: ScanStats = await scan(rootPath, {
                force: options.force,
                onProgress: (current, total) => {
                    const percent = ((current / total) * 100).toFixed(1);
                    process.stdout.write(`\r进度: ${current}/${total} (${percent}%)`);
                }
            });

            process.stdout.write("\n");

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            logger.info("扫描完成！");
            logger.info(`耗时: ${duration}s`);
            logger.info(`文件总数: ${stats.totalFiles}`);
            logger.info(`新增: ${stats.added}`);
            logger.info(`修改: ${stats.modified}`);
            logger.info(`未变: ${stats.unchanged}`);
            logger.info(`删除: ${stats.deleted}`);
            logger.info(`跳过: ${stats.skipped}`);
            logger.info(`错误: ${stats.errors}`);
        } catch (err: any) {
            logger.error({ err, stack: err.stack }, `扫描失败: ${err.message}`);
            process.exit(1);
        }
    });

cli.command("mcp", "启动 MCP 服务器")
    .action(async () => {
        // 动态导入并启动 MCP 服务器
        const { startMcpServer } = await import("./mcp/server.js");
        try {
            await startMcpServer();
        } catch (error: any) {
            logger.error({ error: error.message, stack: error.stack }, `MCP 服务器启动失败: ${error.message}`);
            process.exit(1);
        }
    });

cli.command("search", "本地检索（参数对齐 MCP）")
    .option("--repo-path <path>", "代码库根目录（默认当前目录）")
    .option("--information-request <text>", "自然语言问题描述（必填）")
    .option("--technical-terms <terms>", "精确术语（逗号分隔）")
    .option("--zen", "使用 MCP Zen 配置（默认开启）")
    .action(async (options: {
        repoPath?: string;
        informationRequest?: string;
        technicalTerms?: string;
        zen?: boolean;
    }) => {
        const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
        const informationRequest = options.informationRequest;
        if (!informationRequest) {
            logger.error("缺少 --information-request");
            process.exit(1);
        }

        const technicalTerms = (options.technicalTerms || "")
            .split(",")
            .map(t => t.trim())
            .filter(Boolean);

        const useZen = options.zen !== false;

        const { handleCodebaseRetrieval } = await import("./mcp/tools/codebaseRetrieval.js");

        const response = await handleCodebaseRetrieval({
            repo_path: repoPath,
            information_request: informationRequest,
            technical_terms: technicalTerms.length > 0 ? technicalTerms : undefined,
        }, useZen ? undefined : {});

        const text = response.content.map(item => item.text).join("\n");
        process.stdout.write(text + "\n");
    });

cli.help();
cli.parse();
