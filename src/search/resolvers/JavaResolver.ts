/**
 * Java 解析策略 (类名→路径映射 + 后缀匹配)
 */

import type { ImportResolver } from "./types.js";

export class JavaResolver implements ImportResolver {
    supports(filePath: string): boolean {
        return filePath.endsWith('.java');
    }

    extract(content: string): string[] {
        const imports: string[] = [];
        // 匹配: import com.example.MyClass; 或 import static com.example.MyClass.method;
        const pattern = /^\s*import\s+(?:static\s+)?([\w.]+);/gm;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            imports.push(match[1]);
        }
        return imports;
    }

    resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
        // Java import: com.example.MyClass -> com/example/MyClass.java
        // 或者通配符: com.example.* -> 目录下的所有文件（这里只返回目录中的第一个文件）

        if (importStr.endsWith('.*')) {
            // 通配符导入，匹配目录
            const pkgPath = importStr.slice(0, -2).replace(/\./g, '/');
            const suffix = `/${pkgPath}/`;

            for (const filePath of allFiles) {
                if (filePath.endsWith('.java') && filePath.includes(suffix)) {
                    return filePath;
                }
            }
            return null;
        }

        // 普通导入: com.example.MyClass -> 找 /com/example/MyClass.java
        const classPath = importStr.replace(/\./g, '/');
        const suffix = `/${classPath}.java`;

        for (const filePath of allFiles) {
            if (filePath.endsWith(suffix)) {
                return filePath;
            }
        }

        return null;
    }
}
