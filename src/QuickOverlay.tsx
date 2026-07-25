import { Clipboard, FileText, Image as ImageIcon, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ResultGlyph } from "./components";
import { SearchQueryInput } from "./SearchQueryInput";
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
  copyText,
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

export default function QuickOverlay({ mode }: { mode: OverlayMode }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [inputResetSignal, setInputResetSignal] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [filters, setFilters] = useState<SearchFilters>({
    kind: "all",
    extension: "",
    drive: "",
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const lastRecordedQuery = useRef("");
  const requestSequence = useRef(0);
  const meta = modeMeta[mode];
  const Icon = meta.icon;

  useEffect(() => {
    document.documentElement.dataset.overlay = "true";
    const refreshSnapshot = () => void loadSnapshot().then((stored) => {
      if (!stored) return;
      const next = mergeSnapshotDefaults(stored);
      setSnapshot(next);
      setFilters(next.settings.searchFilters);
    });
    refreshSnapshot();
    let unlistenFocus: (() => void) | undefined;
    let unlistenClipboard: (() => void) | undefined;
    let unlistenFilters: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("atlas-overlay-focus", () => {
        setQuery("");
        setInputResetSignal((value) => value + 1);
        setResults([]);
        lastRecordedQuery.current = "";
        refreshSnapshot();
        window.setTimeout(() => inputRef.current?.focus(), 30);
      }).then((dispose) => {
        unlistenFocus = dispose;
      }),
    );
    void bindClipboardHistory((clipboardHistory) => {
      setSnapshot((current) => (current ? { ...current, clipboardHistory } : current));
    }).then((dispose) => {
      unlistenClipboard = dispose;
    });
    void bindSearchFilters(setFilters).then((dispose) => {
      unlistenFilters = dispose;
    });
    return () => {
      delete document.documentElement.dataset.overlay;
      unlistenFocus?.();
      unlistenClipboard?.();
      unlistenFilters?.();
    };
  }, []);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    if (mode !== "search" || !query.trim()) {
      setResults([]);
      return;
    }
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
      </label>
      {mode === "search" ? (
        <div className="quick-filter-row">
          <select
            value={filters.kind}
            onChange={(event) =>
              updateFilters({ ...filters, kind: event.target.value as SearchFilters["kind"] })
            }
          >
            <option value="all">全部类型</option>
            <option value="link">快捷链接</option>
            <option value="app">应用</option>
            <option value="folder">文件夹</option>
            <option value="file">文件</option>
          </select>
          <input
            value={filters.extension}
            onChange={(event) => updateFilters({ ...filters, extension: event.target.value })}
            placeholder="扩展名，如 pdf"
          />
          <input
            value={filters.drive}
            onChange={(event) => updateFilters({ ...filters, drive: event.target.value })}
            placeholder="磁盘，如 D:"
          />
        </div>
      ) : null}
      <section className="quick-results">
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
                  <button key={entry.id} onClick={() => void restoreClipboardAndClose(entry)}>
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
                );
              })}
        {query && mode === "search" && !results.length ? (
          <div className="quick-empty">未找到匹配内容，索引可能仍在构建中。</div>
        ) : null}
      </section>
    </main>
  );
}
