/**
 * 分片模块入口
 *
 * 导出语义分片相关的所有类型和功能
 */

// 解析器池
export { getParser, isLanguageSupported } from './ParserPool.js';
// 核心类
export { SemanticSplitter } from './SemanticSplitter.js';

// 类型
export type { ProcessedChunk } from './types.js';
