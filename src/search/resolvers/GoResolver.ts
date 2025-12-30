/**
 * Go 解析策略 (包路径后缀匹配)
 */

import type { ImportResolver } from './types.js';

export class GoResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith('.go');
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配单行 import: import "fmt"
    const singlePattern = /^\s*import\s+"([^"]+)"/gm;
    for (const match of content.matchAll(singlePattern)) {
      imports.push(match[1]);
    }

    // 匹配多行 import 块: import ( "fmt" "os" )
    const blockPattern = /import\s*\(\s*([\s\S]*?)\s*\)/g;
    for (const match of content.matchAll(blockPattern)) {
      const block = match[1];
      // 提取块内的每个导入路径
      const linePattern = /"([^"]+)"/g;
      for (const lineMatch of block.matchAll(linePattern)) {
        imports.push(lineMatch[1]);
      }
    }

    return imports;
  }

  resolve(importStr: string, _currentFile: string, allFiles: Set<string>): string | null {
    // Go 的导入路径通常是包路径，如 "github.com/user/repo/pkg"
    // 我们使用后缀模糊匹配来查找对应的目录下的 .go 文件

    // 跳过标准库（不包含 . 或 /）
    if (!importStr.includes('/') && !importStr.includes('.')) {
      return null;
    }

    // 后缀匹配：找到以该路径结尾的目录中的 .go 文件
    const suffix = `/${importStr}/`;
    const candidates: string[] = [];

    for (const filePath of allFiles) {
      if (filePath.endsWith('.go') && filePath.includes(suffix)) {
        candidates.push(filePath);
      }
    }

    if (candidates.length === 0) return null;

    // 优先返回非 _test.go 的文件
    const nonTest = candidates.find((f) => !f.endsWith('_test.go'));
    return nonTest || candidates[0];
  }
}
