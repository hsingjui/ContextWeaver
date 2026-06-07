import type Database from 'better-sqlite3';
import type { ChunkRecord } from '../vectorStore/index.js';
import {
  EXACT_MAX_CANDIDATES_PER_TERM,
  EXACT_MAX_HITS,
  EXACT_MAX_TERMS,
  EXACT_MIN_TERM_LENGTH,
  normalizeExactTechnicalTerms,
} from './exactTechnicalTerms.js';

export interface ExactIndexChunkInput {
  chunkId: string;
  filePath: string;
  fileHash: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  rawStart: number;
  rawEnd: number;
  content: string;
  displayCode: string;
}

export interface ExactSearchConfig {
  exactMaxTerms?: number;
  exactMinTermLength?: number;
  exactMaxCandidatesPerTerm?: number;
  exactMaxHits?: number;
}

export interface ExactSearchHit {
  chunk: ChunkRecord;
  matchedTerms: string[];
}

export interface ExactSearchResult {
  terms: string[];
  skippedTechnicalTerms: string[];
  hits: ExactSearchHit[];
  missingExactTechnicalTerms: string[];
  exactScanChunkCount: number;
  exactScanElapsedMs: number;
  exactHitsTruncated: boolean;
  exactSearchSource: string[];
}

interface ExactChunkRow {
  project_id: string;
  chunk_id: string;
  file_path: string;
  file_hash: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  raw_start: number;
  raw_end: number;
  content: string;
  display_code: string;
}

