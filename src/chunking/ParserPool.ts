/**
 * 解析器池管理
 *
 * 按语言缓存 Parser 实例，避免重复初始化。
 * 支持动态加载语言语法包。
 *
 */
import Parser from 'tree-sitter';

// 语言到语法模块的映射
const GRAMMAR_MODULES: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  cxx: 'tree-sitter-cpp',
};

// 缓存已加载的语法
// tree-sitter Language 类型是原生对象，没有导出类型定义
type TreeSitterLanguage = unknown;
const loadedGrammars: Map<string, TreeSitterLanguage> = new Map();

// 缓存已初始化的解析器
const parserCache: Map<string, Parser> = new Map();

/**
 * 加载指定语言的语法
 *
 * tree-sitter 0.20.x 的导出格式：
 * - tree-sitter-typescript: { typescript, tsx } (需要取 .typescript)
 * - 其他语言包: default export 直接是 Language 对象
 */
async function loadGrammar(language: string): Promise<TreeSitterLanguage | null> {
  // 检查缓存
  const cached = loadedGrammars.get(language);
  if (cached) return cached;

  const moduleName = GRAMMAR_MODULES[language];
  if (!moduleName) return null;

  try {
    // 动态导入语法模块
    const grammarModule = await import(moduleName);

    let grammar: TreeSitterLanguage | null = null;

    // tree-sitter-typescript 包特殊处理（包含 typescript 和 tsx 两个语言）
    if (language === 'typescript') {
      grammar = grammarModule.default?.typescript ?? grammarModule.typescript;
    } else {
      // 其他语言包: 0.20.x 版本直接使用 default export
      const exported = grammarModule.default ?? grammarModule;

      // 判断是否是有效的 Language 对象（有 nodeTypeInfo 属性）
      if (exported && typeof exported === 'object' && 'nodeTypeInfo' in exported) {
        grammar = exported;
      }
      // 尝试 language property（某些版本使用这种格式）
      else if (exported?.language) {
        grammar = exported.language;
      }
      // 尝试以语言名命名的属性
      else if (exported?.[language]) {
        grammar = exported[language];
      }
    }

    if (!grammar) {
      console.error(
        `[ParserPool] Could not extract grammar for ${language} from module ${moduleName}`,
      );
      return null;
    }

    loadedGrammars.set(language, grammar);
    return grammar;
  } catch (err) {
    console.error(`[ParserPool] Failed to load grammar for ${language}:`, err);
    return null;
  }
}

/**
 * 获取指定语言的解析器
 * @param language 语言标识
 * @returns Parser 实例，如果不支持该语言则返回 null
 */
export async function getParser(language: string): Promise<Parser | null> {
  // 检查缓存
  const cached = parserCache.get(language);
  if (cached) return cached;

  // 加载语法
  const grammar = await loadGrammar(language);
  if (!grammar) return null;

  // 创建解析器
  const parser = new Parser();
  parser.setLanguage(grammar);

  // 缓存
  parserCache.set(language, parser);
  return parser;
}

/**
 * 检查是否支持指定语言
 */
export function isLanguageSupported(language: string): boolean {
  return language in GRAMMAR_MODULES;
}
