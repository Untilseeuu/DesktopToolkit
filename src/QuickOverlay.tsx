import { Clipboard, FileText, Image as ImageIcon, LoaderCircle, Search, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ResultGlyph } from "./components";
import {
  installCustomFont,
  installTheme,
  readAppearancePreview,
  type AppearancePreview,
} from "./appearance";
import { SearchQueryInput } from "./SearchQueryInput";
import { SearchFilterControls } from "./SearchFilterControls";
import {
  buildQuickLinkResults,
  clipboardEntryKind,
  clipboardEntrySearchText,
  filterPrompts,
  filterSearchResults,
  mergeSnapshotDefaults,
  rankSearchResults,
} from "./domain";
import {
  activateClipboardEntry,
  bindClipboardHistory,
  bindSearchFilters,
  bindSnapshotUpdated,
  copyText,
  deleteClipboardEntry,
  getAppIcons,
  hideOverlay,
  invokeNative,
  loadSnapshot,
  openTarget,
  recordActivity,
  searchNative,
} from "./native";
import type {
  AppSnapshot,
  ClipboardEntry,
  SearchFilters,
  SearchResult,
} from "./types";

type OverlayMode = "search" | "prompts" | "clipboard";

const modeMeta = {
  search: { title: "全局搜索", placeholder: "搜索所有磁盘中的应用、文件或文件夹", icon: Search },
  prompts: { title: "提示词速查", placeholder: "模糊搜索标题、内容、分类或标签", icon: Sparkles },
  clipboard: { title: "剪贴板历史", placeholder: "搜索最近复制的内容", icon: Clipboard },
} as const;

