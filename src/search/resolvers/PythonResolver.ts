/**
 * Python 解析策略 (正则 + 后缀模糊匹配 + 路径前缀歧义消解)
 */

import type { ImportResolver } from './types.js';
import { commonPrefixLength } from './types.js';

export class PythonResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith('.py');
  }

  extract(content: string): string[] {
    // 匹配: from xxx import yyy 或 import xxx
    // 也支持相对导入: from . import xxx, from ..utils import yyy
    const pattern = /^\s*(?:from\s+(\.{0,3}[\w.]*)\s+import|import\s+([\w.]+))/gm;
    const imports: string[] = [];
    for (const match of content.matchAll(pattern)) {
      const importStr = match[1] || match[2];
      if (importStr) {
        imports.push(importStr);
      }
    }
    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    // 1. 处理相对导入 (from . import xxx, from ..utils import yyy)
    if (importStr.startsWith('.')) {
      return this.resolveRelativeImport(importStr, currentFile, allFiles);
    }

    // 2. 处理绝对导入 (from my.pkg import xxx)
    return this.resolveAbsoluteImport(importStr, currentFile, allFiles);
  }

  /**
   * 解析 Python 相对导入
   * - from . import foo -> 当前目录的 foo.py 或 foo/__init__.py
   * - from .. import bar -> 父目录的 bar.py 或 bar/__init__.py
   * - from ..utils import baz -> 父目录的 utils.py 或 utils/baz.py
   */
  private resolveRelativeImport(
    importStr: string,
    currentFile: string,
    allFiles: Set<string>,
  ): string | null {
    // 计算 . 的数量
    const dotMatch = importStr.match(/^(\.+)/);
    if (!dotMatch) return null;

    const dotCount = dotMatch[1].length;
    const rest = importStr.slice(dotCount); // 去掉前面的点

    // 获取当前文件的目录部分
    const currentParts = currentFile.split('/');
    currentParts.pop(); // 移除文件名

    // 返回 dotCount - 1 层父目录 (. = 当前目录, .. = 父目录)
    const targetDirParts = currentParts.slice(0, currentParts.length - (dotCount - 1));
    if (targetDirParts.length < 0) return null;

    // 拼接目标路径
    const modulePath = rest.replace(/\./g, '/');
    const basePath = targetDirParts.join('/');

    // 尝试多种可能的路径
    const candidates: string[] = [];
    if (modulePath) {
      candidates.push(`${basePath}/${modulePath}.py`, `${basePath}/${modulePath}/__init__.py`);
    } else {
      // from . import xxx 或 from .. import xxx
      candidates.push(`${basePath}/__init__.py`);
    }

    for (const candidate of candidates) {
      if (allFiles.has(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * 解析 Python 绝对导入 (后缀模糊匹配 + 路径前缀歧义消解)
   * - from my.pkg import xxx -> 找到以 /my/pkg.py 或 /my/pkg/__init__.py 结尾的文件
   * - 如果有多个匹配，优先选择与当前文件路径前缀重叠最多的
   */
  private resolveAbsoluteImport(
    importStr: string,
    currentFile: string,
    allFiles: Set<string>,
  ): string | null {
    // 归一化: my.pkg -> my/pkg
    const modulePath = importStr.replace(/\./g, '/');

    // 后缀模糊匹配
    const suffixes = [`/${modulePath}.py`, `/${modulePath}/__init__.py`];

    // 收集所有匹配的候选路径
    const candidates: string[] = [];

    for (const filePath of allFiles) {
      for (const suffix of suffixes) {
        if (filePath.endsWith(suffix)) {
          // 检查边界符，确保 suffix 前面是 / 或者是路径开头
          const boundaryIndex = filePath.length - suffix.length;
          if (boundaryIndex <= 0 || filePath[boundaryIndex - 1] === '/') {
            candidates.push(filePath);
            break; // 避免同一文件匹配多个 suffix
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // 歧义消解：优先选择与当前文件路径前缀重叠最多的
    const currentDir = currentFile.split('/').slice(0, -1).join('/');

    candidates.sort((a, b) => {
      const overlapA = commonPrefixLength(a, currentDir);
      const overlapB = commonPrefixLength(b, currentDir);
      return overlapB - overlapA; // 前缀重叠越多，优先级越高
    });

    return candidates[0];
  }
}
