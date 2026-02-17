import { describe, expect, test } from "vitest";
import {
  buildPassageResults,
  createKeywordExcerpt,
  isSingleHanQuery,
  mergeSearchHitsForSingleHanQuery
} from "../src/utils/search-fallback.ts";

describe("isSingleHanQuery", () => {
  test("matches single Han character", () => {
    expect(isSingleHanQuery("李")).toBe(true);
  });

  test("rejects multi-character or non-Han queries", () => {
    expect(isSingleHanQuery("行李")).toBe(false);
    expect(isSingleHanQuery("A")).toBe(false);
    expect(isSingleHanQuery("")).toBe(false);
  });
});

describe("mergeSearchHitsForSingleHanQuery", () => {
  test("adds substring matches from all docs for a single Han character", () => {
    const primaryHits = [
      {
        url: "/book/book-1/chapter/b1-c002/",
        title: "第二幕",
        excerpt: "哎哟李姐",
        content: "哎哟李姐，啥话你这说的！"
      }
    ];

    const allDocs = [
      ...primaryHits,
      {
        url: "/book/book-1/chapter/b1-c004/",
        title: "第四幕",
        excerpt: "",
        content: "我提着行李上车，后背都湿透了。"
      },
      {
        url: "/book/book-1/chapter/b1-c010/",
        title: "第十幕",
        excerpt: "",
        content: "这里没有相关词。"
      }
    ];

    const merged = mergeSearchHitsForSingleHanQuery("李", primaryHits, allDocs, 30);
    expect(merged.map((item) => item.url)).toEqual([
      "/book/book-1/chapter/b1-c002/",
      "/book/book-1/chapter/b1-c004/"
    ]);
    expect(merged[1].excerpt).toContain("行李");
  });

  test("keeps primary hits unchanged for non-single-Han queries", () => {
    const primaryHits = [
      {
        url: "/book/book-1/chapter/b1-c004/",
        title: "第四幕",
        excerpt: "行李太多",
        content: "行李太多"
      }
    ];

    const allDocs = [
      ...primaryHits,
      {
        url: "/book/book-1/chapter/b1-c009/",
        title: "第九幕",
        excerpt: "",
        content: "行李箱放在脚边。"
      }
    ];

    const merged = mergeSearchHitsForSingleHanQuery("行李", primaryHits, allDocs, 30);
    expect(merged).toEqual(primaryHits);
  });
});

describe("createKeywordExcerpt", () => {
  test("creates nearby excerpt around first match", () => {
    const excerpt = createKeywordExcerpt("前文前文前文李子在这里后文后文后文", "李", 4);
    expect(excerpt).toContain("李子");
    expect(excerpt.length).toBeGreaterThan(0);
  });
});

describe("buildPassageResults", () => {
  test("splits chapter hit into multiple passage hits and counts total matches", () => {
    const chapterHits = [
      {
        url: "/book/book-1/chapter/b1-c002/",
        title: "第二幕",
        excerpt: "哎哟李姐",
        content: "哎哟李姐，啥话你这说的！我提着行李上车，另一个行李箱放脚边。"
      },
      {
        url: "/book/book-1/chapter/b1-c004/",
        title: "第四幕",
        excerpt: "没有李",
        content: "这一段没有目标词。"
      }
    ];

    const result = buildPassageResults("李", chapterHits, 30);
    expect(result.totalMatches).toBe(3);
    expect(result.chaptersWithMatches).toBe(1);
    expect(result.hits).toHaveLength(3);
    expect(result.hits[0].title).toContain("第 1 处");
    expect(result.hits[1].title).toContain("第 2 处");
  });

  test("falls back to original chapter hits when no literal passage matches are found", () => {
    const chapterHits = [
      {
        url: "/book/book-1/chapter/b1-c009/",
        title: "第九幕",
        excerpt: "世说新语",
        content: "这段内容里没有关键词。"
      }
    ];

    const result = buildPassageResults("李", chapterHits, 30);
    expect(result.totalMatches).toBe(0);
    expect(result.hits).toEqual(chapterHits);
  });
});
