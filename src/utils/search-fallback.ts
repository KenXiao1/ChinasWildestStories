const SPACE_RE = /\s+/g;
const HAN_CHAR_RE = /\p{Script=Han}/u;
const TOKEN_RE = /[\p{L}\p{N}\p{Script=Han}]+/gu;

export type SearchHit = {
  url: string;
  title: string;
  excerpt?: string;
  content?: string;
};

export type PassageResult = {
  hits: SearchHit[];
  totalMatches: number;
  chaptersWithMatches: number;
};

export function isSingleHanQuery(keyword: string): boolean {
  const normalized = (keyword ?? "").trim();
  const chars = Array.from(normalized);
  return chars.length === 1 && HAN_CHAR_RE.test(chars[0]);
}

export function createKeywordExcerpt(content: string, keyword: string, radius = 28): string {
  const text = (content ?? "").replace(SPACE_RE, " ").trim();
  if (!text || !keyword) {
    return "";
  }

  const idx = text.indexOf(keyword);
  if (idx < 0) {
    return "";
  }

  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + keyword.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";

  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export function mergeSearchHitsForSingleHanQuery(
  keyword: string,
  primaryHits: SearchHit[],
  allDocs: SearchHit[],
  limit = 30
): SearchHit[] {
  if (!isSingleHanQuery(keyword)) {
    return primaryHits;
  }

  const merged = [...primaryHits];
  const seen = new Set(merged.map((item) => item.url));

  for (const doc of allDocs) {
    if (merged.length >= limit) {
      break;
    }

    if (seen.has(doc.url)) {
      continue;
    }

    const title = doc.title ?? "";
    const content = doc.content ?? "";
    if (!title.includes(keyword) && !content.includes(keyword)) {
      continue;
    }

    const excerpt = doc.excerpt || createKeywordExcerpt(content, keyword) || "仅标题命中";
    merged.push({
      ...doc,
      excerpt
    });
    seen.add(doc.url);
  }

  return merged.slice(0, limit);
}

function extractSearchTerms(keyword: string): string[] {
  const normalized = (keyword ?? "").trim();
  if (!normalized) {
    return [];
  }

  const tokens = normalized.match(TOKEN_RE) ?? [];
  if (tokens.length > 0) {
    return [...new Set(tokens)];
  }

  return [normalized];
}

function createKeywordExcerptAt(
  content: string,
  index: number,
  keywordLength: number,
  radius = 28
): string {
  const text = (content ?? "").replace(SPACE_RE, " ").trim();
  if (!text) {
    return "";
  }

  const safeLength = Math.max(1, keywordLength);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + safeLength + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export function buildPassageResults(keyword: string, chapterHits: SearchHit[], limit = 30): PassageResult {
  const terms = extractSearchTerms(keyword);
  const passageHits: SearchHit[] = [];
  let totalMatches = 0;
  let chaptersWithMatches = 0;

  for (const chapter of chapterHits) {
    if (passageHits.length >= limit) {
      break;
    }

    const content = (chapter.content ?? "").replace(SPACE_RE, " ").trim();
    if (!content || terms.length === 0) {
      continue;
    }

    const matches: Array<{ index: number; term: string }> = [];
    for (const term of terms) {
      if (!term) {
        continue;
      }

      let from = 0;
      while (from < content.length) {
        const idx = content.indexOf(term, from);
        if (idx < 0) {
          break;
        }

        matches.push({ index: idx, term });
        from = idx + Math.max(1, term.length);
      }
    }

    matches.sort((a, b) => a.index - b.index || b.term.length - a.term.length);
    const uniqueMatches = matches.filter(
      (match, i) =>
        i === 0 ||
        match.index !== matches[i - 1].index ||
        match.term.length !== matches[i - 1].term.length
    );

    if (uniqueMatches.length === 0) {
      continue;
    }

    chaptersWithMatches += 1;
    totalMatches += uniqueMatches.length;

    for (let i = 0; i < uniqueMatches.length; i += 1) {
      if (passageHits.length >= limit) {
        break;
      }

      const match = uniqueMatches[i];
      const excerpt =
        createKeywordExcerptAt(content, match.index, match.term.length) ||
        chapter.excerpt ||
        "仅标题命中";
      passageHits.push({
        url: chapter.url,
        title: `${chapter.title} · 第 ${i + 1} 处`,
        excerpt,
        content: chapter.content
      });
    }
  }

  if (passageHits.length === 0) {
    return {
      hits: chapterHits.slice(0, limit),
      totalMatches: 0,
      chaptersWithMatches: 0
    };
  }

  return {
    hits: passageHits,
    totalMatches,
    chaptersWithMatches
  };
}
