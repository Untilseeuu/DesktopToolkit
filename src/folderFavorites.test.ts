import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOLDER_GROUP,
  filterFolderFavorites,
  findFolderShortcutConflict,
  groupFolderFavorites,
  normalizeFolderFavorite,
  normalizeFolderShortcut,
  normalizeFolderTags,
} from "./folderFavorites";
import type { FolderFavorite } from "./types";

function favorite(
  id: string,
  overrides: Partial<FolderFavorite> = {},
): FolderFavorite {
  return {
    id,
    name: `Folder ${id}`,
    path: `D:\\${id}`,
    description: "",
    createdAt: 1,
    ...overrides,
  };
}

describe("folder favorite display limits", () => {
  it("limits card metadata to readable lengths", () => {
    const normalized = normalizeFolderFavorite(favorite("limits", {
      description: "描".repeat(180),
      group: "组".repeat(40),
      tags: ["一".repeat(20), "二", "三", "四", "五", "六"],
    }));

    expect(normalized.description).toHaveLength(120);
    expect(normalized.group).toHaveLength(24);
    expect(normalized.tags).toHaveLength(5);
    expect(normalized.tags[0]).toHaveLength(12);
  });
});

describe("normalizeFolderTags", () => {
  it("trims tags, removes blanks and deduplicates without losing display casing", () => {
    expect(normalizeFolderTags([" 工作 ", "work", "工作", "", "WORK"])).toEqual([
      "工作",
      "work",
    ]);
  });

  it("accepts comma-separated text from a folder editor", () => {
    expect(normalizeFolderTags("设计, 原型，设计")).toEqual(["设计", "原型"]);
  });
});

describe("normalizeFolderFavorite", () => {
  it("migrates a legacy favorite that does not have organization fields", () => {
    expect(normalizeFolderFavorite(favorite("legacy"))).toMatchObject({
      group: DEFAULT_FOLDER_GROUP,
      tags: [],
      alias: "",
      shortcut: "",
    });
  });

  it("normalizes whitespace, tags and shortcut notation", () => {
    expect(
      normalizeFolderFavorite(
        favorite("design", {
          group: "  项目 ",
          tags: [" UI ", "ui", "原型"],
          alias: "  设计稿 ",
          shortcut: " shift + control + d ",
        }),
      ),
    ).toMatchObject({
      group: "项目",
      tags: ["UI", "原型"],
      alias: "设计稿",
      shortcut: "Ctrl+Shift+D",
    });
  });
});

describe("normalizeFolderShortcut", () => {
  it("uses a stable modifier order and common modifier aliases", () => {
    expect(normalizeFolderShortcut("option+control+shift+k")).toBe(
      "Ctrl+Alt+Shift+K",
    );
    expect(normalizeFolderShortcut("command + f2")).toBe("Meta+F2");
  });

  it("returns an empty shortcut for incomplete modifier-only input", () => {
    expect(normalizeFolderShortcut("Ctrl+Shift")).toBe("");
    expect(normalizeFolderShortcut("D")).toBe("");
    expect(normalizeFolderShortcut("Enter")).toBe("");
    expect(normalizeFolderShortcut("")).toBe("");
  });
});

describe("findFolderShortcutConflict", () => {
  const favorites = [
    favorite("docs", { shortcut: "Ctrl+Alt+D" }),
    favorite("design", { shortcut: "Ctrl+Shift+D" }),
  ];

  it("detects an equivalent shortcut regardless of notation and casing", () => {
    expect(
      findFolderShortcutConflict(favorites, "alt + ctrl + d")?.id,
    ).toBe("docs");
  });

  it("can exclude the favorite currently being edited", () => {
    expect(
      findFolderShortcutConflict(favorites, "Ctrl+Alt+D", "docs"),
    ).toBeUndefined();
    expect(findFolderShortcutConflict(favorites, "")).toBeUndefined();
  });
});

describe("filterFolderFavorites", () => {
  const favorites = [
    favorite("design", {
      name: "Design Assets",
      alias: "设计稿",
      group: "项目",
      tags: ["UI", "客户 A"],
      description: "产品素材",
    }),
    favorite("docs", {
      name: "Documents",
      group: "资料",
      tags: ["工作"],
    }),
    favorite("downloads", { name: "Downloads" }),
  ];

  it("matches an alias as well as folder metadata", () => {
    expect(
      filterFolderFavorites(favorites, { query: "设计稿" }).map(({ id }) => id),
    ).toEqual(["design"]);
    expect(
      filterFolderFavorites(favorites, { query: "客户 a" }).map(({ id }) => id),
    ).toEqual(["design"]);
  });

  it("combines group and tag filters using normalized values", () => {
    expect(
      filterFolderFavorites(favorites, {
        group: " 项目 ",
        tags: ["ui", "客户 A"],
      }).map(({ id }) => id),
    ).toEqual(["design"]);
  });
});

describe("groupFolderFavorites", () => {
  it("sorts named groups and places the default group last", () => {
    const groups = groupFolderFavorites([
      favorite("ungrouped"),
      favorite("work-z", { name: "Zeta", group: "工作" }),
      favorite("project", { alias: "Alpha", group: "项目" }),
      favorite("work-a", { name: "Alpha", group: "工作" }),
    ]);

    expect(groups.map(({ name }) => name)).toEqual(["工作", "项目", DEFAULT_FOLDER_GROUP]);
    expect(groups[0].items.map(({ id }) => id)).toEqual(["work-a", "work-z"]);
  });
});
