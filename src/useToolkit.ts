import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeSnapshotDefaults, reorderItems } from "./domain";
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
    shortcuts: {
      search: "Alt+Space",
      prompts: "Alt+Shift+P",
      clipboard: "Alt+Shift+V",
    },
    dataDirectory: "应用目录\\data",
    indexRoots: ["*"],
    excludedPatterns: ["node_modules", ".git", "Windows\\WinSxS"],
    searchFilters: { kind: "all", extension: "", drive: "" },
    clipboardLimit: 50,
    launchAtLogin: true,
    loginSceneId: "default-scene",
  },
};

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useToolkit() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(defaultSnapshot);
  const [hydrated, setHydrated] = useState(false);
  const latestSnapshot = useRef(snapshot);
  const revision = useRef(0);
  const saveInFlight = useRef(false);
  const retryTimer = useRef<number | null>(null);
  const retryDelay = useRef(1_000);

  const persistLatest = useCallback(async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    const savingRevision = revision.current;
    try {
      await saveSnapshot(latestSnapshot.current);
      retryDelay.current = 1_000;
    } catch (error: unknown) {
      window.dispatchEvent(
        new CustomEvent("atlas-persistence-error", { detail: String(error) }),
      );
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
        setSnapshot(
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
      setSnapshot((current) => ({ ...current, startupFailures }));
      void loadSnapshot().then((latest) => {
        if (!latest?.activity) return;
        setSnapshot((current) => ({ ...current, activity: latest.activity }));
      });
    }).then(async (dispose) => {
      disposeStartup = dispose;
      const revisionBeforeRead = startupEventRevision;
      const latest = await loadSnapshot().catch(() => null);
      if (latest?.startupFailures && revisionBeforeRead === startupEventRevision) {
        setSnapshot((current) => ({
          ...current,
          startupFailures: latest.startupFailures,
        }));
      }
    });
    void bindClipboardHistory((clipboardHistory) => {
      setSnapshot((current) => ({ ...current, clipboardHistory }));
    }).then((dispose) => {
      disposeClipboard = dispose;
    });
    void bindSearchFilters((searchFilters) => {
      setSnapshot((current) => ({
        ...current,
        settings: { ...current.settings, searchFilters },
      }));
    }).then((dispose) => {
      disposeFilters = dispose;
    });
    void bindActivity((activity) => {
      setSnapshot((current) => ({ ...current, activity }));
    }).then((dispose) => {
      disposeActivity = dispose;
    });
    void bindRuntimeSettingsRejected(({ tools, shortcuts, error }) => {
      setSnapshot((current) => ({
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
  }, []);

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

  const reorderStartupItems = useCallback((fromId: string, toId: string) => {
    setSnapshot((current) => {
      const fromIndex = current.startupItems.findIndex((item) => item.id === fromId);
      const toIndex = current.startupItems.findIndex((item) => item.id === toId);
      return {
        ...current,
        startupItems: reorderItems(current.startupItems, fromIndex, toIndex),
      };
    });
  }, []);

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
      settings: { ...current.settings, theme },
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

  const addIndexRoot = useCallback((root: string) => {
    setSnapshot((current) => ({
      ...current,
      settings: {
        ...current.settings,
        indexRoots: Array.from(
          new Set([
            ...current.settings.indexRoots.filter((item) => item !== "*"),
            root,
          ]),
        ),
      },
    }));
  }, []);

  const recordSearch = useCallback((query: string) => {
    setSnapshot((current) => ({
      ...current,
      activity: {
        ...current.activity,
        searches: [
          ...current.activity.searches.slice(-199),
          { at: Date.now(), query },
        ],
      },
    }));
    void recordActivity("search", query);
  }, []);

  const recordCopy = useCallback((source: "prompt" | "clipboard" | "path") => {
    setSnapshot((current) => ({
      ...current,
      activity: {
        ...current.activity,
        copies: [...current.activity.copies.slice(-199), { at: Date.now(), source }],
      },
    }));
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
      reorderStartupItems,
      removeStartupItem,
      upsertPrompt,
      removePrompt,
      upsertQuickLink,
      removeQuickLink,
      setDataDirectory,
      setTheme,
      setSetting,
      setSearchFilters,
      addIndexRoot,
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
      reorderStartupItems,
      removeStartupItem,
      upsertPrompt,
      removePrompt,
      upsertQuickLink,
      removeQuickLink,
      setDataDirectory,
      setTheme,
      setSetting,
      setSearchFilters,
      addIndexRoot,
      recordSearch,
      recordCopy,
      setClipboardHistory,
      clearStartupFailures,
    ],
  );
}
