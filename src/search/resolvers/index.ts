/**
 * 导入解析器模块统一导出
 *
 * 支持的语言：
 * - TypeScript/JavaScript
 * - Python
 * - Go
 * - Java
 * - Rust
 */

import { GoResolver } from './GoResolver.js';
import { JavaResolver } from './JavaResolver.js';
import { JsTsResolver } from './JsTsResolver.js';
import { PythonResolver } from './PythonResolver.js';
import { RustResolver } from './RustResolver.js';
import type { ImportResolver } from './types.js';

export type { ImportResolver } from './types.js';

/**
 * 获取所有注册的解析器实例（按优先级排列）
 */
export function createResolvers(): ImportResolver[] {
  return [
    new JsTsResolver(),
    new PythonResolver(),
    new GoResolver(),
    new JavaResolver(),
    new RustResolver(),
  ];
}
