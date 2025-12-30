/**
 * JS/TS 解析策略 (保留原有的扩展名映射逻辑)
 */

import type { ImportResolver } from './types.js';

export class JsTsResolver implements ImportResolver {
  private exts = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];

  // TypeScript ESM 项目使用 .js 扩展名导入，但源文件是 .ts
  private extMapping: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.js', '.jsx'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs'],
  };

  supports(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return this.exts.includes(`.${ext}` || '');
  }

  extract(content: string): string[] {
    const imports: string[] = [];
    const patterns = [
      // import xxx from './foo' 或 import { xxx } from './foo'
      /(?:import|export)\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g,
      // import('./foo') 或 require('./foo')
      /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        imports.push(match[1]);
      }
    }
    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    // 只处理相对路径
    if (!importStr.startsWith('.')) return null;

    const currentDir = currentFile.split('/').slice(0, -1).join('/');
    const parts = [...currentDir.split('/'), ...importStr.split('/')];
    const resolvedParts: string[] = [];

    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') resolvedParts.pop();
      else resolvedParts.push(part);
    }

    const basePath = resolvedParts.join('/');

    // 先检查是否已有扩展名，并尝试扩展名映射
    const existingExt = this.exts.find((ext) => basePath.endsWith(ext));
    if (existingExt) {
      const basePathWithoutExt = basePath.slice(0, -existingExt.length);
      const mappedExts = this.extMapping[existingExt] || [existingExt];

      for (const mappedExt of mappedExts) {
        const mappedPath = basePathWithoutExt + mappedExt;
        if (allFiles.has(mappedPath)) return mappedPath;
      }
      return null;
    }

    // 尝试各种扩展名
    for (const ext of this.exts) {
      const pathWithExt = basePath + ext;
      if (allFiles.has(pathWithExt)) return pathWithExt;
    }

    // 尝试 /index.ts 等
    for (const ext of this.exts) {
      const indexPath = `${basePath}/index${ext}`;
      if (allFiles.has(indexPath)) return indexPath;
    }

    return null;
  }
}
