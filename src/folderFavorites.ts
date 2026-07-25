import type { FolderFavorite } from "./types";

export const DEFAULT_FOLDER_GROUP = "未分组";

export type NormalizedFolderFavorite = FolderFavorite & {
  group: string;
  tags: string[];
  alias: string;
  shortcut: string;
};

export interface FolderFavoriteFilters {
  query?: string;
  group?: string;
  tags?: readonly string[];
}

export interface FolderFavoriteGroup {
  name: string;
  items: NormalizedFolderFavorite[];
}

const MODIFIER_ALIASES: Record<string, "Ctrl" | "Alt" | "Shift" | "Meta"> = {
  alt: "Alt",
  option: "Alt",
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  command: "Meta",
  cmd: "Meta",
  meta: "Meta",
  super: "Meta",
  win: "Meta",
  windows: "Meta",
};

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

function comparisonKey(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}

export function normalizeFolderTags(
  tags: readonly string[] | string | null | undefined,
): string[] {
  const values =
    typeof tags === "string" ? tags.split(/[,，]/u) : Array.from(tags ?? []);
  const seen = new Set<string>();

  return values.reduce<string[]>((normalized, value) => {
    const displayValue = String(value).trim().normalize("NFKC");
    const key = comparisonKey(displayValue);
    if (key && !seen.has(key)) {
      seen.add(key);
      normalized.push(displayValue);
    }
    return normalized;
  }, []);
}

function normalizeShortcutKey(key: string): string {
  const normalized = key.trim().normalize("NFKC");
  if (!normalized) return "";
  if (/^[a-z]$/iu.test(normalized)) return normalized.toUpperCase();
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(normalized)) {
    return normalized.toUpperCase();
  }
  if (/^[0-9]$/u.test(normalized)) return normalized;

  const namedKeys: Record<string, string> = {
    backspace: "Backspace",
    delete: "Delete",
    down: "ArrowDown",
    end: "End",
    enter: "Enter",
    escape: "Escape",
    esc: "Escape",
    home: "Home",
    left: "ArrowLeft",
    pagedown: "PageDown",
    pageup: "PageUp",
    right: "ArrowRight",
    space: "Space",
    tab: "Tab",
    up: "ArrowUp",
  };
  return namedKeys[normalized.toLocaleLowerCase()] ?? normalized;
}

export function normalizeFolderShortcut(shortcut?: string | null): string {
  const tokens = (shortcut ?? "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length === 0) return "";

  const modifiers = new Set<(typeof MODIFIER_ORDER)[number]>();
  const keys: string[] = [];
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[comparisonKey(token)];
    if (modifier) {
      modifiers.add(modifier);
    } else {
      keys.push(normalizeShortcutKey(token));
    }
  }
  if (modifiers.size === 0 || keys.length !== 1 || !keys[0]) return "";

  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    keys[0],
  ].join("+");
}

export function normalizeFolderFavorite(
  favorite: FolderFavorite,
): NormalizedFolderFavorite {
  return {
    ...favorite,
    group: favorite.group?.trim().normalize("NFKC") || DEFAULT_FOLDER_GROUP,
    tags: normalizeFolderTags(favorite.tags),
    alias: favorite.alias?.trim().normalize("NFKC") ?? "",
    shortcut: normalizeFolderShortcut(favorite.shortcut),
  };
}

export function normalizeFolderFavorites(
  favorites: readonly FolderFavorite[],
): NormalizedFolderFavorite[] {
  return favorites.map(normalizeFolderFavorite);
}

export function findFolderShortcutConflict(
  favorites: readonly FolderFavorite[],
  shortcut: string,
  excludeFavoriteId?: string,
): NormalizedFolderFavorite | undefined {
  const normalizedShortcut = normalizeFolderShortcut(shortcut);
  if (!normalizedShortcut) return undefined;

  return normalizeFolderFavorites(favorites).find(
    (favorite) =>
      favorite.id !== excludeFavoriteId &&
      favorite.shortcut === normalizedShortcut,
  );
}

export function filterFolderFavorites(
  favorites: readonly FolderFavorite[],
  filters: FolderFavoriteFilters = {},
): NormalizedFolderFavorite[] {
  const query = comparisonKey(filters.query ?? "");
  const group = comparisonKey(filters.group ?? "");
  const tags = normalizeFolderTags(filters.tags ?? []).map(comparisonKey);

  return normalizeFolderFavorites(favorites).filter((favorite) => {
    if (group && comparisonKey(favorite.group) !== group) return false;

    const favoriteTags = new Set(favorite.tags.map(comparisonKey));
    if (tags.some((tag) => !favoriteTags.has(tag))) return false;
    if (!query) return true;

    return [
      favorite.name,
      favorite.alias,
      favorite.path,
      favorite.description,
      favorite.group,
      ...favorite.tags,
    ].some((value) => comparisonKey(value).includes(query));
  });
}

export function groupFolderFavorites(
  favorites: readonly FolderFavorite[],
): FolderFavoriteGroup[] {
  const collator = new Intl.Collator("zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
  const grouped = new Map<string, NormalizedFolderFavorite[]>();

  for (const favorite of normalizeFolderFavorites(favorites)) {
    const items = grouped.get(favorite.group) ?? [];
    items.push(favorite);
    grouped.set(favorite.group, items);
  }

  return Array.from(grouped, ([name, items]) => ({
    name,
    items: items.sort((left, right) =>
      collator.compare(left.alias || left.name, right.alias || right.name),
    ),
  })).sort((left, right) => {
    if (left.name === DEFAULT_FOLDER_GROUP) return 1;
    if (right.name === DEFAULT_FOLDER_GROUP) return -1;
    return collator.compare(left.name, right.name);
  });
}
