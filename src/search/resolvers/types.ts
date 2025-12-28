/**
 * ImportResolver 接口定义
 * 用于解析不同语言的导入语句
 */

/** 导入解析器接口 */
export interface ImportResolver {
    /** 检查是否支持该文件 */
    supports(filePath: string): boolean;
    /** 提取导入语句中的路径/模块名 */
    extract(content: string): string[];
    /** 解析为具体文件路径 */
    resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null;
}

/**
 * 计算两个路径的公共前缀长度（按路径段计算）
 * 用于歧义消解时，优先选择与当前文件路径前缀重叠最多的
 */
export function commonPrefixLength(path1: string, path2: string): number {
    const parts1 = path1.split('/');
    const parts2 = path2.split('/');
    let count = 0;
    for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
        if (parts1[i] === parts2[i]) {
            count++;
        } else {
            break;
        }
    }
    return count;
}
