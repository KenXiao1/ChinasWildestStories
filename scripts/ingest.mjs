import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  cp,
  copyFile,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  extractMediaRefsFromContent,
  markSubtitlesInMarkdown,
  mergeFullUpdateManifest,
  parseChapterIdFromFilename,
  resolveMediaRelativePathFromRef,
  splitFullMarkdownIntoChapters,
  upsertChapterManifest
} from "./ingest-lib.mjs";

function parseArgs(argv) {
  const args = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = value;
    i += 1;
  }
  if (!args.file && positionals.length > 0) {
    args.file = positionals[0];
  }
  return args;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizePathForManifest(filePath) {
  return filePath.replace(/\\/g, "/");
}

function ensureDocx(filePath) {
  if (extname(filePath).toLowerCase() !== ".docx") {
    fail(`Input must be a .docx file: ${filePath}`);
  }
}

function runPandoc(docxPath, outputDir) {
  const markdownPath = join(outputDir, "document.md");
  const result = spawnSync(
    "pandoc",
    [docxPath, "-t", "gfm", "--extract-media", outputDir, "-o", markdownPath],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    fail(
      [
        "Pandoc conversion failed.",
        result.stderr?.trim() || "",
        result.stdout?.trim() || ""
      ]
        .join("\n")
        .trim()
    );
  }

  return markdownPath;
}

function extractSubtitlesFromDocx(docxPath, tempDir) {
  const unzipDir = join(tempDir, "docx_xml");
  const res = spawnSync("unzip", ["-o", docxPath, "word/document.xml", "-d", unzipDir], { encoding: "utf8" });
  if (res.status !== 0) return new Set();
  let xml;
  try { xml = readFileSync(join(unzipDir, "word", "document.xml"), "utf-8"); } catch { return new Set(); }
  const bodyColor = "36363D";
  const chapterRe = /^(开幕|第[一二三四五六七八九十百零两\d]+幕)/u;
  const subtitles = new Set();
  let afterFirstChapter = false;
  for (const para of xml.split(/(?=<w:p[ >])/)) {
    const text = para.replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim();
    if (!text) continue;
    if (chapterRe.test(text)) { afterFirstChapter = true; continue; }
    if (!afterFirstChapter || text.length > 30) continue;
    const colors = [...para.matchAll(/w:color w:val="([^"]+)"/g)].map(m => m[1]);
    const nonBody = [...new Set(colors)].filter(c => c !== bodyColor);
    if (nonBody.length > 0) subtitles.add(text);
  }
  return subtitles;
}

async function readManifest(manifestPath, bookId) {
  try {
    const payload = JSON.parse(await readFile(manifestPath, "utf8"));
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload?.book_id === bookId && Array.isArray(payload.chapters)) {
      return payload.chapters;
    }
    return [];
  } catch {
    return [];
  }
}

async function writeManifest(manifestPath, bookId, entries, updatedAt) {
  await mkdir(dirname(manifestPath), { recursive: true });
  const payload = {
    book_id: bookId,
    updated_at: updatedAt,
    chapters: entries
  };
  await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildFrontmatter(entry) {
  const sourceFile = JSON.stringify(entry.source_file);
  const title = JSON.stringify(entry.title);
  const updatedAt = JSON.stringify(entry.updated_at);
  return [
    "---",
    `book_id: ${entry.book_id}`,
    `chapter_id: ${entry.chapter_id}`,
    `order: ${entry.order}`,
    `title: ${title}`,
    `source_type: ${entry.source_type}`,
    `source_file: ${sourceFile}`,
    `content_hash: ${entry.content_hash}`,
    `updated_at: ${updatedAt}`,
    `status: ${entry.status}`,
    "---",
    ""
  ].join("\n");
}

async function rewriteMediaLinks(content, {
  mediaRoot,
  bookId,
  chapterId,
  projectRoot
}) {
  if (content.includes("data:image")) {
    fail(`Found inline base64 images in chapter ${chapterId}. Inline images are not allowed.`);
  }

  const destDir = join(projectRoot, "public", "images", bookId, chapterId);
  await mkdir(destDir, { recursive: true });

  const copied = new Map();
  async function copyForRef(originalRef) {
    const localPath = resolveMediaRelativePathFromRef(originalRef);
    if (!localPath) {
      return null;
    }
    const localSegments = localPath.split("/");
    const sourcePath = join(mediaRoot, "media", ...localSegments);
    const destPath = join(destDir, ...localSegments);

    try {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);
    } catch {
      fail(`Missing extracted media file: ${sourcePath}`);
    }

    const webPath = `/images/${bookId}/${chapterId}/${localSegments.join("/")}`;
    copied.set(originalRef, webPath);
    return webPath;
  }

  const refs = extractMediaRefsFromContent(content);
  for (const ref of refs) {
    if (!copied.has(ref)) {
      await copyForRef(ref);
    }
  }

  let rewritten = content;
  for (const [oldRef, newRef] of copied.entries()) {
    rewritten = rewritten
      .replaceAll(`src="${oldRef}"`, `src="${newRef}"`)
      .replaceAll(`src='${oldRef}'`, `src='${newRef}'`)
      .replaceAll(`(${oldRef})`, `(${newRef})`);
  }
  return rewritten;
}

