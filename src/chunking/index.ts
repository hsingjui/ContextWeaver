/**
 * 分片模块入口
 *
 * 导出语义分片相关的所有类型和功能
 */

// 核心类
export { SemanticSplitter, generateVectorText } from "./SemanticSplitter.js";
export { SourceAdapter, type IndexDomain } from "./SourceAdapter.js";

// Legacy: NwsCalculator 已被 SourceAdapter 取代，保留以兼容外部使用
export { NwsCalculator } from "./NwsCalculator.js";


// 解析器池
export { getParser, isLanguageSupported, getSupportedLanguages } from "./ParserPool.js";

// 语言规范
export { getLanguageSpec, isAstSupported, LANGUAGE_SPECS } from "./LanguageSpec.js";

// 类型
export type {
    ProcessedChunk,
    ChunkMetadata,
    Window,
    SplitterConfig,
} from "./types.js";
