import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ignore from 'ignore';
import { getExcludePatterns } from '../config.js';
import { isAllowedExtension } from './language.js';

let ignoreInstance: ignore.Ignore | null = null;
let lastConfigHash: string | null = null;

/**
 * 从 Git INI 配置文件内容中提取 core.excludesFile 的值
 */
function parseCoreExcludesFile(content: string): string | null {
  const lines = content.split(/\r?\n/);
  let inCoreSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inCoreSection = /^\[core\b/i.test(trimmed);
      continue;
    }
    if (inCoreSection) {
      const match = trimmed.match(/^excludes[Ff]ile\s*=\s*(.+)/);
      if (match) {
        let val = match[1].trim();
        // 去除可能的引号
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        return val;
      }
    }
  }
  return null;
}

/**
 * 展开路径中的 ~ 为用户主目录
 */
function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * 解析全局 Git 忽略文件路径
 *
 * 优先级：
 * 1. <repo>/.git/config 中的 core.excludesFile
 * 2. ~/.gitconfig 中的 core.excludesFile
 * 3. $XDG_CONFIG_HOME/git/config 中的 core.excludesFile（默认 ~/.config/git/config）
 * 4. 回退到 $XDG_CONFIG_HOME/git/ignore（默认 ~/.config/git/ignore）
 */
async function resolveGlobalGitIgnorePath(rootPath: string): Promise<string | null> {
  const configCandidates = [
    path.join(rootPath, '.git', 'config'),
    path.join(os.homedir(), '.gitconfig'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'config'),
  ];

  for (const configPath of configCandidates) {
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const excludesFile = parseCoreExcludesFile(content);
      if (excludesFile) {
        return expandTilde(excludesFile);
      }
    } catch {
      // 文件不存在，继续
    }
  }

  // 所有配置文件都没有 core.excludesFile，回退到 XDG 默认路径
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'ignore');
}

/**
 * 生成配置文件内容的 hash
 */
async function generateConfigHash(rootPath: string): Promise<string> {
  const crypto = await import('node:crypto');
  const hashes: string[] = [];

  // 全局 Git 忽略文件
  const globalIgnorePath = await resolveGlobalGitIgnorePath(rootPath);
  if (globalIgnorePath) {
    try {
      const content = await fs.readFile(globalIgnorePath, 'utf-8');
      hashes.push(crypto.createHash('sha256').update(content).digest('hex'));
    } catch {
      // 文件不存在，跳过
    }
  }

  // 项目 .gitignore
  const gitignorePath = path.join(rootPath, '.gitignore');
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    hashes.push(crypto.createHash('sha256').update(content).digest('hex'));
  } catch {
    // 文件不存在，跳过
  }

  // 加上环境变量 IGNORE_PATTERNS
  const envPatterns = process.env.IGNORE_PATTERNS || '';
  const envHash = crypto.createHash('sha256').update(envPatterns).digest('hex');
  hashes.push(envHash);

  // 合并所有 hashes
  const combined = hashes.join('|');
  return crypto.createHash('sha256').update(combined).digest('hex');
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

  // 加载全局 Git 忽略文件
  const globalIgnorePath = await resolveGlobalGitIgnorePath(rootPath);
  if (globalIgnorePath) {
    try {
      ig.add(await fs.readFile(globalIgnorePath, 'utf-8'));
    } catch {
      // 文件不存在，跳过
    }
  }

  // 加载项目 .gitignore
  const gitignorePath = path.join(rootPath, '.gitignore');
  try {
    await fs.access(gitignorePath);
    ig.add(await fs.readFile(gitignorePath, 'utf-8'));
  } catch {
    // 文件不存在，静默跳过
  }

  ignoreInstance = ig;
  lastConfigHash = currentHash;
}

/**
 * 判断文件路径是否应该被过滤掉
 */
export function isFiltered(relativePath: string): boolean {
  if (!ignoreInstance) {
    throw new Error('Filter not initialized. Call initFilter() first.');
  }
  return ignoreInstance.ignores(relativePath);
}

/**
 * 判断文件扩展名是否在白名单中
 */
export function isAllowedFile(filePath: string): boolean {
  return isAllowedExtension(filePath);
}
