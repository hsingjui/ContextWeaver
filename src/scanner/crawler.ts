import { fdir } from 'fdir';
import path from 'path';
import { isAllowedFile, isFiltered } from './filter.js';

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 使用 fdir 扫描文件系统
 */
export async function crawl(rootPath: string): Promise<string[]> {
  const api = new fdir()
    .withFullPaths()
    .withErrors()
    .filter((filePath: string) => {
      // 标准化路径分隔符为 /，确保跨平台兼容
      const normalizedFilePath = filePath.replace(/\\/g, '/');
      const normalizedRootPath = rootPath.replace(/\\/g, '/');
      const relativePath = normalizedFilePath.replace(
        new RegExp(`^${escapeRegExp(normalizedRootPath)}/?`),
        '',
      );
      return !isFiltered(relativePath) && isAllowedFile(filePath);
    });

  const paths = await api.crawl(rootPath).withPromise();
  return paths;
}
