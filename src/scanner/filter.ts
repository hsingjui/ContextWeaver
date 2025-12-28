import ignore from "ignore";
import fs from "fs/promises";
import path from "path";
import { getExcludePatterns } from "../config.js";
import { isAllowedExtension } from "./language.js";

let ignoreInstance: ignore.Ignore | null = null;
let lastConfigHash: string | null = null;

/**
 * 配置文件路径
 */
const CONFIG_FILES = [
  ".gitignore",
  ".contextweaverignore"
];

/**
 * 生成配置文件内容的 hash
 */
async function generateConfigHash(rootPath: string): Promise<string> {
  const crypto = await import("crypto");
  const hashes: string[] = [];

  for (const file of CONFIG_FILES) {
    const filePath = path.join(rootPath, file);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      hashes.push(crypto.createHash("sha256").update(content).digest("hex"));
    } catch {
      // 文件不存在，跳过
    }
  }

  // 加上环境变量 IGNORE_PATTERNS
  const envPatterns = process.env.IGNORE_PATTERNS || "";
  const envHash = crypto.createHash("sha256").update(envPatterns).digest("hex");
  hashes.push(envHash);

  // 合并所有 hashes
  const combined = hashes.join("|");
  return crypto.createHash("sha256").update(combined).digest("hex");
}

/**
 * 初始化过滤器
 */
export async function initFilter(rootPath: string): Promise<void> {
  const currentHash = await generateConfigHash(rootPath);

  if (lastConfigHash === currentHash && ignoreInstance) {
    return; // 配置未变更，复用实例
  }

  const ig = ignore();
  const patterns = getExcludePatterns();
  ig.add(patterns);

  // 加载 .gitignore
  const gitignorePath = path.join(rootPath, ".gitignore");
  try {
    await fs.access(gitignorePath);
    ig.add(await fs.readFile(gitignorePath, "utf-8"));
  } catch {
  }

  // 加载 .contextweaverignore
  const cwignorePath = path.join(rootPath, ".contextweaverignore");
  try {
    await fs.access(cwignorePath);
    ig.add(await fs.readFile(cwignorePath, "utf-8"));
  } catch {
  }

  ignoreInstance = ig;
  lastConfigHash = currentHash;
}

/**
 * 判断文件路径是否应该被过滤掉
 */
export function isFiltered(relativePath: string): boolean {
  if (!ignoreInstance) {
    throw new Error("Filter not initialized. Call initFilter() first.");
  }
  return ignoreInstance.ignores(relativePath);
}

/**
 * 判断文件扩展名是否在白名单中
 */
export function isAllowedFile(filePath: string): boolean {
  return isAllowedExtension(filePath);
}
