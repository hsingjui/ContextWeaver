/**
 * Bounded, explainable query decomposition for compound coding questions.
 * The full query is always retained by SearchService; this function returns facets only.
 */
export function decomposeQuery(query: string, maxFacets = 3): string[] {
  if (maxFacets <= 0) return [];
  // Preserve line boundaries until sentence splitting; only normalize horizontal whitespace.
  const normalized = query
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .trim();
  const normalizedFlat = normalized.replace(/\s+/g, ' ').trim();
  if (normalizedFlat.length < 12) return [];

  const candidates: string[] = [];
  const push = (value: string): void => {
    const facet = value
      .replace(/^[,，、:：\s]+|[,，、:：\s]+$/gu, '')
      .replace(/^(?:然后|接着|随后|最后|再|并最终|并且|以及)\s*/u, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (facet.length < 5 || facet === normalizedFlat || candidates.includes(facet)) return;
    candidates.push(facet.slice(0, 240));
  };

  // Sentence/question boundaries also separate an optional trailing list of technical terms.
  const sentences = normalized
    .split(/[?？。；;\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    // Temporal/stage connectors are strong signals for multi-step code flows.
    const stages = sentence
      .split(/(?:，\s*)?(?:然后|接着|随后|并最终|最后|再)(?:\s*)/u)
      .map((part) => part.trim())
      .filter(Boolean);
    if (stages.length >= 2) {
      for (const stage of stages) push(stage);
      continue;
    }

    // "when/after ..., then ..." naturally separates condition/setup from behavior.
    const conditional = sentence
      .split(/(?:时|后)，/u)
      .map((part) => part.trim())
      .filter(Boolean);
    if (conditional.length >= 2) {
      for (const part of conditional) push(part);
      continue;
    }

    // Chinese enumeration is useful for long pipeline questions, but only when it has
    // several items so ordinary two-term feature queries are not over-decomposed.
    const enumParts = sentence
      .split(/、/u)
      .map((part) => part.trim())
      .filter(Boolean);
    if (enumParts.length >= 3) {
      for (const part of enumParts) push(part);
      continue;
    }

    if (sentences.length >= 2) push(sentence);
  }

  return candidates.slice(0, maxFacets);
}