async function writeChapterFile(chaptersDir, entry, content) {
  await mkdir(chaptersDir, { recursive: true });
  const filePath = join(chaptersDir, `${entry.chapter_id}.md`);
  const payload = `${buildFrontmatter(entry)}${content.trim()}\n`;
  await writeFile(filePath, payload, "utf8");
}

async function removeStaleChapterFiles(chaptersDir, activeChapterIds) {
  try {
    const files = await readdir(chaptersDir);
    const allowed = new Set(activeChapterIds.map((id) => `${id}.md`));
    for (const file of files) {
      if (!file.endsWith(".md")) {
        continue;
      }
      if (!allowed.has(file)) {
        await unlink(join(chaptersDir, file));
      }
    }
  } catch {
    // noop
  }
}

async function removeStaleMediaDirs(projectRoot, bookId, activeChapterIds) {
  const mediaBookDir = join(projectRoot, "public", "images", bookId);
  try {
    const entries = await readdir(mediaBookDir, { withFileTypes: true });
    const activeSet = new Set(activeChapterIds);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!activeSet.has(entry.name)) {
        rmSync(join(mediaBookDir, entry.name), { recursive: true, force: true });
      }
    }
  } catch {
    // noop
  }
}

async function mirrorBookImagesForWorkspacePreview(projectRoot, bookId) {
  const sourceBookDir = join(projectRoot, "public", "images", bookId);
  const targetBookDir = join(projectRoot, "images", bookId);
  rmSync(targetBookDir, { recursive: true, force: true });

  try {
    await cp(sourceBookDir, targetBookDir, { recursive: true });
  } catch {
    // noop
  }
}

async function writeBookMetaFile(projectRoot, bookId, title) {
  const booksDir = join(projectRoot, "src", "content", "books");
  await mkdir(booksDir, { recursive: true });
  const bookMetaPath = join(booksDir, `${bookId}.md`);
  try {
    await unlink(join(booksDir, `${bookId}.json`));
  } catch {
    // noop
  }
  const payload = [
    "---",
    `book_id: ${bookId}`,
    `title: ${JSON.stringify(title)}`,
    `updated_at: ${JSON.stringify(new Date().toISOString())}`,
    "---",
    ""
  ].join("\n");
  await writeFile(bookMetaPath, payload, "utf8");
}

function defaultBookTitle(bookId) {
  if (bookId === "book-1") {
    return "全中国最激烈故事 第一部";
  }
  return `全中国最激烈故事 ${bookId}`;
}

async function ingestFull({
  bookId,
  inputFile,
  markdownPath,
  projectRoot,
  manifestPath,
  updatedAt,
  reset,
  subtitles
}) {
  const rawMarkdown = markSubtitlesInMarkdown(await readFile(markdownPath, "utf8"), subtitles);
  const splitChapters = splitFullMarkdownIntoChapters(rawMarkdown);
  if (splitChapters.length === 0) {
    fail("No chapters were detected in full ingestion mode.");
  }

  const existingEntries = reset ? [] : await readManifest(manifestPath, bookId);
  const existingById = new Map(existingEntries.map((entry) => [entry.chapter_id, entry]));
  const incomingChapters = splitChapters.map((chapter) => ({
    title: chapter.title,
    order: chapter.order,
    content_hash: hashContent(chapter.content)
  }));

  const mergedEntries = mergeFullUpdateManifest({
    bookId,
    existingEntries,
    incomingChapters,
    sourceFile: normalizePathForManifest(relative(projectRoot, inputFile)),
    updatedAt
  });

  const chaptersDir = join(projectRoot, "src", "content", "chapters", bookId);
  await mkdir(chaptersDir, { recursive: true });
  const byOrder = new Map(splitChapters.map((chapter) => [chapter.order, chapter]));

  const mediaRoot = join(markdownPath, "..");
  for (const entry of mergedEntries) {
    if (entry.status !== "active") {
      const archivedPath = join(chaptersDir, `${entry.chapter_id}.md`);
      try {
        await unlink(archivedPath);
      } catch {
        // noop
      }
      continue;
    }

    const chapter = byOrder.get(entry.order);
    if (!chapter) {
      continue;
    }

    const previous = existingById.get(entry.chapter_id);
    if (
      previous &&
      previous.content_hash === entry.content_hash &&
      previous.title === entry.title &&
      previous.source_type === entry.source_type &&
      previous.source_file === entry.source_file
    ) {
      continue;
    }

    const rewritten = await rewriteMediaLinks(chapter.content, {
      mediaRoot,
      bookId,
      chapterId: entry.chapter_id,
      projectRoot
    });
    await writeChapterFile(chaptersDir, entry, rewritten);
  }

  await removeStaleChapterFiles(
    chaptersDir,
    mergedEntries.filter((entry) => entry.status === "active").map((entry) => entry.chapter_id)
  );
  await removeStaleMediaDirs(
    projectRoot,
    bookId,
    mergedEntries.filter((entry) => entry.status === "active").map((entry) => entry.chapter_id)
  );
  await mirrorBookImagesForWorkspacePreview(projectRoot, bookId);

  await writeManifest(manifestPath, bookId, mergedEntries, updatedAt);
  await writeBookMetaFile(projectRoot, bookId, defaultBookTitle(bookId));
}

