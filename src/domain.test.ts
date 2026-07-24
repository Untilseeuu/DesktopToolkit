import { describe, expect, it } from "vitest";
import {
  appendClipboardEntry,
  calculateOverviewMetrics,
  buildQuickLinkResults,
  filterPromptsByCategory,
  filterPrompts,
  filterSearchResults,
  mergeSnapshotDefaults,
  planDataMigration,
  rankSearchResults,
  reorderItems,
  selectSearchResults,
} from "./domain";
import type {
  AppSnapshot,
  ClipboardEntry,
  PromptEntry,
  SearchResult,
  StartupItem,
} from "./types";

describe("reorderItems", () => {
  it("moves a startup item and rewrites stable order values", () => {
    const items = [
      { id: "a", order: 0 },
      { id: "b", order: 1 },
      { id: "c", order: 2 },
    ] as StartupItem[];

    expect(reorderItems(items, 2, 0).map(({ id, order }) => [id, order])).toEqual([
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ]);
  });
});

describe("filterPrompts", () => {
  const prompts: PromptEntry[] = [
    {
      id: "1",
      title: "代码审查",
      content: "检查边界条件和并发问题",
      category: "开发",
      tags: ["review", "质量"],
      note: "",
      favorite: true,
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: "2",
      title: "周报润色",
      content: "让表达更清晰",
      category: "写作",
      tags: ["工作"],
      note: "",
      favorite: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  it("matches title, content, category and tags without case sensitivity", () => {
    expect(filterPrompts(prompts, "REVIEW").map((item) => item.id)).toEqual(["1"]);
    expect(filterPrompts(prompts, "写作").map((item) => item.id)).toEqual(["2"]);
  });

  it("puts favorites and recently updated prompts first for an empty query", () => {
    expect(filterPrompts(prompts, "").map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("filters the visible prompts by an expanded category selection", () => {
    expect(filterPromptsByCategory(prompts, "写作").map((item) => item.id)).toEqual(["2"]);
    expect(filterPromptsByCategory(prompts, "all")).toHaveLength(2);
  });
});

describe("buildQuickLinkResults", () => {
  const links = [
    {
      id: "google",
      name: "Google 搜索",
      description: "使用浏览器搜索网页",
      keyword: "g",
      urlTemplate: "https://www.google.com/search?q={query}",
      enabled: true,
    },
  ];

  it("expands a keyword parameter and URL-encodes the search text", () => {
    expect(buildQuickLinkResults(links, "g tauri 桌面应用")[0]).toMatchObject({
      kind: "link",
      name: "Google 搜索 · tauri 桌面应用",
      path: "https://www.google.com/search?q=tauri%20%E6%A1%8C%E9%9D%A2%E5%BA%94%E7%94%A8",
    });
  });

  it("matches an exact browser alias with and without a parameter", () => {
    const edgeLinks = [{
      ...links[0],
      id: "edge",
      name: "Edge 搜索",
      keyword: "ll",
      urlTemplate: "https://www.bing.com/search?q={query}",
    }];

    expect(buildQuickLinkResults(edgeLinks, "ll")).toHaveLength(1);
    expect(buildQuickLinkResults(edgeLinks, "ll Tauri")[0].path).toBe(
      "https://www.bing.com/search?q=Tauri",
    );
  });

  it("fuzzy matches a link name or description before filesystem results", () => {
    const result = buildQuickLinkResults(links, "浏览器");
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBeGreaterThan(10_000);
  });
});

describe("rankSearchResults", () => {
  it("ranks exact app names before prefix and path matches", () => {
    const results: SearchResult[] = [
      { id: "1", name: "Notepad++", path: "C:\\Tools\\Notepad++.exe", kind: "app" },
      { id: "2", name: "notes.txt", path: "C:\\Users\\me\\Desktop\\notes.txt", kind: "file" },
      { id: "3", name: "Notepad", path: "C:\\Windows\\notepad.exe", kind: "app" },
    ];

    expect(rankSearchResults(results, "notepad").map((item) => item.id)).toEqual([
      "3",
      "1",
      "2",
    ]);
  });

  it("always ranks custom links before applications and files", () => {
    const results: SearchResult[] = [
      { id: "app", name: "Google", path: "C:\\Google.exe", kind: "app" },
      {
        id: "link",
        name: "Google 搜索",
        path: "https://google.com",
        kind: "link",
        priority: 20_000,
      },
    ];
    expect(rankSearchResults(results, "google").map((item) => item.id)).toEqual([
      "link",
      "app",
    ]);
  });

  it("uses the stable type order link, app, folder, then file", () => {
    const results: SearchResult[] = [
      { id: "file", name: "codex", path: "C:\\codex.txt", kind: "file" },
      { id: "folder", name: "codex folder", path: "C:\\codex", kind: "folder" },
      { id: "app", name: "ChatGPT", path: "shell:AppsFolder\\OpenAI.Codex!App", kind: "app" },
      {
        id: "link",
        name: "Codex docs",
        path: "https://example.com",
        kind: "link",
        priority: 20_000,
      },
    ];

    expect(rankSearchResults(results, "codex").map((item) => item.id)).toEqual([
      "link",
      "app",
      "folder",
      "file",
    ]);
  });
});

describe("planDataMigration", () => {
  it("does nothing when the selected directory is unchanged", () => {
    expect(planDataMigration("D:\\Atlas", "D:\\Atlas", true)).toEqual({
      kind: "noop",
      target: "D:\\Atlas",
    });
  });

  it("creates a directory when no current database exists", () => {
    expect(planDataMigration("C:\\Old", "E:\\Atlas", false)).toEqual({
      kind: "initialize",
      target: "E:\\Atlas",
    });
  });

  it("migrates existing data to a different directory", () => {
    expect(planDataMigration("C:\\Old", "E:\\Atlas", true)).toEqual({
      kind: "migrate",
      source: "C:\\Old",
      target: "E:\\Atlas",
    });
  });
});

describe("selectSearchResults", () => {
  const demo: SearchResult[] = [
    { id: "demo", name: "演示应用", path: "C:\\Demo.exe", kind: "app" },
  ];

  it("keeps an empty native result empty instead of showing fake files", () => {
    expect(selectSearchResults([], demo)).toEqual([]);
  });

  it("uses demo results only outside the native runtime", () => {
    expect(selectSearchResults(null, demo)).toEqual(demo);
  });
});

describe("filterSearchResults", () => {
  const results: SearchResult[] = [
    { id: "1", name: "Atlas.exe", path: "D:\\Apps\\Atlas.exe", kind: "app" },
    { id: "2", name: "notes.md", path: "C:\\Docs\\notes.md", kind: "file" },
    { id: "3", name: "Docs", path: "E:\\Docs", kind: "folder" },
    {
      id: "4",
      name: "Edge 搜索",
      path: "https://www.bing.com/search?q=atlas",
      kind: "link",
    },
  ];

  it("filters by kind, extension and drive together", () => {
    expect(
      filterSearchResults(results, {
        kind: "file",
        extension: "md",
        drive: "C:",
      }).map((item) => item.id),
    ).toEqual(["2", "4"]);
  });

  it("keeps quick links visible above filesystem filters", () => {
    expect(
      filterSearchResults(results, {
        kind: "app",
        extension: "exe",
        drive: "D:",
      }).map((item) => item.id),
    ).toContain("4");
  });
});

describe("calculateOverviewMetrics", () => {
  it("uses persisted activity rather than placeholder values", () => {
    expect(
      calculateOverviewMetrics({
        searches: [{ at: Date.now(), query: "atlas" }],
        copies: [{ at: Date.now(), source: "prompt" }],
        startupLastRunAt: 1_700_000_000_000,
      }),
    ).toMatchObject({ searchCount: 1, copyCount: 1, startupLastRunAt: 1_700_000_000_000 });
  });
});

describe("appendClipboardEntry", () => {
  it("deduplicates consecutive text and enforces the configured limit", () => {
    const existing: ClipboardEntry[] = [
      { id: "2", text: "second", copiedAt: 2 },
      { id: "1", text: "first", copiedAt: 1 },
    ];
    expect(appendClipboardEntry(existing, "second", 2, 3)).toEqual(existing);
    expect(appendClipboardEntry(existing, "third", 3, 2).map((item) => item.text)).toEqual([
      "third",
      "second",
    ]);
  });
});

describe("mergeSnapshotDefaults", () => {
  it("upgrades an older saved snapshot with fonts, shortcuts and clipboard settings", () => {
    const old = {
      tools: {
        startup: { enabled: true },
        search: { enabled: true },
        prompts: { enabled: true },
      },
      startupItems: [],
      prompts: [],
      settings: {
        theme: "light",
        shortcut: "Alt+Space",
        dataDirectory: "D:\\Atlas\\data",
        indexRoots: [],
        excludedPatterns: [],
      },
    } as unknown as AppSnapshot;
    const merged = mergeSnapshotDefaults(old);
    expect(merged.settings.fontFamily).toBe("system");
    expect(merged.settings.fontScale).toBe(1);
    expect(merged.settings.shortcuts.search).toBe("Alt+Space");
    expect(merged.settings.clipboardLimit).toBe(50);
    expect(merged.tools.clipboard.enabled).toBe(true);
    expect(merged.quickLinks).toEqual([]);
  });
});
