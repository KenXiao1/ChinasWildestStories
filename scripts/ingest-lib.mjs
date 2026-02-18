function getBookPrefix(bookId) {
  const match = /book-(\d+)/i.exec(bookId ?? "");
  if (match) {
    return `b${match[1]}`;
  }
  const compact = String(bookId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return compact || "b1";
}

function toChapterNumber(chapterId, prefix) {
  const pattern = new RegExp(`^${prefix}-c(\\d+)$`, "i");
  const match = pattern.exec(chapterId ?? "");
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function normalizeTitle(rawTitle) {
  const stripped = String(rawTitle ?? "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/[*_`~]/g, "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  const chapterMatch = /^(开幕|第[一二三四五六七八九十百零两\d]+幕)\s*[：:.．、 ]+\s*(.+)$/u.exec(stripped);
  if (chapterMatch) {
    const cleanTail = chapterMatch[2].trim().replace(/\s+\d{1,4}$/u, "");
    return `${chapterMatch[1]}：${cleanTail}`;
  }
  return stripped;
}

function detectChapterTitle(line) {
  const normalized = normalizeTitle(line);
  if (!normalized) {
    return null;
  }
  if (/^(开幕|第[一二三四五六七八九十百零两\d]+幕)[:：]/u.test(normalized)) {
    return normalized;
  }
  return null;
}

function compareByOrder(a, b) {
  return a.order - b.order;
}

function buildManifestEntry({
  bookId,
  chapterId,
  order,
  title,
  sourceType,
  sourceFile,
  contentHash,
  updatedAt,
  status
}) {
  return {
    book_id: bookId,
    chapter_id: chapterId,
    slug: chapterId,
    order,
    title,
    source_type: sourceType,
    source_file: sourceFile,
    content_hash: contentHash,
    updated_at: updatedAt,
    status
  };
}

function getTakenChapterIds(entries) {
  return new Set(entries.map((entry) => entry.chapter_id));
}

function allocateChapterId(bookId, takenIds) {
  let candidate = nextChapterId(bookId, Array.from(takenIds));
  while (takenIds.has(candidate)) {
    const prefix = getBookPrefix(bookId);
    const value = toChapterNumber(candidate, prefix) ?? 0;
    candidate = `${prefix}-c${String(value + 1).padStart(3, "0")}`;
  }
  takenIds.add(candidate);
  return candidate;
}

export function parseChapterIdFromFilename(filename) {
  const match = /(b\d+-c\d{3})/i.exec(String(filename ?? ""));
  return match ? match[1].toLowerCase() : null;
}

export function nextChapterId(bookId, existingIds) {
  const prefix = getBookPrefix(bookId);
  const numbers = (existingIds ?? [])
    .map((id) => toChapterNumber(id, prefix))
    .filter((value) => value !== null);
  const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
  return `${prefix}-c${String(maxNumber + 1).padStart(3, "0")}`;
}

export function splitFullMarkdownIntoChapters(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const chapters = [];
  const leadingLines = [];
  let current = null;

  for (const line of lines) {
    const detectedTitle = detectChapterTitle(line);
    if (detectedTitle) {
      if (current) {
        chapters.push(current);
      }
      current = {
        title: detectedTitle,
        order: chapters.length + 1,
        contentLines: [`# ${detectedTitle}`]
      };
      continue;
    }

    if (current) {
      current.contentLines.push(line);
    } else {
      leadingLines.push(line);
    }
  }

  if (current) {
    chapters.push(current);
  }

  if (chapters.length === 0) {
    const fallback = String(markdown ?? "").trim();
    if (!fallback) {
      return [];
    }
    return [
      {
        title: "第一章",
        order: 1,
        content: `# 第一章\n\n${fallback}`
      }
    ];
  }

  const normalized = chapters.map((chapter) => ({
    title: chapter.title,
    order: chapter.order,
    content: chapter.contentLines.join("\n").trim()
  }));

  const leadingContent = leadingLines.join("\n").trim();

  // The source DOCX includes a table-of-contents block where each line looks like a chapter title.
  // Those entries are short and should not become real chapter pages.
  const firstSubstantialIndex = normalized.findIndex((chapter) => chapter.content.length >= 500);
  const droppedBodies = firstSubstantialIndex > 0
    ? normalized
      .slice(0, firstSubstantialIndex)
      .map((chapter) => {
        const [, ...bodyLines] = String(chapter.content ?? "").split(/\r?\n/);
        return bodyLines.join("\n").trim();
      })
      .filter((value) => value.length > 0)
    : [];
  const filtered = firstSubstantialIndex > 0
    ? normalized.slice(firstSubstantialIndex).map((chapter, index) => ({
      ...chapter,
      order: index + 1
    }))
    : normalized;

  if (filtered.length === 0) {
    return filtered;
  }

  const prefixContent = [leadingContent, ...droppedBodies].filter((value) => value.length > 0).join("\n\n");
  if (!prefixContent) {
    return filtered;
  }

  const [first, ...rest] = filtered;
  const [headingLine, ...bodyLines] = String(first.content ?? "").split(/\r?\n/);
  const body = bodyLines.join("\n").trim();
  return [
    {
      ...first,
      content: `${headingLine}\n\n${prefixContent}${body ? `\n\n${body}` : ""}`
    },
    ...rest
  ];
}

export function mergeFullUpdateManifest({
  bookId,
  existingEntries,
  incomingChapters,
  sourceFile,
  updatedAt
}) {
  const existing = [...(existingEntries ?? [])].sort(compareByOrder);
  const activeExisting = existing.filter((entry) => entry.status !== "archived");
  const takenIds = getTakenChapterIds(existing);
  const nextEntries = [];

  for (let index = 0; index < incomingChapters.length; index += 1) {
    const chapter = incomingChapters[index];
    const existingEntry = activeExisting[index];
    const chapterId = existingEntry?.chapter_id ?? allocateChapterId(bookId, takenIds);
    nextEntries.push(
      buildManifestEntry({
        bookId,
        chapterId,
        order: index + 1,
        title: chapter.title,
        sourceType: "full",
        sourceFile,
        contentHash: chapter.content_hash,
        updatedAt,
        status: "active"
      })
    );
  }

  if (activeExisting.length > incomingChapters.length) {
    for (let index = incomingChapters.length; index < activeExisting.length; index += 1) {
      const archived = activeExisting[index];
      nextEntries.push(
        buildManifestEntry({
          bookId,
          chapterId: archived.chapter_id,
          order: archived.order,
          title: archived.title,
          sourceType: archived.source_type,
          sourceFile: archived.source_file,
          contentHash: archived.content_hash,
          updatedAt,
          status: "archived"
        })
      );
    }
  }

  return nextEntries.sort(compareByOrder);
}

function normalizeOrders(entries) {
  const active = entries.filter((entry) => entry.status !== "archived").sort(compareByOrder);
  const archived = entries.filter((entry) => entry.status === "archived").sort(compareByOrder);
  active.forEach((entry, index) => {
    entry.order = index + 1;
  });
  return [...active, ...archived];
}

function sanitizeMediaRelativePath(pathLike) {
  const noQuery = String(pathLike ?? "").split(/[?#]/, 1)[0].replace(/^\/+/, "");
  const segments = noQuery
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

function extractMarkdownDestination(rawDestination) {
  const trimmed = String(rawDestination ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.split(/\s+/, 1)[0];
}

export function resolveMediaRelativePathFromRef(reference) {
  const raw = String(reference ?? "").trim();
  if (!raw) {
    return null;
  }
  if (/^data:/i.test(raw)) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^file:\/\//i.test(raw)) {
    return null;
  }

  let normalized = raw.replace(/^file:\/+/, "");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Leave ref unchanged when percent-decoding fails.
  }
  normalized = normalized.replace(/\\/g, "/");

  const directMatch = /^media\/(.+)$/i.exec(normalized);
  if (directMatch) {
    return sanitizeMediaRelativePath(directMatch[1]);
  }

  const marker = "/media/";
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const mediaPath = normalized.slice(markerIndex + marker.length);
  return sanitizeMediaRelativePath(mediaPath);
}

export function extractMediaRefsFromContent(content) {
  const text = String(content ?? "");
  const refs = [];
  const seen = new Set();

  const pushIfMediaRef = (rawRef) => {
    const ref = String(rawRef ?? "").trim();
    if (!ref || seen.has(ref)) {
      return;
    }
    if (resolveMediaRelativePathFromRef(ref) === null) {
      return;
    }
    seen.add(ref);
    refs.push(ref);
  };

  for (const match of text.matchAll(/src=(?:"([^"]+)"|'([^']+)')/g)) {
    pushIfMediaRef(match[1] ?? match[2]);
  }

  for (const match of text.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
    pushIfMediaRef(extractMarkdownDestination(match[1]));
  }

  return refs;
}

export function upsertChapterManifest({
  bookId,
  existingEntries,
  chapterId,
  title,
  contentHash,
  sourceFile,
  updatedAt,
  order
}) {
  const entries = [...(existingEntries ?? [])].map((entry) => ({ ...entry }));
  const active = entries.filter((entry) => entry.status !== "archived");
  const takenIds = getTakenChapterIds(entries);
  const targetOrder = Number.isInteger(order) ? order : active.length + 1;

  const existingIndex = chapterId
    ? entries.findIndex((entry) => entry.chapter_id === chapterId)
    : -1;

  if (existingIndex >= 0) {
    const previous = entries[existingIndex];
    entries[existingIndex] = buildManifestEntry({
      bookId,
      chapterId: previous.chapter_id,
      order: previous.order,
      title,
      sourceType: "chapter",
      sourceFile,
      contentHash,
      updatedAt,
      status: "active"
    });
    return normalizeOrders(entries);
  }

  const resolvedChapterId = chapterId ?? allocateChapterId(bookId, takenIds);

  const activeEntries = entries.filter((entry) => entry.status !== "archived");
  activeEntries.forEach((entry) => {
    if (entry.order >= targetOrder) {
      entry.order += 1;
    }
  });

  activeEntries.push(
    buildManifestEntry({
      bookId,
      chapterId: resolvedChapterId,
      order: targetOrder,
      title,
      sourceType: "chapter",
      sourceFile,
      contentHash,
      updatedAt,
      status: "active"
    })
  );

  const archivedEntries = entries.filter((entry) => entry.status === "archived");
  return normalizeOrders([...activeEntries, ...archivedEntries]);
}

export function markSubtitlesInMarkdown(markdown, subtitleTexts) {
  if (!subtitleTexts || subtitleTexts.size === 0) return markdown;
  const lines = String(markdown).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const plain = trimmed.replace(/<[^>]+>/g, "").replace(/\*+/g, "").trim();
    const plainCompact = plain.replace(/\s+/g, "");
    if (plainCompact && subtitleTexts.has(plainCompact)) {
      const prev = i > 0 ? lines[i - 1].trim() : "";
      const next = i < lines.length - 1 ? lines[i + 1].trim() : "";
      if (prev === "" && next === "") {
        lines[i] = `## ${plain}`;
      }
    }
  }
  return lines.join("\n");
}
