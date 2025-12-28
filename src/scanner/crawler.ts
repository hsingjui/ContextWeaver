import { fdir } from "fdir";
import path from "path";
import { isFiltered, isAllowedFile } from "./filter.js";

/**
 * 使用 fdir 扫描文件系统
 */
export async function crawl(rootPath: string): Promise<string[]> {
  const api = new fdir()
    .withFullPaths()
    .withErrors()
    .filter((filePath: string) => {
      const relativePath = filePath.replace(rootPath + path.sep, "").replace(new RegExp(`^${rootPath}/?`), "");
      return !isFiltered(relativePath) && isAllowedFile(filePath);
    });

  const paths = await api.crawl(rootPath).withPromise();
  return paths;
}
