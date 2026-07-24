export type ToolId = "startup" | "search" | "prompts" | "clipboard";
export type NavId = "overview" | ToolId | "settings";

export interface ToolState {
  enabled: boolean;
}

export interface StartupItem {
  id: string;
  name: string;
  path: string;
  args: string[];
  workingDirectory?: string;
  delaySeconds: number;
  enabled: boolean;
  order: number;
}

export type SearchResultKind = "link" | "app" | "file" | "folder";

export interface SearchResult {
  id: string;
  name: string;
  path: string;
  kind: SearchResultKind;
  modifiedAt?: number;
  description?: string;
  priority?: number;
  iconDataUrl?: string;
}

export interface SearchFilters {
  kind: "all" | SearchResultKind;
  extension: string;
  drive: string;
}

export interface ClipboardEntry {
  id: string;
  kind?: "text" | "image";
  text?: string;
  imageFile?: string;
  previewDataUrl?: string;
  width?: number;
  height?: number;
  fingerprint?: string;
  copiedAt: number;
}

export interface PromptEntry {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  note: string;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface QuickLink {
  id: string;
  name: string;
  description: string;
  keyword: string;
  urlTemplate: string;
  enabled: boolean;
}

export interface AppSettings {
  theme: "light" | "dark";
  fontFamily: "system" | "serif" | "mono";
  fontScale: number;
  shortcuts: {
    search: string;
    prompts: string;
    clipboard: string;
  };
  dataDirectory: string;
  indexRoots: string[];
  excludedPatterns: string[];
  searchFilters: SearchFilters;
  clipboardLimit: number;
}

export interface ActivityLog {
  searches: Array<{ at: number; query: string }>;
  copies: Array<{ at: number; source: "prompt" | "clipboard" | "path" }>;
  startupLastRunAt?: number;
}

export interface AppSnapshot {
  tools: Record<ToolId, ToolState>;
  startupItems: StartupItem[];
  startupFailures?: Array<{
    id: string;
    name: string;
    success: boolean;
    error?: string;
  }>;
  prompts: PromptEntry[];
  quickLinks: QuickLink[];
  clipboardHistory: ClipboardEntry[];
  activity: ActivityLog;
  settings: AppSettings;
}
