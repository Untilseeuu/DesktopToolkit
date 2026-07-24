import type {
  ActivityLog,
  AppSnapshot,
  ClipboardEntry,
  PromptEntry,
  QuickLink,
  SearchFilters,
  SearchResult,
  StartupItem,
} from "./types";

export type DataMigrationPlan =
  | { kind: "noop"; target: string }
  | { kind: "initialize"; target: string }
  | { kind: "migrate"; source: string; target: string };

export function reorderItems(
  items: StartupItem[],
  fromIndex: number,
  toIndex: number,
): StartupItem[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items.map((item, order) => ({ ...item, order }));
  }

  const reordered = [...items];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  return reordered.map((item, order) => ({ ...item, order }));
}

export function filterPrompts(prompts: PromptEntry[], query: string): PromptEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = normalized
    ? prompts.filter((prompt) =>
        [
          prompt.title,
          prompt.content,
          prompt.category,
          prompt.note,
          ...prompt.tags,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized),
      )
    : [...prompts];

  return filtered.sort(
    (a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt,
  );
}

export function filterPromptsByCategory(
  prompts: PromptEntry[],
  category: string,
): PromptEntry[] {
  return category === "all"
    ? prompts
    : prompts.filter((prompt) => prompt.category === category);
}

function fuzzyIncludes(value: string, query: string): boolean {
  if (value.includes(query)) return true;
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

export function buildQuickLinkResults(
  links: QuickLink[],
  query: string,
): SearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return links.flatMap((link) => {
    if (!link.enabled) return [];
    const keyword = link.keyword.trim().toLocaleLowerCase();
    const name = link.name.trim();
    const normalizedName = name.toLocaleLowerCase();
    const parameterPrefixes = [keyword, normalizedName].filter(Boolean);
    const parameterPrefix = parameterPrefixes.find((prefix) =>
      normalized.startsWith(`${prefix} `),
    );
    const parameter = parameterPrefix
      ? query.trim().slice(parameterPrefix.length).trim()
      : "";
    const haystack = `${name} ${link.description} ${keyword}`.toLocaleLowerCase();
    if (!parameter && !fuzzyIncludes(haystack, normalized)) return [];
    const resolvedUrl = link.urlTemplate.replace(
      /\{query\}/gi,
      encodeURIComponent(parameter),
    );
    return [{
      id: `link-${link.id}`,
      name: parameter ? `${name} · ${parameter}` : name,
      description: link.description,
      path: resolvedUrl,
      kind: "link" as const,
      priority: parameter ? 30_000 : 20_000,
    }];
  });
}

function searchScore(result: SearchResult, normalizedQuery: string): number {
  const priority = result.priority ?? 0;
  const kindPriority = {
    link: 60_000,
    app: 40_000,
    folder: 20_000,
    file: 0,
  }[result.kind];
  const name = result.name.toLocaleLowerCase();
  const path = result.path.toLocaleLowerCase();
  if (name === normalizedQuery) return kindPriority + priority + 10_000;
  if (name.startsWith(normalizedQuery)) {
    return kindPriority + priority + 8_000 - name.length;
  }
  const nameIndex = name.indexOf(normalizedQuery);
  if (nameIndex >= 0) {
    return kindPriority + priority + 6_000 - nameIndex * 10 - name.length;
  }
  const pathIndex = path.indexOf(normalizedQuery);
  if (pathIndex >= 0) return kindPriority + priority + 2_000 - pathIndex;
  return kindPriority + priority;
}

export function rankSearchResults(
  results: SearchResult[],
  query: string,
): SearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return results;
  return [...results].sort(
    (a, b) =>
      searchScore(b, normalized) - searchScore(a, normalized) ||
      a.name.localeCompare(b.name),
  );
}

export function selectSearchResults(
  nativeResults: SearchResult[] | null,
  demoResults: SearchResult[],
): SearchResult[] {
  return nativeResults === null ? demoResults : nativeResults;
}

export function filterSearchResults(
  results: SearchResult[],
  filters: SearchFilters,
): SearchResult[] {
  const extension = filters.extension.trim().replace(/^\./, "").toLocaleLowerCase();
  const drive = filters.drive.trim().toLocaleLowerCase();
  return results.filter((result) => {
    // User-defined commands remain available regardless of filesystem filters.
    if (result.kind === "link") return true;
    if (filters.kind !== "all" && result.kind !== filters.kind) return false;
    if (drive && !result.path.toLocaleLowerCase().startsWith(drive)) {
      return false;
    }
    if (extension) {
      if (result.kind !== "file") return false;
      const actual = result.name.split(".").pop()?.toLocaleLowerCase() ?? "";
      if (actual !== extension) return false;
    }
    return true;
  });
}

