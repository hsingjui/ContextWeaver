import { fdir } from 'fdir';
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
  // 根路径前缀只编译一次：fdir 的 filter/exclude 是逐条目回调，
  // 之前每个文件都重新 escapeRegExp + new RegExp，大仓库下开销显著
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const rootPrefix = new RegExp(`^${escapeRegExp(normalizedRoot)}[\\\\/]`);

  /** 规范化分隔符为 /，并剥掉根路径前缀，得到相对路径 */
  const toRelative = (p: string): string => p.replace(/\\/g, '/').replace(rootPrefix, '');

  const api = new fdir()
    .withFullPaths()
    .withErrors()
    // 目录剪枝：阻止进入被忽略的目录（node_modules/.git/dist 等），
    // filter 只过滤结果、不会阻止遍历，逐文件过滤时这些目录仍被完整遍历
    // ponytail: 剪枝不识别 gitignore 的 ! 反选（如 !dist/keep.json），需要时按目录逐层精确匹配
    .exclude((_dirName, dirPath) => {
      const relDir = toRelative(dirPath);
      // relDir 为空说明是扫描根目录本身，不剪
      return relDir !== '' && isFiltered(`${relDir}/`);
    })
    .filter((filePath: string) => {
      return !isFiltered(toRelative(filePath)) && isAllowedFile(filePath);
    });

  const paths = await api.crawl(rootPath).withPromise();
  return paths;
}