export default function QuickOverlay({ mode: initialMode }: { mode: OverlayMode }) {
  const [mode, setMode] = useState<OverlayMode>(initialMode);
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [appearancePreview, setAppearancePreview] =
    useState<AppearancePreview | null>(() => readAppearancePreview());
  const [query, setQuery] = useState("");
  const [inputResetSignal, setInputResetSignal] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>({
    kind: "all",
    extension: "",
    drive: "",
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const lastRecordedQuery = useRef("");
  const requestSequence = useRef(0);
  const snapshotRequestSequence = useRef(0);
  const clipboardRevision = useRef(0);
  const pendingClipboardHistory = useRef<ClipboardEntry[] | null>(null);
  const meta = modeMeta[mode];
  const Icon = meta.icon;
  const appearanceSettings = snapshot?.settings ?? appearancePreview;
  const customFont = appearanceSettings?.customFonts.find(
    (font) => font.id === appearanceSettings.activeCustomFontId,
  );
  const customTheme = appearanceSettings?.customThemes.find(
    (theme) => theme.id === appearanceSettings.activeCustomThemeId,
  );

  useLayoutEffect(() => installCustomFont(customFont?.path), [customFont]);
  useLayoutEffect(() => {
    if (!appearanceSettings) return;
    const root = document.documentElement;
    root.dataset.font = appearanceSettings.fontFamily;
    root.style.setProperty("--font-scale", String(appearanceSettings.fontScale));
    const cleanup = installTheme(customTheme, appearanceSettings.theme);
    return () => {
      cleanup();
      root.style.removeProperty("--font-scale");
    };
  }, [
    customTheme,
    appearanceSettings?.fontFamily,
    appearanceSettings?.fontScale,
    appearanceSettings?.theme,
  ]);

  useEffect(() => {
    const refresh = () => setAppearancePreview(readAppearancePreview());
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.overlay = "true";
    let disposed = false;
    let snapshotRetryTimer: number | undefined;
    let snapshotRetryDelay = 120;
    const loadLatestSnapshot = () =>
      Promise.race([
        loadSnapshot(),
        new Promise<never>((_, reject) => {
          window.setTimeout(
            () => reject(new Error("snapshot read timed out")),
            650,
          );
        }),
      ]);
    const refreshSnapshot = () => {
      const requestId = ++snapshotRequestSequence.current;
      const revisionBeforeRead = clipboardRevision.current;
      void loadLatestSnapshot()
        .then((stored) => {
          if (
            !stored ||
            disposed ||
            requestId !== snapshotRequestSequence.current
          ) {
            return;
          }
          let next = mergeSnapshotDefaults(stored);
          if (
            revisionBeforeRead !== clipboardRevision.current &&
            pendingClipboardHistory.current
          ) {
            next = {
              ...next,
              clipboardHistory: pendingClipboardHistory.current,
            };
          }
          pendingClipboardHistory.current = null;
          setSnapshot(next);
          setFilters(next.settings.searchFilters);
          snapshotRetryDelay = 120;
          if (snapshotRetryTimer !== undefined) {
            window.clearTimeout(snapshotRetryTimer);
            snapshotRetryTimer = undefined;
          }
        })
        .catch(() => {
          if (disposed || requestId !== snapshotRequestSequence.current) return;
          if (snapshotRetryTimer !== undefined) {
            window.clearTimeout(snapshotRetryTimer);
          }
          snapshotRetryTimer = window.setTimeout(() => {
            snapshotRetryTimer = undefined;
            refreshSnapshot();
          }, snapshotRetryDelay);
          snapshotRetryDelay = Math.min(snapshotRetryDelay * 2, 1_500);
        });
    };
    let unlistenFocus: (() => void) | undefined;
    let unlistenMode: (() => void) | undefined;
    let unlistenClipboard: (() => void) | undefined;
    let unlistenFilters: (() => void) | undefined;
    let unlistenSnapshot: (() => void) | undefined;
    let focusTimer: number | undefined;
    let receivedModeEvent = false;
    let modeRequestSequence = 0;
    const applyMode = (nextMode: unknown) => {
      if (!["search", "prompts", "clipboard"].includes(String(nextMode))) return;
      modeRequestSequence += 1;
      setMode(nextMode as OverlayMode);
      setQuery("");
      setInputResetSignal((value) => value + 1);
      setResults([]);
      lastRecordedQuery.current = "";
    };
    const reconcileMode = async () => {
      const requestId = ++modeRequestSequence;
      const latestMode = await invokeNative<OverlayMode>("get_quick_overlay_mode");
      if (!disposed && requestId === modeRequestSequence && latestMode) {
        applyMode(latestMode);
      }
    };
    const handleBrowserFocus = () => {
      void reconcileMode();
      refreshSnapshot();
    };
    window.addEventListener("focus", handleBrowserFocus);
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void Promise.all([
        listen("atlas-overlay-focus", () => {
          void reconcileMode();
          setQuery("");
          setInputResetSignal((value) => value + 1);
          setResults([]);
          lastRecordedQuery.current = "";
          refreshSnapshot();
          if (focusTimer !== undefined) window.clearTimeout(focusTimer);
          focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30);
        }),
        listen<string>("atlas-overlay-mode", (event) => {
          receivedModeEvent = true;
          applyMode(event.payload);
        }),
      ]).then(async ([disposeFocus, disposeMode]) => {
        if (disposed) {
          disposeFocus();
          disposeMode();
          return;
        }
        unlistenFocus = disposeFocus;
        unlistenMode = disposeMode;
        const latestMode = await invokeNative<OverlayMode>("get_quick_overlay_mode");
        if (!disposed && !receivedModeEvent && latestMode) applyMode(latestMode);
      });
    });
    void bindClipboardHistory((clipboardHistory) => {
      clipboardRevision.current += 1;
      pendingClipboardHistory.current = clipboardHistory;
      setSnapshot((current) => (current ? { ...current, clipboardHistory } : current));
    }).then((dispose) => {
      if (disposed) dispose();
      else {
        unlistenClipboard = dispose;
        refreshSnapshot();
      }
    });
    void bindSearchFilters(setFilters).then((dispose) => {
      if (disposed) dispose();
      else unlistenFilters = dispose;
    });
    void bindSnapshotUpdated(refreshSnapshot).then((dispose) => {
      if (disposed) dispose();
      else {
        unlistenSnapshot = dispose;
        refreshSnapshot();
      }
    });
    return () => {
      disposed = true;
      window.removeEventListener("focus", handleBrowserFocus);
      delete document.documentElement.dataset.overlay;
      unlistenFocus?.();
      unlistenMode?.();
      unlistenClipboard?.();
      unlistenFilters?.();
      unlistenSnapshot?.();
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      if (snapshotRetryTimer !== undefined) window.clearTimeout(snapshotRetryTimer);
    };
  }, []);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    if (mode !== "search" || !query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    void searchNative(query, filters)
      .then((items) => {
        if (requestId !== requestSequence.current) return;
        const links = buildQuickLinkResults(snapshot?.quickLinks ?? [], query);
        const ranked = rankSearchResults(
          filterSearchResults([...links, ...(items ?? [])], filters),
          query,
        );
        setResults(ranked);
        const appPaths = ranked
          .filter((result) => result.kind === "app")
          .slice(0, 16)
          .map((result) => result.path);
        void getAppIcons(appPaths)
          .then((icons) => {
            if (requestId !== requestSequence.current) return;
            if (!Object.keys(icons).length) return;
            setResults((current) => {
              let changed = false;
              const next = current.map((result) => {
                const iconDataUrl = icons[result.path];
                if (!iconDataUrl || iconDataUrl === result.iconDataUrl) return result;
                changed = true;
                return { ...result, iconDataUrl };
              });
              return changed ? next : current;
            });
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (requestId === requestSequence.current) setResults([]);
      })
      .finally(() => {
        if (requestId === requestSequence.current) setSearching(false);
      });
  }, [filters, mode, query, snapshot?.quickLinks]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void hideOverlay(mode);
      }
      if (event.key === "Enter" && mode === "search" && results[0]) {
        const normalized = query.trim();
        if (normalized && normalized !== lastRecordedQuery.current) {
          lastRecordedQuery.current = normalized;
          void recordActivity("search", normalized);
        }
        void openTarget(results[0].path);
        void hideOverlay(mode);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, query, results]);

  const prompts = useMemo(
    () => filterPrompts(snapshot?.prompts ?? [], query),
    [query, snapshot?.prompts],
  );
  const clipboard = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (snapshot?.clipboardHistory ?? []).filter(
      (entry) =>
        !normalized ||
        clipboardEntrySearchText(entry).toLocaleLowerCase().includes(normalized),
    );
  }, [query, snapshot?.clipboardHistory]);
  const displayedResults = results.slice(0, 40);
  const displayedPrompts = prompts.slice(0, 60);
  const displayedClipboard = clipboard.slice(0, 60);

  const updateFilters = (next: SearchFilters) => {
    setFilters(next);
    void invokeNative("set_search_filters", { filters: next });
  };

  const copyAndClose = async (text: string) => {
    await copyText(text);
    await recordActivity("copy", mode === "prompts" ? "prompt" : "clipboard");
    await hideOverlay(mode);
  };

  const restoreClipboardAndClose = async (entry: ClipboardEntry) => {
    await activateClipboardEntry(entry.id, true);
    await recordActivity("copy", "clipboard");
    await hideOverlay(mode);
  };

  const openSearchResult = (result: SearchResult) => {
    const normalized = query.trim();
    if (normalized && normalized !== lastRecordedQuery.current) {
      lastRecordedQuery.current = normalized;
      void recordActivity("search", normalized);
    }
    void openTarget(result.path);
    void hideOverlay(mode);
  };

  return (
    <main className="quick-overlay">
      <header className="quick-overlay-header">
        <span className="quick-overlay-mark" data-tauri-drag-region><Icon size={18} /></span>
        <strong data-tauri-drag-region>{meta.title}</strong>
        <kbd data-tauri-drag-region>ESC</kbd>
        <button type="button" onClick={() => void hideOverlay(mode)} aria-label="关闭">
          <X size={16} />
        </button>
      </header>
      <label className="quick-overlay-search">
        <Search size={21} />
        <SearchQueryInput
          ref={inputRef}
          autoFocus
          onSearchChange={setQuery}
          resetSignal={inputResetSignal}
          placeholder={meta.placeholder}
          onSubmit={
            mode === "search"
              ? (inputQuery) => {
                  if (inputQuery === query && results[0]) {
                    openSearchResult(results[0]);
                  } else {
                    setQuery(inputQuery);
                  }
                }
              : undefined
          }
        />
        {searching ? (
          <LoaderCircle
            className="search-loading-indicator"
            size={17}
            aria-label="正在搜索"
            role="status"
          />
        ) : null}
      </label>
      {mode === "search" ? (
        <SearchFilterControls
          className="quick-filter-row"
          filters={filters}
          onChange={updateFilters}
        />
      ) : null}
      <section
        className={`quick-results ${
          snapshot &&
          ((mode === "prompts" && !displayedPrompts.length) ||
            (mode === "clipboard" && !displayedClipboard.length))
            ? "is-empty"
            : ""
        }`}
      >
        {!snapshot && mode !== "search" ? (
          <div className="quick-empty">正在同步最新内容…</div>
        ) : null}
        {mode === "search"
          ? displayedResults.map((result) => (
              <button
                key={result.id}
                onClick={() => openSearchResult(result)}
              >
                <span className={`quick-kind ${result.kind}`}>
                  <ResultGlyph result={result} size={17} />
                </span>
                <span>
                  <strong>{result.name}</strong>
                  <small>
                    {result.description ??
                      (result.path.startsWith("shell:AppsFolder\\")
                        ? "Windows 应用"
                        : result.path)}
                  </small>
                </span>
                <em>{result.kind === "link" ? "链接" : result.kind === "app" ? "应用" : result.kind === "folder" ? "文件夹" : "文件"}</em>
              </button>
            ))
          : mode === "prompts"
            ? displayedPrompts.map((prompt) => (
                <button key={prompt.id} onClick={() => void copyAndClose(prompt.content)}>
                  <span className="quick-kind prompt"><Sparkles size={17} /></span>
                  <span><strong>{prompt.title}</strong><small>{prompt.content}</small></span>
                  <em>{prompt.category}</em>
                </button>
              ))
            : displayedClipboard.map((entry: ClipboardEntry) => {
                const kind = clipboardEntryKind(entry);
                return (
                  <div className="quick-clipboard-row" key={entry.id}>
                    <button onClick={() => void restoreClipboardAndClose(entry)}>
                      <span className={`quick-kind clipboard ${kind}`}>
                      {kind === "image" ? <ImageIcon size={17} /> : <FileText size={17} />}
                    </span>
                    {kind === "image" ? (
                      <span className="quick-clipboard-image">
                        {entry.previewDataUrl ? (
                          <img src={entry.previewDataUrl} alt="剪贴板图片预览" />
                        ) : (
                          <span className="quick-image-placeholder"><ImageIcon size={20} /></span>
                        )}
                        <span>
                          <strong>图片</strong>
                          <small>{entry.width ?? 0} × {entry.height ?? 0} · {new Date(entry.copiedAt).toLocaleString("zh-CN")}</small>
                        </span>
                      </span>
                    ) : (
                      <span>
                        <strong>{(entry.text ?? "").slice(0, 80)}</strong>
                        <small>{new Date(entry.copiedAt).toLocaleString("zh-CN")}</small>
                      </span>
                    )}
                      <em>{kind === "image" ? "图片" : "文字"}</em>
                    </button>
                    <button
                      type="button"
                      className="quick-delete"
                      aria-label="删除这条剪贴板记录"
                      onClick={() => {
                        void deleteClipboardEntry(entry.id).then((clipboardHistory) => {
                          setSnapshot((current) =>
                            current ? { ...current, clipboardHistory } : current,
                          );
                        });
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
        {query && mode === "search" && !results.length ? (
          <div className="quick-empty">未找到匹配内容，索引可能仍在构建中。</div>
        ) : null}
        {snapshot && mode === "prompts" && !displayedPrompts.length ? (
          <div className="quick-empty">
            {query ? "没有匹配的提示词。" : "还没有提示词。"}
          </div>
        ) : null}
        {snapshot && mode === "clipboard" && !displayedClipboard.length ? (
          <div className="quick-empty">
            {query ? "没有匹配的剪贴板记录。" : "还没有剪贴板记录。"}
          </div>
        ) : null}
      </section>
    </main>
  );
}
