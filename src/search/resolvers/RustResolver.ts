/**
 * Rust 解析策略 (mod/use 解析)
 */

import type { ImportResolver } from "./types.js";

export class RustResolver implements ImportResolver {
    supports(filePath: string): boolean {
        return filePath.endsWith('.rs');
    }

    extract(content: string): string[] {
        const imports: string[] = [];

        // 匹配 mod xxx; (外部模块声明)
        const modPattern = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
        let match;
        while ((match = modPattern.exec(content)) !== null) {
            imports.push(`mod:${match[1]}`);
        }

        // 匹配 use crate::xxx 或 use super::xxx 或 use self::xxx
        const usePattern = /^\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)+)/gm;
        while ((match = usePattern.exec(content)) !== null) {
            imports.push(`use:${match[1]}`);
        }

        return imports;
    }

    resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
        const currentDir = currentFile.split('/').slice(0, -1).join('/');

        if (importStr.startsWith('mod:')) {
            // mod xxx; -> 查找 xxx.rs 或 xxx/mod.rs
            const modName = importStr.slice(4);
            const candidates = [
                `${currentDir}/${modName}.rs`,
                `${currentDir}/${modName}/mod.rs`
            ];

            for (const candidate of candidates) {
                if (allFiles.has(candidate)) {
                    return candidate;
                }
            }
            return null;
        }

        if (importStr.startsWith('use:')) {
            // use crate::xxx::yyy -> 从 crate 根目录解析
            // use super::xxx -> 从父目录解析
            // use self::xxx -> 从当前模块解析
            const usePath = importStr.slice(4);
            const parts = usePath.split('::');

            let baseParts: string[];
            let startIndex: number;

            if (parts[0] === 'crate') {
                // 从 src/ 或项目根开始
                // 尝试找到 src 目录或 lib.rs/main.rs 所在目录
                const srcIndex = currentFile.indexOf('/src/');
                if (srcIndex !== -1) {
                    baseParts = currentFile.slice(0, srcIndex + 4).split('/');
                } else {
                    baseParts = currentDir.split('/');
                }
                startIndex = 1;
            } else if (parts[0] === 'super') {
                // 从父目录开始
                baseParts = currentDir.split('/').slice(0, -1);
                startIndex = 1;
            } else if (parts[0] === 'self') {
                // 从当前目录开始
                baseParts = currentDir.split('/');
                startIndex = 1;
            } else {
                return null;
            }

            // 构建路径
            const moduleParts = parts.slice(startIndex);
            const modulePath = [...baseParts, ...moduleParts].join('/');

            // 尝试多种可能的路径
            const candidates = [
                `${modulePath}.rs`,
                `${modulePath}/mod.rs`
            ];

            for (const candidate of candidates) {
                if (allFiles.has(candidate)) {
                    return candidate;
                }
            }
            return null;
        }

        return null;
    }
}
