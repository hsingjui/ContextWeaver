import path from 'node:path';
import { fdir } from 'fdir';
import { isAllowedFile, isFiltered, type PathFilter } from './filter.js';

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 使用 fdir 扫描文件系统，返回以 / 分隔、相对根目录的路径。
 * withRelativePaths 下文件回调直接拿到相对路径；exclude（目录）回调仍收到绝对路径，需剥前缀。
 */
export async function crawl(
  rootPath: string,
  isIgnored: PathFilter = isFiltered,
): Promise<string[]> {
  // fdir 会把 '.' 规范化成空前缀，导致文件路径丢掉目录，统一按绝对路径遍历。
  const resolvedRootPath = path.resolve(rootPath);
  const rootPrefix = new RegExp(`^${escapeRegExp(resolvedRootPath.replace(/\\/g, '/'))}/?`);
  const api = new fdir()
    .withRelativePaths()
    .withPathSeparator('/')
    .withErrors()
    .exclude((_name, dirPath) => {
      const relativePath = dirPath.replace(/\\/g, '/').replace(rootPrefix, '');
      return relativePath !== '' && isIgnored(`${relativePath.replace(/\/$/, '')}/`);
    })
    .filter((filePath: string) => isAllowedFile(filePath) && !isIgnored(filePath));

  const paths = await api.crawl(resolvedRootPath).withPromise();
  return paths;
}
