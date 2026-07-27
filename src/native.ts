import type {
  AppSnapshot,
  ClipboardEntry,
  SearchFilters,
  SearchResult,
  StartupItem,
  CommandTask,
  SceneWindowLayout,
} from "./types";

export interface LaunchResult {
  id: string;
  name: string;
  success: boolean;
  error?: string;
  status?: "started" | "alreadyRunning" | "failed";
}

export interface CloseResult {
  executablePath: string;
  status: "closeRequested" | "notRunning" | "unsupported" | "failed";
  windowsNotified: number;
  processesTerminated: number;
  error?: string;
}

export interface SceneLayoutCapture {
  layouts: SceneWindowLayout[];
  errors: string[];
}

export interface RestoreResult {
  itemId: string;
  status: "restored" | "windowNotFound" | "noMonitor" | "unsupported" | "failed";
  error?: string;
}

export interface MonitorDescriptor {
  deviceName: string;
  workArea: { x: number; y: number; width: number; height: number };
  primary: boolean;
}

export interface RuntimeSettingsRejected {
  tools: AppSnapshot["tools"];
  shortcuts: AppSnapshot["settings"]["shortcuts"];
  error: string;
}

export interface ClipboardActivationResult {
  pasted: boolean;
  kind: "text" | "image";
  reason?: string;
}