async function ingestChapter({
  bookId,
  inputFile,
  markdownPath,
  projectRoot,
  manifestPath,
  updatedAt,
  chapterId,
  order,
  subtitles
}) {
  const rawMarkdown = markSubtitlesInMarkdown(await readFile(markdownPath, "utf8"), subtitles);
  const chunks = splitFullMarkdownIntoChapters(rawMarkdown);
  const selected = chunks[0] ?? {
    title: basename(inputFile, extname(inputFile)),
    content: rawMarkdown
  };

  const existingEntries = await readManifest(manifestPath, bookId);
  const mergedEntries = upsertChapterManifest({
    bookId,
    existingEntries,
    chapterId,
    title: selected.title,
    contentHash: hashContent(selected.content),
    sourceFile: normalizePathForManifest(relative(projectRoot, inputFile)),
    updatedAt,
    order
  });

  const target = mergedEntries
    .filter((entry) => entry.updated_at === updatedAt && entry.source_file === normalizePathForManifest(relative(projectRoot, inputFile)))
    .sort((a, b) => b.order - a.order)[0];
  if (!target) {
    fail("Failed to resolve target chapter entry after upsert.");
  }

  const rewritten = await rewriteMediaLinks(selected.content, {
    mediaRoot: join(markdownPath, ".."),
    bookId,
    chapterId: target.chapter_id,
    projectRoot
  });
  const chaptersDir = join(projectRoot, "src", "content", "chapters", bookId);
  await writeChapterFile(chaptersDir, target, rewritten);
  await mirrorBookImagesForWorkspacePreview(projectRoot, bookId);
  await writeManifest(manifestPath, bookId, mergedEntries, updatedAt);
  await writeBookMetaFile(projectRoot, bookId, defaultBookTitle(bookId));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode;
  const reset = args.reset === "true";
  const bookId = args.book ?? "book-1";
  const inputRaw = args.file;

  if (!mode || (mode !== "full" && mode !== "chapter")) {
    fail("Missing --mode full|chapter");
  }
  if (!inputRaw) {
    fail("Missing --file path-to-docx");
  }

  const projectRoot = resolve(".");
  const inputFile = resolve(inputRaw);
  ensureDocx(inputFile);

  const tempRoot = mkdtempSync(join(tmpdir(), "cws-ingest-"));
  const markdownPath = runPandoc(inputFile, tempRoot);
  const subtitles = extractSubtitlesFromDocx(inputFile, tempRoot);
  const manifestPath = join(projectRoot, "content", "manifests", `${bookId}.json`);
  const updatedAt = new Date().toISOString();

  try {
    if (mode === "full") {
      await ingestFull({
        bookId,
        inputFile,
        markdownPath,
        projectRoot,
        manifestPath,
        updatedAt,
        reset,
        subtitles
      });
    } else {
      const parsedChapterId = parseChapterIdFromFilename(basename(inputFile));
      const chapterId = args["chapter-id"] ?? parsedChapterId;
      const order = args.order ? Number.parseInt(args.order, 10) : undefined;

      await ingestChapter({
        bookId,
        inputFile,
        markdownPath,
        projectRoot,
        manifestPath,
        updatedAt,
        chapterId,
        order,
        subtitles
      });
    }

    console.log(`Ingestion completed: mode=${mode}, book=${bookId}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
