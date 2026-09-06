import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { getExcludePatterns } from '../config.js';
import { logger } from '../utils/logger.js';
import { isAllowedExtension } from './language.js';

export type PathFilter = (relativePath: string) => boolean;
let currentFilter: PathFilter | null = null;

async function readOptional(absolutePath: string): Promise<string> {
  try {
    return await fs.readFile(absolutePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '';
  }
}

/** 把目录内 gitignore 模式限定到根目录相对路径，保留否定和锚定语义。 */
function scopedPatterns(directory: string, content: string): string[] {
  const prefix = directory.replace(/[\\*?[\]!#]/g, '\\$&');
  return content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim() || line.startsWith('#')) return [];
      const negative = line.startsWith('!');
      const pattern = negative ? line.slice(1) : line;
      if (!pattern.trim() || /^\/\s*$/.test(pattern)) return [];
      const anchored = pattern.startsWith('/') || pattern.replace(/\/\s*$/, '').includes('/');
      return [
        `${negative ? '!' : ''}${prefix}/${anchored ? '' : '**/'}${pattern.replace(/^\//, '')}`,
      ];
    });
}

/**
 * 每次扫描独立快照，目录规则按需读取一次。
 * 优先级：默认 < 根/子目录 .gitignore < IGNORE_PATTERNS。
 */
export async function initFilter(rootPath: string): Promise<PathFilter> {
  const rootRules = [
    ...getExcludePatterns(),
    ...(await readOptional(path.join(rootPath, '.gitignore'))).split(/\r?\n/),
  ];
  const overrides = (process.env.IGNORE_PATTERNS || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  type DirectoryFilter = { rules: string[]; filter: ignore.Ignore };
  const filters = new Map<string, DirectoryFilter>();
  const getFilter = (directory: string): DirectoryFilter => {
    const cached = filters.get(directory);
    if (cached) return cached;
    let rules = rootRules;
    if (directory !== '') {
      const slash = directory.lastIndexOf('/');
      const parent = slash < 0 ? '' : directory.slice(0, slash);
      const parentFilter = getFilter(parent);
      let content = '';
      try {
        // fdir 的过滤回调同步执行；只读取实际遍历目录，且每目录每次扫描只读一次。
        content = readFileSync(path.join(rootPath, directory, '.gitignore'), 'utf-8');
      } catch (error) {
        // 该回调运行在 fdir 的 fs 回调里，抛出会变成 uncaughtException，因此单个目录规则不可读时降级为无规则。
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          logger.warn({ directory, code }, '跳过不可读的 .gitignore');
        }
      }
      const scoped = scopedPatterns(directory, content);
      if (scoped.length === 0) {
        filters.set(directory, parentFilter);
        return parentFilter;
      }
      rules = [...parentFilter.rules, ...scoped];
    }
    const entry = { rules, filter: ignore().add(rules).add(overrides) };
    filters.set(directory, entry);
    return entry;
  };
  const filter: PathFilter = (relativePath) => {
    const normalized = relativePath.replace(/\\/g, '/');
    const slash = normalized.replace(/\/$/, '').lastIndexOf('/');
    const directory = slash < 0 ? '' : normalized.slice(0, slash);
    return getFilter(directory).filter.ignores(normalized);
  };
  currentFilter = filter;
  return filter;
}

/** 保留现有调用接口；扫描器传递独立 filter，避免不同仓库互相覆盖。 */
export function isFiltered(relativePath: string): boolean {
  if (!currentFilter) throw new Error('Filter not initialized. Call initFilter() first.');
  return currentFilter(relativePath);
}

export function isAllowedFile(filePath: string): boolean {
  return isAllowedExtension(filePath);
}
