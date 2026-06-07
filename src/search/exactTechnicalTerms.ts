export const EXACT_MIN_TERM_LENGTH = 2;
export const EXACT_MAX_TERMS = 20;
export const EXACT_MAX_HITS = 200;
export const EXACT_MAX_CANDIDATES_PER_TERM = 50;
export const EXACT_RESERVED_SEEDS = 10;

export type SearchableChunk = {
  file_path: string;
  chunk_index: number;
  display_code?: string;
  raw_code?: string;
  content?: string;
};

export interface ExactTechnicalTermMatch<T extends SearchableChunk> {
  chunk: T;
  matchedTerms: string[];
}

export interface ExactTechnicalTermResult<T extends SearchableChunk> {
  terms: string[];
  skippedTechnicalTerms: string[];
  matches: ExactTechnicalTermMatch<T>[];
  missingExactTechnicalTerms: string[];
  exactScanChunkCount: number;
  exactScanElapsedMs: number;
  exactHitsTruncated: boolean;
  exactSearchSource: string[];
}

export function collectExactTechnicalTermMatches<T extends SearchableChunk>(
  chunks: T[],
  technicalTerms: string[],
): ExactTechnicalTermResult<T> {
  const startedAt = Date.now();
  const { terms, skippedTechnicalTerms } = normalizeExactTechnicalTerms(technicalTerms);
  const matches: ExactTechnicalTermMatch<T>[] = [];
  const hitTerms = new Set<string>();
  const hitsPerTerm = new Map<string, number>();
  const exactSearchSource = new Set<string>();
  let exactScanChunkCount = 0;
  let totalHits = 0;
  let exactHitsTruncated = false;

  if (terms.length === 0) {
    return finish();
  }

  for (const chunk of chunks) {
    exactScanChunkCount++;
    const fields = getExactSearchFields(chunk);
    const matchedTerms: string[] = [];

    for (const term of terms) {
      if ((hitsPerTerm.get(term) ?? 0) >= EXACT_MAX_CANDIDATES_PER_TERM) {
        exactHitsTruncated = true;
        continue;
      }

      const hitField = fields.find((field) => field.text.includes(term));
      if (!hitField) continue;

      if (totalHits >= EXACT_MAX_HITS) {
        exactHitsTruncated = true;
        break;
      }

      matchedTerms.push(term);
      hitTerms.add(term);
      exactSearchSource.add(hitField.source);
      hitsPerTerm.set(term, (hitsPerTerm.get(term) ?? 0) + 1);
      totalHits++;
    }

    if (matchedTerms.length > 0) {
      matches.push({ chunk, matchedTerms });
    }

    if (exactHitsTruncated && totalHits >= EXACT_MAX_HITS) {
      break;
    }
  }

  return finish();

  function finish(): ExactTechnicalTermResult<T> {
    return {
      terms,
      skippedTechnicalTerms,
      matches,
      missingExactTechnicalTerms: terms.filter((term) => !hitTerms.has(term)),
      exactScanChunkCount,
      exactScanElapsedMs: Date.now() - startedAt,
      exactHitsTruncated,
      exactSearchSource: Array.from(exactSearchSource),
    };
  }
}

export function normalizeExactTechnicalTerms(
  technicalTerms: string[],
  maxTerms = EXACT_MAX_TERMS,
  minTermLength = EXACT_MIN_TERM_LENGTH,
): {
  terms: string[];
  skippedTechnicalTerms: string[];
} {
  const seen = new Set<string>();
  const terms: string[] = [];
  const skippedTechnicalTerms: string[] = [];

  for (const rawTerm of technicalTerms) {
    const term = rawTerm.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);

    if (term.length < minTermLength) {
      skippedTechnicalTerms.push(term);
      continue;
    }

    if (terms.length >= maxTerms) {
      skippedTechnicalTerms.push(term);
      continue;
    }

    terms.push(term);
  }

  return { terms, skippedTechnicalTerms };
}

function getExactSearchFields(chunk: SearchableChunk): Array<{ source: string; text: string }> {
  const fields: Array<{ source: string; text: string }> = [];
  if (chunk.raw_code) fields.push({ source: 'raw_code', text: chunk.raw_code });
  if (chunk.display_code) fields.push({ source: 'display_code', text: chunk.display_code });
  if (chunk.content) fields.push({ source: 'content', text: chunk.content });
  return fields;
}
