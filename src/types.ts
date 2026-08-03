export type ToolId =
  | "startup"
  | "search"
  | "prompts"
  | "clipboard"
  | "automation"
  | "folders";
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

export interface StartupScene {
  id: string;
  name: string;
  description: string;
  itemIds: string[];
  closePreviousApps?: boolean;
  restoreLayout?: boolean;
  windowLayouts?: SceneWindowLayout[];
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneWindowLayout {
  itemId: string;
  executablePath: string;
  rect: WindowRect;
  maximized: boolean;
  monitorDeviceName?: string;
}

export interface CommandTask {
  id: string;
  name: string;
  description: string;
  commands: string[];
  workingDirectory?: string;
  showTerminal: boolean;
  closeTerminalOnFinish: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface FolderFavorite {
  id: string;
  name: string;
  path: string;
  description: string;
  group?: string;
  tags?: string[];
  alias?: string;
  shortcut?: string;
  createdAt: number;
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

export interface IndexProgress {
  status: "idle" | "indexing" | "ready" | "failed";
  phase:
    | "idle"
    | "authorizing"
    | "mft"
    | "scanning"
    | "finalizing"
    | "complete"
    | "failed";
  indexedItems: number;
  completedRoots: number;
  totalRoots: number;
  currentRoot?: string;
  fallbackReason?: string;
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
  parameterName?: string;
  urlTemplate: string;
  enabled: boolean;
}

export interface BrandingSettings {
  appName: string;
  appDescription: string;
  workspaceName: string;
  workspaceDescription: string;
  logoPath: string;
  avatarPath: string;
  backgroundPath: string;
  toolNames: Record<ToolId, string>;
}

export interface CustomFont {
  id: string;
  name: string;
  path: string;
}

export interface CustomTheme {
  id: string;
  name: string;
  mode: "light" | "dark";
  colors: {
    paper: string;
    panel: string;
    card: string;
    ink: string;
    muted: string;
    accent: string;
    moss: string;
    sidebar?: string;
    sidebarActive?: string;
    sidebarInk?: string;
    sidebarMuted?: string;
    line?: string;
    lineStrong?: string;
    brandSurface?: string;
    brandInk?: string;
  };
}

export interface AppSettings {
  theme: "light" | "dark";
  fontFamily: "system" | "serif" | "yahei";
  fontScale: number;
  shortcuts: {
    search: string;
    prompts: string;
    clipboard: string;
  };
  dataDirectory: string;
  indexSetup: "pending" | "deferred" | "ready";
  excludedPatterns: string[];
  searchFilters: SearchFilters;
  clipboardLimit: number;
  clipboardRetentionDays: number;
  clipboardCapturePaused: boolean;
  clipboardExcludedApps: string[];
  launchAtLogin: boolean;
  loginSceneId: string;
  branding: BrandingSettings;
  customFonts: CustomFont[];
  activeCustomFontId: string;
  customThemes: CustomTheme[];
  activeCustomThemeId: string;
  backgroundOpacity: number;
  confirmOnClose: boolean;
}

export interface ActivityLog {
  searches: Array<{ at: number; query: string }>;
  copies: Array<{ at: number; source: "prompt" | "clipboard" | "path" }>;
  startupLastRunAt?: number;
}

export interface AppSnapshot {
  tools: Record<ToolId, ToolState>;
  startupItems: StartupItem[];
  startupScenes: StartupScene[];
  commandTasks: CommandTask[];
  folderGroups: string[];
  folderFavorites: FolderFavorite[];
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
