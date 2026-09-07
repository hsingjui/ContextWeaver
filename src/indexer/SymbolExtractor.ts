import type Parser from '@keqingmoe/tree-sitter';
import { getLanguageSpec, type LanguageSpecConfig } from '../chunking/LanguageSpec.js';
import { getParser, isLanguageSupported } from '../chunking/ParserPool.js';
import { SourceAdapter } from '../chunking/SourceAdapter.js';
import type { ProcessedChunk } from '../chunking/types.js';

type SymbolKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'struct'
  | 'record'
  | 'trait'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'type'
  | 'namespace'
  | 'module'
  | 'definition';

export interface ExtractedSymbol {
  identifier: string;
  kind: SymbolKind;
  chunkIndex: number;
  startIndex: number;
  endIndex: number;
}

function symbolKind(nodeType: string): SymbolKind {
  if (nodeType.includes('constructor')) return 'constructor';
  if (nodeType.includes('method')) return 'method';
  if (nodeType.includes('property')) return 'property';
  if (nodeType.includes('interface')) return 'interface';
  if (nodeType.includes('class')) return 'class';
  if (nodeType.includes('enum')) return 'enum';
  if (nodeType.includes('struct')) return 'struct';
  if (nodeType.includes('record')) return 'record';
  if (nodeType.includes('trait')) return 'trait';
  if (nodeType.includes('namespace')) return 'namespace';
  if (nodeType === 'mod_item') return 'module';
  if (
    nodeType.includes('function') ||
    nodeType === 'arrow_function' ||
    nodeType === 'function_item'
  ) {
    return 'function';
  }
  if (nodeType.includes('type') || nodeType === 'type_spec') return 'type';
  return 'definition';
}

function findNameNode(
  node: Parser.SyntaxNode | null,
  spec: LanguageSpecConfig,
  depth = 0,
): Parser.SyntaxNode | null {
  if (!node || depth > 8) return null;
  if (spec.nameNodeTypes.has(node.type)) return node;

  for (const field of ['declarator', 'name']) {
    const nested = node.childForFieldName(field);
    const found = findNameNode(nested, spec, depth + 1);
    if (found) return found;
  }

  for (const child of node.namedChildren) {
    if (spec.nameNodeTypes.has(child.type)) return child;
  }
  return null;
}

function extractNameNode(
  node: Parser.SyntaxNode,
  spec: LanguageSpecConfig,
): Parser.SyntaxNode | null {
  for (const field of spec.nameFields) {
    const found = findNameNode(node.childForFieldName(field), spec);
    if (found) return found;
  }

  if (node.type === 'arrow_function' && node.parent?.type === 'variable_declarator') {
    return findNameNode(node.parent.childForFieldName('name'), spec);
  }

  for (const child of node.namedChildren) {
    if (spec.nameNodeTypes.has(child.type)) return child;
  }
  return null;
}

function chunkForOffset(chunks: ProcessedChunk[], startIndex: number): number | null {
  for (let index = 0; index < chunks.length; index++) {
    const span = chunks[index].metadata.rawSpan;
    if (startIndex >= span.start && startIndex < span.end) return index;
  }
  return null;
}

/** Extract definition-like symbols from the same Tree-sitter AST used by chunking. */
export async function extractSymbols(
  filePath: string,
  language: string,
  content: string,
  chunks: ProcessedChunk[],
): Promise<ExtractedSymbol[]> {
  if (!content || chunks.length === 0 || !isLanguageSupported(language)) return [];
  const grammarLanguage =
    language === 'typescript' && filePath.toLowerCase().endsWith('.tsx') ? 'tsx' : language;
  const parser = await getParser(grammarLanguage);
  const spec = getLanguageSpec(language);
  if (!parser || !spec) return [];

  const tree = parser.parse(content);
  const adapter = new SourceAdapter({ code: content, endIndex: tree.rootNode.endIndex });
  if (adapter.getDomain() === 'unknown') return [];

  const out: ExtractedSymbol[] = [];
  const seen = new Set<string>();

  const visit = (node: Parser.SyntaxNode): void => {
    // Tree-sitter can recover valid siblings around an ERROR subtree while a user is editing.
    // Keep those definitions instead of discarding the whole file.
    if (node.type === 'ERROR') return;
    if (spec.hierarchy.has(node.type)) {
      const nameNode = extractNameNode(node, spec);
      if (nameNode) {
        const identifier = nameNode.text.trim();
        if (identifier) {
          const startIndex =
            adapter.getDomain() === 'utf8'
              ? adapter.byteToChar(nameNode.startIndex)
              : nameNode.startIndex;
          const endIndex =
            adapter.getDomain() === 'utf8'
              ? adapter.byteToChar(nameNode.endIndex)
              : nameNode.endIndex;
          const chunkIndex = chunkForOffset(chunks, startIndex);
          if (chunkIndex !== null) {
            const kind = symbolKind(node.type);
            const key = `${identifier}\0${kind}\0${startIndex}\0${endIndex}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ identifier, kind, chunkIndex, startIndex, endIndex });
            }
          }
        }
      }
    }

    for (const child of node.namedChildren) visit(child);
  };

  visit(tree.rootNode);
  return out;
}
