import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { DEFAULT_SHORTCUTS, mergeSnapshotDefaults } from "./domain";
import {
  shouldReportPersistenceError,
  shouldSkipNativePersistence,
} from "./persistencePolicy";
import {
  bindActivity,
  bindClipboardHistory,
  bindRuntimeSettingsRejected,
  bindSearchFilters,
  bindStartupResults,
  clearStartupFailures as clearNativeStartupFailures,
  getDataDirectory,
  loadSnapshot,
  recordActivity,
  saveSnapshot,
  syncStartupItems,
} from "./native";
import type {
  AppSettings,
  AppSnapshot,
  ClipboardEntry,
  PromptEntry,
  QuickLink,
  SearchFilters,
  StartupItem,
  ToolId,
} from "./types";

const now = Date.now();

export const defaultSnapshot: AppSnapshot = {
  tools: {
    startup: { enabled: true },
    search: { enabled: true },
    prompts: { enabled: true },
    clipboard: { enabled: true },
    automation: { enabled: true },
    folders: { enabled: true },
  },
  startupItems: [],
  startupScenes: [{
    id: "default-scene",
    name: "默认场景",
    description: "开机后使用的基础工作环境",
    itemIds: [],
  }],
  commandTasks: [],
  folderGroups: [],
  folderFavorites: [],
  startupFailures: [],
  prompts: [
    {
      id: "welcome-prompt",
      title: "把复杂问题拆清楚",
      content:
        "请先识别目标、约束与未知信息，再给出不超过五步的执行方案。每一步说明预期结果和失败时的替代路径。",
      category: "通用",
      tags: ["分析", "规划"],
      note: "适合在任务开始时使用",
      favorite: true,
      createdAt: now,
      updatedAt: now,
    },
  ],
  quickLinks: [],
  clipboardHistory: [],
  activity: { searches: [], copies: [] },
  settings: {
    theme: "light",
    fontFamily: "system",
    fontScale: 1,
    shortcuts: { ...DEFAULT_SHORTCUTS },
    dataDirectory: "应用目录\\data",
    indexSetup: "ready",
    excludedPatterns: ["node_modules", ".git", "Windows\\WinSxS"],
    searchFilters: { kind: "all", extension: "", drive: "" },
    clipboardLimit: 50,
    clipboardRetentionDays: 30,
    clipboardCapturePaused: false,
    clipboardExcludedApps: [
      "1Password.exe",
      "Bitwarden.exe",
      "KeePass.exe",
      "KeePassXC.exe",
    ],
    launchAtLogin: true,
    loginSceneId: "default-scene",
    branding: {
      appName: "ATLAS",
      appDescription: "DESKTOP KIT",
      workspaceName: "本地工作区",
      workspaceDescription: "所有数据仅在本机",
      logoPath: "",
      avatarPath: "",
      backgroundPath: "",
      toolNames: {
        startup: "启动编排",
        search: "全局搜索",
        prompts: "提示词库",
        clipboard: "剪贴板历史",
        automation: "自动化命令",
        folders: "文件夹收藏",
      },
    },
    customFonts: [],
    activeCustomFontId: "",
    customThemes: [],
    activeCustomThemeId: "",
    backgroundOpacity: 0.35,
    confirmOnClose: true,
  },
};

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useToolkit() {
  const [snapshot, setSnapshotState] = useState<AppSnapshot>(defaultSnapshot);
  const [hydrated, setHydrated] = useState(false);
  const latestSnapshot = useRef(snapshot);
  const revision = useRef(0);
  const localRevision = useRef(0);
  const persistedLocalRevision = useRef(0);
  const saveInFlight = useRef(false);
  const retryTimer = useRef<number | null>(null);
  const retryDelay = useRef(1_000);
  const consecutiveSaveFailures = useRef(0);
  const nativeSnapshot = useRef<AppSnapshot | null>(null);

  const setSnapshot = useCallback<Dispatch<SetStateAction<AppSnapshot>>>((update) => {
    localRevision.current += 1;
    setSnapshotState(update);
  }, []);

  const applyNativeUpdate = useCallback(
    (update: (current: AppSnapshot) => AppSnapshot) => {
      setSnapshotState((current) => {
        const next = update(current);
        nativeSnapshot.current = next;
        latestSnapshot.current = next;
        return next;
      });
    },
    [],
  );

  const persistLatest = useCallback(async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    const savingRevision = revision.current;
    const savingLocalRevision = localRevision.current;
    try {
      await saveSnapshot(latestSnapshot.current);
      persistedLocalRevision.current = Math.max(
        persistedLocalRevision.current,
        savingLocalRevision,
      );
      retryDelay.current = 1_000;
      consecutiveSaveFailures.current = 0;
    } catch (error: unknown) {
      consecutiveSaveFailures.current += 1;
      if (shouldReportPersistenceError(error, consecutiveSaveFailures.current)) {
        window.dispatchEvent(
          new CustomEvent("atlas-persistence-error", { detail: String(error) }),
        );
      }
      const delay = retryDelay.current;
      retryDelay.current = Math.min(delay * 2, 30_000);
      retryTimer.current = window.setTimeout(() => void persistLatest(), delay);
    } finally {
      saveInFlight.current = false;
      if (savingRevision !== revision.current) {
        if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => void persistLatest(), 0);
      }
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadSnapshot(), getDataDirectory()])
      .then(([stored, dataDirectory]) => {
        const next = stored ? mergeSnapshotDefaults(stored) : defaultSnapshot;
        setSnapshotState(
          dataDirectory
            ? { ...next, settings: { ...next.settings, dataDirectory } }
            : next,
        );
      })
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    latestSnapshot.current = snapshot;
    if (
      shouldSkipNativePersistence(
        nativeSnapshot.current,
        snapshot,
        localRevision.current,
        persistedLocalRevision.current,
      )
    ) {
      nativeSnapshot.current = null;
      return;
    }
    nativeSnapshot.current = null;
    revision.current += 1;
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    const timer = window.setTimeout(() => void persistLatest(), 180);
    return () => window.clearTimeout(timer);
  }, [snapshot, hydrated, persistLatest]);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void syncStartupItems(snapshot.startupItems).catch((error: unknown) => {
        window.dispatchEvent(
          new CustomEvent("atlas-persistence-error", { detail: String(error) }),
        );
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [snapshot.startupItems, hydrated]);

  useEffect(() => {
    document.documentElement.dataset.theme = snapshot.settings.theme;
    document.documentElement.dataset.font = snapshot.settings.fontFamily;
    document.documentElement.style.setProperty(
      "--font-scale",
      String(snapshot.settings.fontScale),
    );
    document.documentElement.dataset.fontSize =
      snapshot.settings.fontScale >= 1.15
        ? "large"
        : snapshot.settings.fontScale <= 0.9
          ? "compact"
          : "standard";
  }, [
    snapshot.settings.theme,
    snapshot.settings.fontFamily,
    snapshot.settings.fontScale,
  ]);

  useEffect(() => {
    let disposeStartup: () => void = () => undefined;
    let disposeClipboard: () => void = () => undefined;
    let disposeFilters: () => void = () => undefined;
    let disposeActivity: () => void = () => undefined;
    let disposeRuntimeRejection: () => void = () => undefined;
    let startupEventRevision = 0;
    void bindStartupResults((startupFailures) => {
      startupEventRevision += 1;
      applyNativeUpdate((current) => ({ ...current, startupFailures }));
      void loadSnapshot().then((latest) => {
        if (!latest?.activity) return;
        applyNativeUpdate((current) => ({ ...current, activity: latest.activity }));
      });
    }).then(async (dispose) => {
      disposeStartup = dispose;
      const revisionBeforeRead = startupEventRevision;
      const latest = await loadSnapshot().catch(() => null);
      if (latest?.startupFailures && revisionBeforeRead === startupEventRevision) {
        applyNativeUpdate((current) => ({
          ...current,
          startupFailures: latest.startupFailures,
        }));
      }
    });
    void bindClipboardHistory((clipboardHistory) => {
      applyNativeUpdate((current) => ({ ...current, clipboardHistory }));
    }).then((dispose) => {
      disposeClipboard = dispose;
    });
    void bindSearchFilters((searchFilters) => {
      applyNativeUpdate((current) => ({
        ...current,
        settings: { ...current.settings, searchFilters },
      }));
    }).then((dispose) => {
      disposeFilters = dispose;
    });
    void bindActivity((activity) => {
      applyNativeUpdate((current) => ({ ...current, activity }));
    }).then((dispose) => {
      disposeActivity = dispose;
    });
    void bindRuntimeSettingsRejected(({ tools, shortcuts, error }) => {
      applyNativeUpdate((current) => ({
        ...current,
        tools,
        settings: { ...current.settings, shortcuts },
      }));
      window.dispatchEvent(
        new CustomEvent("atlas-runtime-settings-error", { detail: error }),
      );
    }).then((dispose) => {
      disposeRuntimeRejection = dispose;
    });
    return () => {
      disposeStartup();
      disposeClipboard();
      disposeFilters();
      disposeActivity();
      disposeRuntimeRejection();
    };
  }, [applyNativeUpdate]);

  const setToolEnabled = useCallback((tool: ToolId, enabled: boolean) => {
    setSnapshot((current) => ({
      ...current,
      tools: { ...current.tools, [tool]: { enabled } },
    }));
  }, []);

  const addStartupItem = useCallback((item: StartupItem) => {
    setSnapshot((current) => ({
      ...current,
      startupItems: [
        ...current.startupItems,
        { ...item, order: current.startupItems.length },
      ],
    }));
  }, []);

  const updateStartupItem = useCallback(
    (id: string, patch: Partial<StartupItem>) => {
      setSnapshot((current) => ({
        ...current,
        startupItems: current.startupItems.map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      }));
    },
    [],
  );

  const removeStartupItem = useCallback((id: string) => {
    setSnapshot((current) => ({
      ...current,
      startupItems: current.startupItems
        .filter((item) => item.id !== id)
        .map((item, order) => ({ ...item, order })),
      startupScenes: current.startupScenes.map((scene) => ({
        ...scene,
        itemIds: scene.itemIds.filter((itemId) => itemId !== id),
      })),
    }));
  }, []);

  const upsertPrompt = useCallback(
    (entry: Partial<PromptEntry> & { title: string; content: string }) => {
      setSnapshot((current) => {
        const existing = entry.id
          ? current.prompts.find((prompt) => prompt.id === entry.id)
          : undefined;
        const prompt: PromptEntry = {
          id: existing?.id ?? newId("prompt"),
          title: entry.title,
          content: entry.content,
          category: entry.category ?? existing?.category ?? "未分类",
          tags: entry.tags ?? existing?.tags ?? [],
          note: entry.note ?? existing?.note ?? "",
          favorite: entry.favorite ?? existing?.favorite ?? false,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        return {
          ...current,
          prompts: existing
            ? current.prompts.map((item) => (item.id === prompt.id ? prompt : item))
            : [prompt, ...current.prompts],
        };
      });
    },
    [],
  );

  const removePrompt = useCallback((id: string) => {
    setSnapshot((current) => ({
      ...current,
      prompts: current.prompts.filter((prompt) => prompt.id !== id),
    }));
  }, []);

  const upsertQuickLink = useCallback(
    (entry: Omit<QuickLink, "id"> & { id?: string }) => {
      setSnapshot((current) => {
        const quickLink: QuickLink = {
          ...entry,
          id: entry.id ?? newId("link"),
        };
        const exists = current.quickLinks.some((item) => item.id === quickLink.id);
        return {
          ...current,
          quickLinks: exists
            ? current.quickLinks.map((item) =>
                item.id === quickLink.id ? quickLink : item,
              )
            : [quickLink, ...current.quickLinks],
        };
      });
    },
    [],
  );

  const removeQuickLink = useCallback((id: string) => {
    setSnapshot((current) => ({
      ...current,
      quickLinks: current.quickLinks.filter((item) => item.id !== id),
    }));
  }, []);

  const setDataDirectory = useCallback((dataDirectory: string) => {
    setSnapshot((current) => ({
      ...current,
      settings: { ...current.settings, dataDirectory },
    }));
  }, []);

  const setTheme = useCallback((theme: "light" | "dark") => {
    setSnapshot((current) => ({
      ...current,
      settings: { ...current.settings, theme, activeCustomThemeId: "" },
    }));
  }, []);

  const setSetting = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSnapshot((current) => ({
        ...current,
        settings: { ...current.settings, [key]: value },
      }));
    },
    [],
  );

  const setSearchFilters = useCallback((searchFilters: SearchFilters) => {
    setSnapshot((current) => ({
      ...current,
      settings: { ...current.settings, searchFilters },
    }));
  }, []);

  const recordSearch = useCallback((query: string) => {
    void recordActivity("search", query);
  }, []);

  const recordCopy = useCallback((source: "prompt" | "clipboard" | "path") => {
    void recordActivity("copy", source);
  }, []);

  const setClipboardHistory = useCallback((clipboardHistory: ClipboardEntry[]) => {
    setSnapshot((current) => ({ ...current, clipboardHistory }));
  }, []);

  const clearStartupFailures = useCallback(() => {
    setSnapshot((current) => ({ ...current, startupFailures: [] }));
    void clearNativeStartupFailures().catch((error: unknown) => {
      window.dispatchEvent(
        new CustomEvent("atlas-persistence-error", { detail: String(error) }),
      );
    });
  }, []);

  return useMemo(
    () => ({
      hydrated,
      snapshot,
      setSnapshot,
      setToolEnabled,
      addStartupItem,
      updateStartupItem,
      removeStartupItem,
      upsertPrompt,
      removePrompt,
      upsertQuickLink,
      removeQuickLink,
      setDataDirectory,
      setTheme,
      setSetting,
      setSearchFilters,
      recordSearch,
      recordCopy,
      setClipboardHistory,
      clearStartupFailures,
    }),
    [
      hydrated,
      snapshot,
      setToolEnabled,
      addStartupItem,
      updateStartupItem,
      removeStartupItem,
      upsertPrompt,
      removePrompt,
      upsertQuickLink,
      removeQuickLink,
      setDataDirectory,
      setTheme,
      setSetting,
      setSearchFilters,
      recordSearch,
      recordCopy,
      setClipboardHistory,
      clearStartupFailures,
    ],
  );
}