export function initExactIndex(db: Database.Database): void {
  dropLegacyExactIndexIfNeeded(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS exact_chunks (
      project_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      raw_start INTEGER NOT NULL,
      raw_end INTEGER NOT NULL,
      content TEXT NOT NULL,
      display_code TEXT NOT NULL,
      PRIMARY KEY (project_id, chunk_id)
    );
    CREATE TABLE IF NOT EXISTS exact_grams (
      project_id TEXT NOT NULL,
      gram TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      PRIMARY KEY (project_id, gram, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_exact_chunks_project_file_path
      ON exact_chunks(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_exact_grams_project_gram
      ON exact_grams(project_id, gram);
    CREATE INDEX IF NOT EXISTS idx_exact_grams_project_chunk_id
      ON exact_grams(project_id, chunk_id);
  `);
}

function dropLegacyExactIndexIfNeeded(db: Database.Database): void {
  const shouldDropLegacyExactIndex =
    (tableExists(db, 'exact_chunks') && !tableHasColumn(db, 'exact_chunks', 'project_id')) ||
    (tableExists(db, 'exact_grams') && !tableHasColumn(db, 'exact_grams', 'project_id'));

  if (!shouldDropLegacyExactIndex) return;

  const dropLegacyTables = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS exact_grams; DROP TABLE IF EXISTS exact_chunks;');
  });
  dropLegacyTables();
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export function clearProjectExactIndex(db: Database.Database, projectId: string): void {
  const transaction = db.transaction((id: string) => {
    db.prepare('DELETE FROM exact_grams WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM exact_chunks WHERE project_id = ?').run(id);
  });
  transaction(projectId);
}

export function batchDeleteExactIndex(
  db: Database.Database,
  projectId: string,
  filePaths: string[],
): void {
  if (filePaths.length === 0) return;

  const deleteGramsStmt = db.prepare(`
    DELETE FROM exact_grams
    WHERE project_id = ?
      AND chunk_id IN (
        SELECT chunk_id FROM exact_chunks
        WHERE project_id = ? AND file_path = ?
      )
  `);
  const deleteChunksStmt = db.prepare(
    'DELETE FROM exact_chunks WHERE project_id = ? AND file_path = ?',
  );

  const transaction = db.transaction((paths: string[]) => {
    for (const filePath of paths) {
      deleteGramsStmt.run(projectId, projectId, filePath);
      deleteChunksStmt.run(projectId, filePath);
    }
  });
  transaction(filePaths);
}

export function batchUpsertExactIndex(
  db: Database.Database,
  projectId: string,
  chunks: ExactIndexChunkInput[],
): void {
  if (chunks.length === 0) return;

  const insertChunkStmt = db.prepare(`
    INSERT INTO exact_chunks (
      project_id, chunk_id, file_path, file_hash, chunk_index, start_line, end_line,
      raw_start, raw_end, content, display_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGramStmt = db.prepare(
    'INSERT OR IGNORE INTO exact_grams(project_id, gram, chunk_id) VALUES (?, ?, ?)',
  );

  const transaction = db.transaction((items: ExactIndexChunkInput[]) => {
    for (const item of items) {
      insertChunkStmt.run(
        projectId,
        item.chunkId,
        item.filePath,
        item.fileHash,
        item.chunkIndex,
        item.startLine,
        item.endLine,
        item.rawStart,
        item.rawEnd,
        item.content,
        item.displayCode,
      );

      for (const gram of makeChunkTrigrams(item)) {
        insertGramStmt.run(projectId, gram, item.chunkId);
      }
    }
  });
  transaction(chunks);
}

export function searchExactIndex(
  db: Database.Database,
  projectId: string,
  technicalTerms: string[],
  config: ExactSearchConfig = {},
): ExactSearchResult {
  const startedAt = Date.now();
  const maxTerms = config.exactMaxTerms ?? EXACT_MAX_TERMS;
  const minTermLength = config.exactMinTermLength ?? EXACT_MIN_TERM_LENGTH;
  const maxCandidatesPerTerm = config.exactMaxCandidatesPerTerm ?? EXACT_MAX_CANDIDATES_PER_TERM;
  const maxHits = config.exactMaxHits ?? EXACT_MAX_HITS;
  const { terms, skippedTechnicalTerms } = normalizeExactTechnicalTerms(
    technicalTerms,
    maxTerms,
    minTermLength,
  );

  const hitTerms = new Set<string>();
  const hitsByChunk = new Map<string, ExactSearchHit>();
  let exactScanChunkCount = 0;
  let exactHitsTruncated = false;

  for (const term of terms) {
    if (hitsByChunk.size >= maxHits) {
      exactHitsTruncated = true;
      break;
    }

    const candidates = term.length >= 3
      ? findCandidatesByGrams(db, projectId, term, maxCandidatesPerTerm)
      : scanCandidates(db, projectId, term, maxCandidatesPerTerm);

    if (candidates.length >= maxCandidatesPerTerm) {
      exactHitsTruncated = true;
    }

    exactScanChunkCount += candidates.length;

    for (const row of candidates) {
      if (!getSearchableContent(row).includes(term)) continue;
      hitTerms.add(term);
      const existing = hitsByChunk.get(row.chunk_id);
      if (existing) {
        existing.matchedTerms.push(term);
      } else {
        hitsByChunk.set(row.chunk_id, {
          chunk: rowToChunkRecord(row),
          matchedTerms: [term],
        });
      }

      if (hitsByChunk.size >= maxHits) {
        exactHitsTruncated = true;
        break;
      }
    }
  }

  return {
    terms,
    skippedTechnicalTerms,
    hits: Array.from(hitsByChunk.values()),
    missingExactTechnicalTerms: terms.filter((term) => !hitTerms.has(term)),
    exactScanChunkCount,
    exactScanElapsedMs: Date.now() - startedAt,
    exactHitsTruncated,
    exactSearchSource: ['exact_chunks'],
  };
}

export function makeTrigrams(text: string): string[] {
  const grams = new Set<string>();
  for (let i = 0; i <= text.length - 3; i++) {
    grams.add(text.slice(i, i + 3));
  }
  return Array.from(grams);
}


function makeChunkTrigrams(chunk: Pick<ExactIndexChunkInput, 'content' | 'displayCode'>): string[] {
  return Array.from(new Set([...makeTrigrams(chunk.content), ...makeTrigrams(chunk.displayCode)]));
}

function findCandidatesByGrams(
  db: Database.Database,
  projectId: string,
  term: string,
  limit: number,
): ExactChunkRow[] {
  const grams = makeTrigrams(term);
  if (grams.length === 0) return [];
  const placeholders = grams.map(() => '?').join(', ');
  const ids = db.prepare(`
    SELECT chunk_id
    FROM exact_grams
    WHERE project_id = ? AND gram IN (${placeholders})
    GROUP BY chunk_id
    HAVING COUNT(DISTINCT gram) = ?
    LIMIT ?
  `).all(projectId, ...grams, grams.length, limit) as Array<{ chunk_id: string }>;
  return getExactChunksByIds(db, projectId, ids.map((row) => row.chunk_id));
}

function scanCandidates(
  db: Database.Database,
  projectId: string,
  term: string,
  limit: number,
): ExactChunkRow[] {
  return db.prepare(`
    SELECT * FROM exact_chunks
    WHERE project_id = ? AND (instr(content, ?) > 0 OR instr(display_code, ?) > 0)
    LIMIT ?
  `).all(projectId, term, term, limit) as ExactChunkRow[];
}

function getExactChunksByIds(
  db: Database.Database,
  projectId: string,
  chunkIds: string[],
): ExactChunkRow[] {
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM exact_chunks
    WHERE project_id = ? AND chunk_id IN (${placeholders})
  `).all(projectId, ...chunkIds) as ExactChunkRow[];
}



function getSearchableContent(chunk: Pick<ExactChunkRow, 'content' | 'display_code'>): string {
  return `${chunk.content}\n${chunk.display_code}`;
}
function rowToChunkRecord(row: ExactChunkRow): ChunkRecord {
  return {
    chunk_id: row.chunk_id,
    file_path: row.file_path,
    file_hash: row.file_hash,
    chunk_index: row.chunk_index,
    vector: [],
    display_code: row.display_code,
    vector_text: row.content,
    language: '',
    breadcrumb: '',
    start_index: row.raw_start,
    end_index: row.raw_end,
    raw_start: row.raw_start,
    raw_end: row.raw_end,
    vec_start: row.raw_start,
    vec_end: row.raw_end,
  };
}