export interface CommandExecution {
  command: string;
  success: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

const LOCAL_KEY = "atlas-toolkit-state-v1";
const APP_ICON_CACHE_LIMIT = 64;
const appIconCache = new Map<string, string>();
const appIconRequests = new Map<string, Promise<Record<string, string>>>();

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function invokeNative<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T | null> {
  if (!hasTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function loadSnapshot(): Promise<AppSnapshot | null> {
  const native = await invokeNative<AppSnapshot>("load_snapshot");
  if (native) return native;
  const stored = localStorage.getItem(LOCAL_KEY);
  return stored ? (JSON.parse(stored) as AppSnapshot) : null;
}

export async function getDataDirectory(): Promise<string | null> {
  return invokeNative<string>("get_data_directory");
}

export function snapshotForNativePersistence(snapshot: AppSnapshot): AppSnapshot {
  return {
    ...snapshot,
    startupItems: [],
    startupFailures: [],
    clipboardHistory: [],
    activity: { searches: [], copies: [] },
  };
}

export async function saveSnapshot(snapshot: AppSnapshot): Promise<void> {
  const saved = await invokeNative<boolean>("save_snapshot", {
    snapshot: snapshotForNativePersistence(snapshot),
  });
  if (!saved) localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot));
}

export async function chooseDirectory(): Promise<string | null> {
  if (!hasTauriRuntime()) return "D:\\AtlasData";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function chooseExecutable(): Promise<StartupItem | null> {
  if (!hasTauriRuntime()) {
    return {
      id: `startup-${Date.now()}`,
      name: "Example",
      path: "C:\\Program Files\\Example\\Example.exe",
      args: [],
      delaySeconds: 2,
      enabled: true,
      order: 0,
    };
  }
  return invokeNative<StartupItem>("choose_startup_item");
}

export async function syncStartupItems(items: StartupItem[]): Promise<void> {
  await invokeNative<boolean>("sync_startup_items", { items });
}

export async function clearStartupFailures(): Promise<void> {
  await invokeNative<boolean>("clear_startup_failures");
}

export async function copyText(text: string): Promise<void> {
  if (hasTauriRuntime()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function activateClipboardEntry(
  id: string,
  pasteToTarget: boolean,
): Promise<ClipboardActivationResult> {
  return (
    (await invokeNative<ClipboardActivationResult>("activate_clipboard_entry", {
      id,
      pasteToTarget,
    })) ?? { pasted: false, kind: "text" }
  );
}

export async function searchNative(
  query: string,
  filters?: SearchFilters,
): Promise<SearchResult[] | null> {
  if (!hasTauriRuntime()) return null;
  return (
    (await invokeNative<SearchResult[]>("search_index", {
      query,
      kind: filters?.kind === "all" ? "" : filters?.kind ?? "",
      extension: filters?.extension ?? "",
      drive: filters?.drive ?? "",
    })) ?? []
  );
}

export async function getAppIcons(paths: string[]): Promise<Record<string, string>> {
  const uniquePaths = [...new Set(paths)].filter(Boolean);
  if (!uniquePaths.length) return {};

  const icons: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of uniquePaths) {
    const cached = appIconCache.get(path);
    if (cached) {
      icons[path] = cached;
    } else {
      missing.push(path);
    }
  }
  if (!missing.length) return icons;

  const requestKey = [...missing].sort().join("\n");
  let request = appIconRequests.get(requestKey);
  if (!request) {
    request = invokeNative<Record<string, string>>("load_app_icons", {
      paths: missing,
    }).then((loaded) => loaded ?? {});
    appIconRequests.set(requestKey, request);
  }
  try {
    const loaded = await request;
    for (const [path, dataUrl] of Object.entries(loaded)) {
      if (!dataUrl) continue;
      icons[path] = dataUrl;
      appIconCache.set(path, dataUrl);
      while (appIconCache.size > APP_ICON_CACHE_LIMIT) {
        const oldest = appIconCache.keys().next().value;
        if (oldest === undefined) break;
        appIconCache.delete(oldest);
      }
    }
    return icons;
  } finally {
    appIconRequests.delete(requestKey);
  }
}

export async function rebuildSearchIndex(roots: string[]): Promise<number> {
  return (await invokeNative<number>("rebuild_search_index", { roots })) ?? 0;
}

export async function getSearchIndexStatus(): Promise<string> {
  return (await invokeNative<string>("get_index_status")) ?? "ready";
}

export async function getSearchIndexCount(): Promise<number> {
  return (await invokeNative<number>("get_index_count")) ?? 0;
}

export async function recordActivity(
  kind: "search" | "copy",
  detail: string,
): Promise<void> {
  await invokeNative<boolean>("record_activity", { kind, detail });
}

export async function hideCurrentWindow(): Promise<void> {
  if (!hasTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

export async function hideOverlay(
  mode: "search" | "prompts" | "clipboard",
): Promise<void> {
  const hidden = await invokeNative<boolean>("hide_overlay", { mode });
  if (hidden === null) await hideCurrentWindow();
}

export async function openTarget(path: string, reveal = false): Promise<void> {
  await invokeNative("open_target", { path, reveal });
}

export async function launchStartupItems(items: StartupItem[]): Promise<LaunchResult[]> {
  return (
    (await invokeNative<LaunchResult[]>("launch_startup_items", {
      items: items.filter((item) => item.enabled),
    })) ?? []
  );
}

export async function closePreviousStartupScene(
  previousItems: StartupItem[],
  nextItems: StartupItem[],
): Promise<CloseResult[]> {
  return (
    (await invokeNative<CloseResult[]>("close_previous_startup_scene", {
      previousItems,
      nextItems,
    })) ?? []
  );
}

export async function captureStartupSceneLayout(
  items: StartupItem[],
): Promise<SceneLayoutCapture> {
  return (
    (await invokeNative<SceneLayoutCapture>("capture_startup_scene_layout", { items })) ?? {
      layouts: [],
      errors: [],
    }
  );
}

export async function restoreStartupSceneLayout(
  layouts: SceneWindowLayout[],
): Promise<RestoreResult[]> {
  return (
    (await invokeNative<RestoreResult[]>("restore_startup_scene_layout", { layouts })) ?? []
  );
}

export async function listStartupSceneMonitors(): Promise<MonitorDescriptor[]> {
  return (
    (await invokeNative<MonitorDescriptor[]>("list_startup_scene_monitors")) ?? []
  );
}

export async function runCommandTask(task: CommandTask): Promise<CommandExecution[]> {
  return (
    (await invokeNative<CommandExecution[]>("run_command_task", { task })) ?? []
  );
}

export async function bindNativeSearchShortcut(): Promise<() => void> {
  if (!hasTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen("atlas-show-search", () => {
    window.dispatchEvent(new CustomEvent("atlas-show-search"));
  });
}

export async function bindStartupResults(
  handler: (results: LaunchResult[]) => void,
): Promise<() => void> {
  if (!hasTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LaunchResult[]>("atlas-startup-results", (event) => {
    handler(event.payload.filter((result) => !result.success));
  });
}

export async function bindClipboardHistory(
  handler: (entries: ClipboardEntry[]) => void,
): Promise<() => void> {
  if (!hasTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ClipboardEntry[]>("atlas-clipboard-history", (event) => {
    handler(event.payload);
  });
}

export async function bindSearchFilters(
  handler: (filters: SearchFilters) => void,
): Promise<() => void> {
  if (!hasTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<SearchFilters>("atlas-search-filters", (event) => {
    handler(event.payload);
  });
}

export async function bindActivity(
  handler: (activity: AppSnapshot["activity"]) => void,
): Promise<() => void> {
  if (!hasTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<AppSnapshot["activity"]>("atlas-activity-updated", (event) => {
    handler(event.payload);
  });
}

export async function bindRuntimeSettingsRejected(
  handler: (rejection: RuntimeSettingsRejected) => void,
): Promise<() => void> {
  if (!hasTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<RuntimeSettingsRejected>(
    "atlas-runtime-settings-rejected",
    (event) => handler(event.payload),
  );
}
