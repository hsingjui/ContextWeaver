import type Parser from '@keqingmoe/tree-sitter';
import type Database from 'better-sqlite3';
import { getParser } from '../chunking/ParserPool.js';
import {
  type DependencyEdge,
  type DependencyKind,
  getStoredDependencyGraphVersion,
  replaceDependencyEdgesForSources,
  replaceDependencyGraph,
  setStoredDependencyGraphVersion,
} from '../db/index.js';
import { createResolvers } from '../search/resolvers/index.js';
import { logger } from '../utils/logger.js';

interface DependencySpecifier {
  specifier: string;
  kind: DependencyKind;
}

const DEPENDENCY_GRAPH_VERSION = 2;

function pushUnique(
  out: DependencySpecifier[],
  seen: Set<string>,
  specifier: string | undefined,
  kind: DependencyKind,
): void {
  if (!specifier) return;
  const key = `${specifier}\0${kind}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ specifier, kind });
}

function jsTsLanguage(filePath: string): 'typescript' | 'tsx' | 'javascript' | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return 'typescript';
  }
  if (/\.(?:jsx?|mjs|cjs)$/i.test(lower)) return 'javascript';
  return null;
}

/**
 * Extract JS/TS module edges from syntax nodes rather than raw source regexes. This prevents
 * commented-out imports and string literals from becoming dependency edges while still working
 * on partially-invalid trees (Tree-sitter keeps recoverable import/export nodes outside ERROR).
 */
async function extractJsTsSpecifiers(
  filePath: string,
  content: string,
): Promise<DependencySpecifier[] | null> {
  const language = jsTsLanguage(filePath);
  if (!language) return null;
  const parser = await getParser(language);
  if (!parser) return [];

  const tree = parser.parse(content);
  const out: DependencySpecifier[] = [];
  const seen = new Set<string>();

  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'ERROR') return;

    if (node.type === 'import_statement') {
      const text = node.text;
      const from = text.match(/\bfrom\s+['"]([^'"]+)['"]/);
      const sideEffect = text.match(/^\s*import\s+['"]([^'"]+)['"]/);
      pushUnique(out, seen, from?.[1] ?? sideEffect?.[1], 'import');
    } else if (node.type === 'export_statement') {
      const from = node.text.match(/\bfrom\s+['"]([^'"]+)['"]/);
      pushUnique(out, seen, from?.[1], 'reexport');
    } else if (node.type === 'call_expression') {
      const text = node.text;
      const dynamic = text.match(/^\s*(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      pushUnique(out, seen, dynamic?.[1], 'import');
    }

    for (const child of node.namedChildren) visit(child);
  };

  visit(tree.rootNode);
  return out;
}

function classifyNonJsSpecifiers(filePath: string, content: string): DependencySpecifier[] {
  if (filePath.endsWith('.rs')) {
    const out: DependencySpecifier[] = [];
    for (const match of content.matchAll(/^\s*pub\s+mod\s+(\w+)\s*;/gm)) {
      out.push({ specifier: `mod:${match[1]}`, kind: 'export' });
    }
    for (const match of content.matchAll(/^\s*pub\s+use\s+((?:crate|super|self)(?:::\w+)+)/gm)) {
      out.push({ specifier: `use:${match[1]}`, kind: 'reexport' });
    }
    for (const match of content.matchAll(/^\s*mod\s+(\w+)\s*;/gm)) {
      out.push({ specifier: `mod:${match[1]}`, kind: 'import' });
    }
    for (const match of content.matchAll(/^\s*use\s+((?:crate|super|self)(?:::\w+)+)/gm)) {
      out.push({ specifier: `use:${match[1]}`, kind: 'import' });
    }
    return out;
  }
  return [];
}

async function buildEdgesForRows(
  rows: Array<{ path: string; content: string }>,
  allFiles: Set<string>,
): Promise<DependencyEdge[]> {
  const resolvers = createResolvers();
  const edges: DependencyEdge[] = [];
  const seenEdges = new Set<string>();

  for (const row of rows) {
    const resolver = resolvers.find((candidate) => candidate.supports(row.path));
    if (!resolver) continue;

    const jsTs = await extractJsTsSpecifiers(row.path, row.content);
    let specifiers: DependencySpecifier[];
    if (jsTs !== null) {
      specifiers = jsTs;
    } else {
      const classified = classifyNonJsSpecifiers(row.path, row.content);
      const bySpecifier = new Map(classified.map((item) => [item.specifier, item.kind]));
      for (const specifier of new Set(resolver.extract(row.content))) {
        if (!bySpecifier.has(specifier)) bySpecifier.set(specifier, 'import');
      }
      specifiers = Array.from(bySpecifier, ([specifier, kind]) => ({ specifier, kind }));
    }

    for (const item of specifiers) {
      const target = resolver.resolve(item.specifier, row.path, allFiles);
      if (!target || target === row.path) continue;
      const key = `${row.path}\0${target}\0${item.kind}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ fromPath: row.path, toPath: target, kind: item.kind });
    }
  }

  return edges;
}

/** Full rebuild used only for graph-version upgrades or explicit repair. */
export async function rebuildDependencyGraph(db: Database.Database): Promise<DependencyEdge[]> {
  const rows = db
    .prepare('SELECT path, content FROM files WHERE content IS NOT NULL')
    .all() as Array<{ path: string; content: string }>;
  const allFiles = new Set(rows.map((row) => row.path));
  const edges = await buildEdgesForRows(rows, allFiles);
  replaceDependencyGraph(db, edges);
  setStoredDependencyGraphVersion(db, DEPENDENCY_GRAPH_VERSION);
  logger.debug(
    { files: rows.length, edges: edges.length, version: DEPENDENCY_GRAPH_VERSION },
    'Dependency graph rebuilt',
  );
  return edges;
}

/**
 * Incrementally replace outgoing edges for changed/affected source files. A graph-version change
 * still performs one full rebuild. Deleted paths are removed by batchDelete before this runs; the
 * scanner adds known reverse dependents to changedPaths so they can be re-resolved after deletion.
 */
export async function ensureDependencyGraph(
  db: Database.Database,
  changedPaths: string[] = [],
): Promise<'rebuild' | 'incremental' | 'clean'> {
  if (getStoredDependencyGraphVersion(db) !== DEPENDENCY_GRAPH_VERSION) {
    await rebuildDependencyGraph(db);
    return 'rebuild';
  }
  const uniquePaths = Array.from(new Set(changedPaths));
  if (uniquePaths.length === 0) return 'clean';

  const rows = db
    .prepare(`
      SELECT path, content
      FROM files
      WHERE content IS NOT NULL
        AND path IN (SELECT value FROM json_each(?))
    `)
    .all(JSON.stringify(uniquePaths)) as Array<{ path: string; content: string }>;
  const allFiles = new Set(
    (db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((row) => row.path),
  );
  const edges = await buildEdgesForRows(rows, allFiles);
  replaceDependencyEdgesForSources(
    db,
    uniquePaths.filter((filePath) => allFiles.has(filePath)),
    edges,
  );
  logger.debug(
    { files: rows.length, requested: uniquePaths.length, edges: edges.length },
    'Dependency graph incrementally updated',
  );
  return 'incremental';
}
