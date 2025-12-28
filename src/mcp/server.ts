/**
 * ContextWeaver MCP Server
 * 
 * 提供代码库检索能力的 Model Context Protocol 服务器
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger.js";
import { handleCodebaseRetrieval, codebaseRetrievalSchema } from "./tools/index.js";

// ===========================================
// 服务器配置
// ===========================================

const SERVER_NAME = "contextweaver";
const SERVER_VERSION = "0.1.0";

// ===========================================
// 工具定义
// ===========================================

const TOOLS = [
    {
        name: "codebase-retrieval",
        description: `
IMPORTANT: This is the PRIMARY tool for searching the codebase. 
It uses a hybrid engine (Semantic + Exact Match) to find relevant code.
Think of it as the "Google Search" for this repository.

Capabilities:
1. Semantic Search: Understands "what code does" (e.g., "auth logic") via high-dimensional embeddings.
2. Exact Match: Filters by precise symbols (e.g., class names) via FTS (Full Text Search).
3. Zen Context: Returns code with localized context (breadcrumbs) to avoid token overflow.

<RULES>
# 1. Tool Selection (When to use)
- ALWAYS use this tool FIRST for any code exploration or understanding task.
- DO NOT try to guess file paths. If you don't have the exact path, use this tool.
- DO NOT use 'grep' or 'find' for semantic understanding. Only use them for exhaustive text matching (e.g. "Find ALL occurrences of string 'foo'").

# 2. Before Editing (Critical)
- Before creating a plan or editing any file, YOU MUST call this tool to gather context.
- Ask for ALL symbols involved in the edit (classes, functions, types, constants).
- Do not assume you remember the code structure. Verify it with this tool.

# 3. Query Strategy (How to use)
- Split your intent:
  - Put the "Goal/Context" in 'information_request'.
  - Put "Known Class/Func Names" in 'technical_terms'.
- If the first search is too broad, add more specific 'technical_terms'.
</RULES>

Examples of GOOD queries:
* [Goal: Understand Auth] 
  information_request: "How is user authentication flow handled?"
* [Goal: Fix DB Pool bug] 
  information_request: "Logic for database connection pooling and error handling" 
  technical_terms: ["PoolConfig", "Connection", "release"]

Examples of BAD queries:
* "Show me src/main.ts" (Use 'read_file' instead)
* "Find definition of constructor of class Foo" (Use this tool, but put "Foo" in technical_terms)
* "Find all references to function bar across the whole project" (Use 'grep' tool for exhaustive reference counting)
`,
        inputSchema: {
            type: "object",
            properties: {
                repo_path: {
                    type: "string",
                    description: "The absolute file system path to the repository root.",
                },
                information_request: {
                    type: "string",
                    description: "The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')",
                },
                technical_terms: {
                    type: "array",
                    items: { type: "string" },
                    description: "HARD FILTERS. An optional list of EXACT, KNOWN identifiers (class/function names, constants) that MUST appear in the code. Only use terms you are 100% sure exist. Leave empty if exploring.",
                },
            },
            required: ["repo_path", "information_request"],
        },
    },
];

// ===========================================
// 服务器初始化
// ===========================================

/**
 * 启动 MCP 服务器
 */
export async function startMcpServer(): Promise<void> {
    logger.info({ name: SERVER_NAME, version: SERVER_VERSION }, "启动 MCP 服务器");

    const server = new Server(
        {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // 注册工具列表处理器
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        logger.debug("收到 list_tools 请求");
        return { tools: TOOLS };
    });

    // 注册工具调用处理器
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        logger.info({ tool: name }, "收到 call_tool 请求");

        try {
            switch (name) {
                case "codebase-retrieval": {
                    const parsed = codebaseRetrievalSchema.parse(args);
                    return await handleCodebaseRetrieval(parsed);
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error: any) {
            logger.error({ error: error.message, stack: error.stack, tool: name }, "工具调用失败");
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${error.message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    // 启动 stdio 传输
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info("MCP 服务器已启动，等待连接...");
}