function isToday(timestamp: number, now: number): boolean {
  const value = new Date(timestamp);
  const current = new Date(now);
  return (
    value.getFullYear() === current.getFullYear() &&
    value.getMonth() === current.getMonth() &&
    value.getDate() === current.getDate()
  );
}

export function calculateOverviewMetrics(activity: ActivityLog, now = Date.now()) {
  return {
    searchCount: activity.searches.filter((item) => isToday(item.at, now)).length,
    copyCount: activity.copies.filter((item) => isToday(item.at, now)).length,
    startupLastRunAt: activity.startupLastRunAt,
  };
}

export function appendClipboardEntry(
  entries: ClipboardEntry[],
  text: string,
  copiedAt: number,
  limit: number,
): ClipboardEntry[] {
  const normalized = text.trim();
  if (!normalized || entries[0]?.text === normalized) return entries;
  const nextEntry: ClipboardEntry = {
    id: `clip-${copiedAt}`,
    kind: "text",
    text: normalized,
    copiedAt,
  };
  return [
    nextEntry,
    ...entries.filter((entry) => entry.text !== normalized),
  ].slice(0, Math.max(1, limit));
}

export function clipboardEntryKind(entry: ClipboardEntry): "text" | "image" {
  return entry.kind === "image" && entry.imageFile ? "image" : "text";
}

export function clipboardEntrySearchText(entry: ClipboardEntry): string {
  if (clipboardEntryKind(entry) === "image") {
    return `图片 image ${entry.width ?? ""} ${entry.height ?? ""}`;
  }
  return entry.text ?? "";
}

export function mergeSnapshotDefaults(snapshot: AppSnapshot): AppSnapshot {
  const legacyShortcut = (snapshot.settings as AppSnapshot["settings"] & { shortcut?: string })
    .shortcut;
  const savedRoots = snapshot.settings?.indexRoots ?? [];
  const indexRoots =
    savedRoots.length === 0 ||
    savedRoots.some(
      (root) =>
        root === "用户目录" ||
        root === "开始菜单" ||
        (!root.includes(":\\") && !root.startsWith("/") && root !== "*"),
    )
      ? ["*"]
      : savedRoots;
  return {
    ...snapshot,
    tools: {
      startup: snapshot.tools?.startup ?? { enabled: true },
      search: snapshot.tools?.search ?? { enabled: true },
      prompts: snapshot.tools?.prompts ?? { enabled: true },
      clipboard: snapshot.tools?.clipboard ?? { enabled: true },
    },
    startupItems: snapshot.startupItems ?? [],
    startupFailures: snapshot.startupFailures ?? [],
    prompts: snapshot.prompts ?? [],
    quickLinks: snapshot.quickLinks ?? [],
    clipboardHistory: (snapshot.clipboardHistory ?? []).map((entry) => ({
      ...entry,
      kind: clipboardEntryKind(entry),
      text: clipboardEntryKind(entry) === "text" ? entry.text ?? "" : undefined,
    })),
    activity: snapshot.activity ?? { searches: [], copies: [] },
    settings: {
      ...snapshot.settings,
      theme: snapshot.settings?.theme ?? "light",
      fontFamily: snapshot.settings?.fontFamily ?? "system",
      fontScale: snapshot.settings?.fontScale ?? 1,
      shortcuts: snapshot.settings?.shortcuts ?? {
        search: legacyShortcut ?? "Alt+Space",
        prompts: "Alt+Shift+P",
        clipboard: "Alt+Shift+V",
      },
      dataDirectory: snapshot.settings?.dataDirectory ?? "",
      indexRoots,
      excludedPatterns: snapshot.settings?.excludedPatterns ?? [
        "node_modules",
        ".git",
        "Windows\\WinSxS",
      ],
      searchFilters: snapshot.settings?.searchFilters ?? {
        kind: "all",
        extension: "",
        drive: "",
      },
      clipboardLimit: snapshot.settings?.clipboardLimit ?? 50,
    },
  };
}

function normalizeDirectory(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").toLocaleLowerCase();
}

export function planDataMigration(
  currentDirectory: string,
  targetDirectory: string,
  currentDatabaseExists: boolean,
): DataMigrationPlan {
  const target = targetDirectory.trim().replace(/[\\/]+$/, "");
  if (normalizeDirectory(currentDirectory) === normalizeDirectory(targetDirectory)) {
    return { kind: "noop", target };
  }
  if (!currentDatabaseExists) return { kind: "initialize", target };
  return { kind: "migrate", source: currentDirectory, target };
}
