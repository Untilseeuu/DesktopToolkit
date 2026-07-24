import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  AppWindow,
  ArrowUpRight,
  BookOpenText,
  Box,
  Check,
  ChevronDown,
  Clipboard,
  Clock3,
  Command,
  Copy,
  Database,
  File,
  FileText,
  FileSearch,
  Folder,
  FolderOpen,
  GripVertical,
  HardDrive,
  Heart,
  Home,
  Info,
  Image as ImageIcon,
  Keyboard,
  Layers3,
  LayoutGrid,
  Link2,
  ListFilter,
  Moon,
  MoreHorizontal,
  Plus,
  Power,
  Rocket,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowButton,
  EmptyState,
  ResultGlyph,
  SectionHeading,
  Switch,
  ToolBadge,
} from "./components";
import {
  calculateOverviewMetrics,
  buildQuickLinkResults,
  clipboardEntryKind,
  clipboardEntrySearchText,
  filterPrompts,
  filterPromptsByCategory,
  filterSearchResults,
  rankSearchResults,
  selectSearchResults,
} from "./domain";
import {
  activateClipboardEntry,
  bindNativeSearchShortcut,
  chooseDirectory,
  chooseExecutable,
  copyText,
  getSearchIndexCount,
  getSearchIndexStatus,
  getAppIcons,
  invokeNative,
  launchStartupItems,
  openTarget,
  rebuildSearchIndex,
  searchNative,
} from "./native";
import QuickOverlay from "./QuickOverlay";
import type {
  NavId,
  PromptEntry,
  QuickLink,
  SearchResult,
  ToolId,
} from "./types";
import { useToolkit } from "./useToolkit";

const navItems: Array<{ id: NavId; label: string; icon: typeof Home }> = [
  { id: "overview", label: "总览", icon: LayoutGrid },
  { id: "startup", label: "启动编排", icon: Rocket },
  { id: "search", label: "全局搜索", icon: Search },
  { id: "prompts", label: "提示词库", icon: BookOpenText },
  { id: "clipboard", label: "剪贴板历史", icon: Clipboard },
];

const toolMeta: Record<
  ToolId,
  {
    title: string;
    caption: string;
    number: string;
    icon: typeof Search;
    tint: string;
  }
> = {
  startup: {
    title: "启动编排",
    caption: "让每天的工作环境按顺序就位",
    number: "01",
    icon: Rocket,
    tint: "vermillion",
  },
  search: {
    title: "全局搜索",
    caption: "从键盘抵达电脑里的任何地方",
    number: "02",
    icon: Search,
    tint: "ink",
  },
  prompts: {
    title: "提示词库",
    caption: "把高质量表达变成可复用资产",
    number: "03",
    icon: BookOpenText,
    tint: "moss",
  },
  clipboard: {
    title: "剪贴板历史",
    caption: "跨越重启找回最近复制过的文本",
    number: "04",
    icon: Clipboard,
    tint: "vermillion",
  },
};

const demoSearchResults: SearchResult[] = [
  {
    id: "demo-1",
    name: "Visual Studio Code",
    path: "C:\\Users\\Atlas\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    kind: "app",
  },
  {
    id: "demo-2",
    name: "项目说明.md",
    path: "D:\\Workspace\\Atlas\\项目说明.md",
    kind: "file",
  },
  {
    id: "demo-3",
    name: "DesktopToolkit",
    path: "D:\\Programming\\DesktopToolkit",
    kind: "folder",
  },
];

export default function App() {
  const overlay = new URLSearchParams(window.location.search).get("overlay");
  if (overlay === "search" || overlay === "prompts" || overlay === "clipboard") {
    return <QuickOverlay mode={overlay} />;
  }
  return <MainApp />;
}

function MainApp() {
  const model = useToolkit();
  const [activeNav, setActiveNav] = useState<NavId>("overview");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const showSearch = () => setActiveNav("search");
    const showPersistenceError = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setToast(`保存失败：${detail}`);
    };
    const showRuntimeSettingsError = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setToast(`工具状态已保存，但部分系统设置未生效：${detail}`);
    };
    let unlisten: (() => void) | undefined;
    window.addEventListener("atlas-show-search", showSearch);
    window.addEventListener("atlas-persistence-error", showPersistenceError);
    window.addEventListener(
      "atlas-runtime-settings-error",
      showRuntimeSettingsError,
    );
    void bindNativeSearchShortcut().then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      window.removeEventListener("atlas-show-search", showSearch);
      window.removeEventListener("atlas-persistence-error", showPersistenceError);
      window.removeEventListener(
        "atlas-runtime-settings-error",
        showRuntimeSettingsError,
      );
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!model.hydrated) {
    return (
      <div className="app-loading" role="status">
        <span className="brand-mark"><Layers3 size={20} /></span>
        <strong>正在载入 Atlas 工作区</strong>
      </div>
    );
  }

  const page = (() => {
    if (
      activeNav !== "overview" &&
      activeNav !== "settings" &&
      !model.snapshot.tools[activeNav].enabled
    ) {
      return (
        <PausedToolPage
          tool={activeNav}
          onEnable={() => model.setToolEnabled(activeNav, true)}
        />
      );
    }
    switch (activeNav) {
      case "startup":
        return <StartupPage model={model} notify={setToast} />;
      case "search":
        return <SearchPage model={model} notify={setToast} />;
      case "prompts":
        return <PromptsPage model={model} notify={setToast} />;
      case "clipboard":
        return <ClipboardPage model={model} notify={setToast} />;
      case "settings":
        return <EnhancedSettingsPage model={model} notify={setToast} />;
      default:
        return <OverviewPage model={model} navigate={setActiveNav} />;
    }
  })();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setActiveNav("overview")} aria-label="Atlas 首页">
          <span className="brand-mark">
            <Layers3 size={20} />
          </span>
          <span>
            <strong>ATLAS</strong>
            <small>DESKTOP KIT</small>
          </span>
        </button>

        <nav aria-label="主导航">
          <span className="nav-label">工作台</span>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;
            return (
              <button
                type="button"
                key={item.id}
                className={`nav-item ${active ? "active" : ""}`}
                onClick={() => setActiveNav(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.id !== "overview" ? (
                  <i className={model.snapshot.tools[item.id as ToolId].enabled ? "on" : ""} />
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-spacer" />
        <button
          type="button"
          className={`nav-item ${activeNav === "settings" ? "active" : ""}`}
          onClick={() => setActiveNav("settings")}
          aria-label="设置"
        >
          <Settings size={18} />
          <span>设置</span>
        </button>
        <div className="profile-chip">
          <span className="profile-glyph">A</span>
          <span>
            <strong>本地工作区</strong>
            <small>所有数据仅在本机</small>
          </span>
          <MoreHorizontal size={17} />
        </div>
      </aside>

      <main className="main-panel">
        <div className="titlebar-drag" data-tauri-drag-region />
        <AnimatePresence mode="wait">
          <motion.div
            key={activeNav}
            className="page"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
          >
            {page}
          </motion.div>
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {toast ? (
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
          >
            <Check size={16} />
            {toast}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

type ToolkitModel = ReturnType<typeof useToolkit>;

function OverviewPage({
  model,
  navigate,
}: {
  model: ToolkitModel;
  navigate: (nav: NavId) => void;
}) {
  const enabledCount = Object.values(model.snapshot.tools).filter((tool) => tool.enabled).length;
  const metrics = calculateOverviewMetrics(model.snapshot.activity);
  const searchShortcut = model.snapshot.settings.shortcuts.search
    .split("+")
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean);
  return (
    <>
      <header className="overview-hero">
        <div>
          <span className="eyebrow">
            {new Intl.DateTimeFormat("zh-CN", {
              weekday: "long",
              month: "long",
              day: "numeric",
            }).format(new Date())} · 本地时间
          </span>
          <h1>
            让电脑成为
            <br />
            <em>安静的效率机器。</em>
          </h1>
        </div>
        <div className="hero-status">
          <span>系统状态</span>
          <strong>
            <i />
            一切就绪
          </strong>
          <small>{enabledCount} / 4 个工具正在运行</small>
        </div>
      </header>

      <section className="tool-grid" aria-label="工具列表">
        {(Object.keys(toolMeta) as ToolId[]).map((id) => {
          const meta = toolMeta[id];
          const Icon = meta.icon;
          const enabled = model.snapshot.tools[id].enabled;
          const stat =
            id === "startup"
              ? `${model.snapshot.startupItems.filter((item) => item.enabled).length} 个应用`
              : id === "search"
                ? model.snapshot.settings.shortcuts.search.replaceAll("+", " + ")
                : `${model.snapshot.prompts.length} 条收藏`;
          const resolvedStat =
            id === "clipboard"
              ? `${model.snapshot.clipboardHistory.length} 条记录`
              : stat;
          return (
            <motion.article
              className={`tool-card ${meta.tint} ${enabled ? "" : "disabled"}`}
              key={id}
              onClick={() => navigate(id)}
            >
              <div className="tool-card-top">
                <span className="tool-number">{meta.number}</span>
                <Switch
                  checked={enabled}
                  label={meta.title}
                  onChange={(value) => model.setToolEnabled(id, value)}
                />
              </div>
              <div className="tool-icon">
                <Icon size={25} strokeWidth={1.7} />
              </div>
              <h2>{meta.title}</h2>
              <p>{meta.caption}</p>
              <footer>
                <ToolBadge enabled={enabled}>{enabled ? "运行中" : "已暂停"}</ToolBadge>
                <span className="tool-stat">{resolvedStat}</span>
                <ArrowUpRight size={18} />
              </footer>
            </motion.article>
          );
        })}
      </section>

      <section className="activity-strip">
        <div className="activity-heading">
          <span className="eyebrow">QUICK PULSE</span>
          <h3>今日概况</h3>
        </div>
        <div className="metric">
          <strong>
            {metrics.startupLastRunAt
              ? new Date(metrics.startupLastRunAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "尚未运行"}
          </strong>
          <span>启动编排完成</span>
        </div>
        <div className="metric">
          <strong>{metrics.searchCount}</strong>
          <span>今日搜索次数</span>
        </div>
        <div className="metric">
          <strong>{model.snapshot.prompts.length}</strong>
          <span>可复用提示词</span>
        </div>
        <div className="metric">
          <strong>{metrics.copyCount}</strong>
          <span>今日复制次数</span>
        </div>
        <div className="shortcut-tile">
          <Command size={17} />
          <span>快速呼出</span>
          {searchShortcut.map((key, index) => (
            <span className="shortcut-key-part" key={`${key}-${index}`}>
              {index ? <b>+</b> : null}
              <kbd>{key}</kbd>
            </span>
          ))}
        </div>
      </section>
    </>
  );
}

function StartupPage({
  model,
  notify,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
}) {
  const enabled = model.snapshot.tools.startup.enabled;
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const addItem = async () => {
    const item = await chooseExecutable();
    if (!item) return;
    model.addStartupItem(item);
    notify("应用已加入启动队列");
  };

  return (
    <>
      <SectionHeading
        eyebrow="TOOL 01 · STARTUP"
        title="启动编排"
        description="按你的节奏唤醒工作环境，而不是让所有应用争抢开机资源。"
        action={<Switch checked={enabled} onChange={(value) => model.setToolEnabled("startup", value)} label="启动编排" />}
      />
      {model.snapshot.startupFailures?.length ? (
        <div className="startup-failure-banner" role="status">
          <AlertTriangle size={17} />
          <span>
            上次登录时有 {model.snapshot.startupFailures.length} 个应用未能启动：
            {model.snapshot.startupFailures.map((item) => item.name).join("、")}
          </span>
          <button
            type="button"
            aria-label="关闭启动失败提示"
            onClick={model.clearStartupFailures}
          >
            <X size={15} />
          </button>
        </div>
      ) : null}
      <div className="page-toolbar">
        <div className="toolbar-state">
          <Power size={16} />
          <span>{enabled ? "登录 Windows 后自动执行队列" : "启动队列当前暂停"}</span>
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="button secondary"
            disabled={!model.snapshot.startupItems.length}
            onClick={() => {
              void launchStartupItems(model.snapshot.startupItems)
                .then((results) => {
                  model.setSnapshot((current) => ({
                    ...current,
                    activity: { ...current.activity, startupLastRunAt: Date.now() },
                  }));
                  const failed = results.filter((result) => !result.success);
                  notify(
                    failed.length
                      ? `已启动 ${results.length - failed.length} 项，${failed.length} 项失败：${failed
                          .map((item) => item.name)
                          .join("、")}`
                      : `已成功启动 ${results.length} 项`,
                  );
                })
                .catch((error: unknown) => notify(`启动失败：${String(error)}`));
            }}
          >
            <Zap size={16} />
            立即运行
          </button>
          <button type="button" className="button primary" onClick={() => void addItem()}>
            <Plus size={17} />
            添加应用
          </button>
        </div>
      </div>

      <section className="content-card startup-list">
        <div className="list-header">
          <span>应用</span>
          <span>启动延迟</span>
          <span>状态</span>
          <span />
        </div>
        {model.snapshot.startupItems.length ? (
          model.snapshot.startupItems.map((item, index) => (
            <div
              className={`startup-row ${draggedItemId === item.id ? "dragging" : ""}`}
              key={item.id}
              onDragOver={(event) => {
                if (draggedItemId && draggedItemId !== item.id) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedItemId && draggedItemId !== item.id) {
                  model.reorderStartupItems(draggedItemId, item.id);
                }
                setDraggedItemId(null);
              }}
            >
              <button
                type="button"
                className="drag-handle"
                draggable
                aria-label={`拖动 ${item.name} 调整顺序`}
                onDragStart={(event) => {
                  setDraggedItemId(item.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", item.id);
                }}
                onDragEnd={() => setDraggedItemId(null)}
              >
                <GripVertical size={17} />
              </button>
              <span className="app-avatar">{item.name.slice(0, 1).toUpperCase()}</span>
              <div className="startup-main">
                <strong>{item.name}</strong>
                <small title={item.path}>{item.path}</small>
              </div>
              <label className="delay-control">
                <Clock3 size={15} />
                <input
                  aria-label={`${item.name} 启动延迟`}
                  type="number"
                  min={0}
                  max={120}
                  value={item.delaySeconds}
                  onChange={(event) =>
                    model.updateStartupItem(item.id, {
                      delaySeconds: Number(event.target.value),
                    })
                  }
                />
                秒
              </label>
              <Switch
                checked={item.enabled}
                onChange={(value) => model.updateStartupItem(item.id, { enabled: value })}
                label={`${item.name} 启动项`}
              />
              <button
                type="button"
                className="icon-button danger"
                aria-label={`删除 ${item.name}`}
                onClick={() => model.removeStartupItem(item.id)}
              >
                <Trash2 size={17} />
              </button>
              {index < model.snapshot.startupItems.length - 1 ? (
                <span className="sequence-line" />
              ) : null}
            </div>
          ))
        ) : (
          <EmptyState
            icon={<Rocket size={28} />}
            title="启动队列还是空的"
            description="添加每天都会用到的应用，并为它们安排一点呼吸空间。"
            action={
              <button type="button" className="button primary" onClick={() => void addItem()}>
                <Plus size={17} /> 添加第一个应用
              </button>
            }
          />
        )}
      </section>

      <aside className="note-panel">
        <Info size={17} />
        <p>
          Atlas 本身会注册为 Windows 登录启动项。队列中的应用不会被写入系统启动文件夹，因此暂停工具即可一次性停用整个编排。
        </p>
      </aside>
    </>
  );
}

function SearchPage({
  model,
  notify,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
}) {
  const enabled = model.snapshot.tools.search.enabled;
  const filters = model.snapshot.settings.searchFilters;
  const recordSearch = model.recordSearch;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const requestSequence = useRef(0);
  const lastRecordedQuery = useRef("");
  const [indexStatus, setIndexStatus] = useState("idle");

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void invokeNative<string>("get_index_status").then((status) => {
        if (active) setIndexStatus(status ?? "demo");
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      setLoading(true);
      void searchNative(query, filters)
        .then((nativeResults) => {
          if (requestId !== requestSequence.current) return;
          const source = selectSearchResults(nativeResults, demoSearchResults);
          const quickLinks = buildQuickLinkResults(model.snapshot.quickLinks, query);
          const ranked = rankSearchResults(
            filterSearchResults([...quickLinks, ...source], filters),
            query,
          );
          setResults(ranked);
          const appPaths = ranked
            .filter((result) => result.kind === "app")
            .slice(0, 16)
            .map((result) => result.path);
          void getAppIcons(appPaths).then((icons) => {
            if (requestId !== requestSequence.current) return;
            setResults((current) =>
              current.map((result) => ({
                ...result,
                iconDataUrl: icons[result.path] ?? result.iconDataUrl,
              })),
            );
          });
          setSelected(0);
          if (query.trim() && query.trim() !== lastRecordedQuery.current) {
            lastRecordedQuery.current = query.trim();
            recordSearch(query.trim());
          }
        })
        .catch((error: unknown) => {
          if (requestId !== requestSequence.current) return;
          setResults([]);
          notify(`搜索失败：${String(error)}`);
        })
        .finally(() => {
          if (requestId === requestSequence.current) setLoading(false);
        });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [filters, model.snapshot.quickLinks, notify, query, recordSearch]);

  const active = results[selected];
  return (
    <>
      <SectionHeading
        eyebrow="TOOL 02 · FINDER"
        title="全局搜索"
        description="应用、文件与文件夹，在一次按键和几次输入之间抵达。"
        action={
          <Switch
            checked={enabled}
            onChange={(value) => model.setToolEnabled("search", value)}
            label="全局搜索"
          />
        }
      />
      <section className="search-stage">
        <div className="search-box">
          <Search size={22} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索应用、文件或文件夹…"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((value) => Math.min(value + 1, results.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => Math.max(value - 1, 0));
              }
              if (event.key === "Enter" && active) void openTarget(active.path);
            }}
          />
          {query ? (
            <button type="button" className="icon-button" onClick={() => setQuery("")} aria-label="清空搜索">
              <X size={17} />
            </button>
          ) : null}
        </div>
        <div className="search-filter-bar">
          <select
            aria-label="搜索类型"
            value={filters.kind}
            onChange={(event) =>
              model.setSearchFilters({
                ...filters,
                kind: event.target.value as typeof filters.kind,
              })
            }
          >
            <option value="all">全部类型</option>
            <option value="link">快捷链接</option>
            <option value="app">应用</option>
            <option value="folder">文件夹</option>
            <option value="file">文件</option>
          </select>
          <input
            aria-label="文件扩展名"
            value={filters.extension}
            onChange={(event) =>
              model.setSearchFilters({ ...filters, extension: event.target.value })
            }
            placeholder="扩展名：pdf"
          />
          <input
            aria-label="所在磁盘"
            value={filters.drive}
            onChange={(event) =>
              model.setSearchFilters({ ...filters, drive: event.target.value })
            }
            placeholder="磁盘：D:"
          />
          <span>筛选条件会同步到快捷搜索浮窗</span>
        </div>

        <div className="search-layout">
          <div className="results-panel">
            {!query ? (
              <div className="search-idle">
                <div className="radar">
                  <span />
                  <Search size={28} />
                </div>
                <h3>电脑里的东西，都有一条短路可走</h3>
                <p>输入名称或路径片段开始搜索。使用方向键选择，回车打开。</p>
                <div className="search-tips">
                  <span><AppWindow size={15} /> 应用</span>
                  <span><File size={15} /> 文件</span>
                  <span><Folder size={15} /> 文件夹</span>
                </div>
              </div>
            ) : loading ? (
              <div className="loading-lines"><i /><i /><i /></div>
            ) : results.length ? (
              <>
                <div className="result-count">
                  <span>最佳匹配</span>
                  <small>{results.length} 项结果</small>
                </div>
                {results.map((result, index) => {
                  return (
                    <button
                      type="button"
                      className={`result-row ${selected === index ? "selected" : ""}`}
                      key={result.id}
                      onMouseEnter={() => setSelected(index)}
                      onDoubleClick={() => void openTarget(result.path)}
                    >
                      <span className={`result-icon ${result.kind}`}>
                        <ResultGlyph result={result} />
                      </span>
                      <span className="result-text">
                        <strong>{result.name}</strong>
                        <small>
                          {result.description ??
                            (result.path.startsWith("shell:AppsFolder\\")
                              ? "Windows 应用"
                              : result.path)}
                        </small>
                      </span>
                      <span className="kind-label">
                        {result.kind === "link"
                          ? "链接"
                          : result.kind === "app"
                            ? "应用"
                            : result.kind === "file"
                              ? "文件"
                              : "文件夹"}
                      </span>
                      {selected === index ? <kbd>↵</kbd> : null}
                    </button>
                  );
                })}
              </>
            ) : (
              <EmptyState icon={<FileSearch size={28} />} title="没有找到结果" description="换一个更短的关键词，或在设置中添加索引目录。" />
            )}
          </div>
          <aside className="preview-panel">
            {active ? (
              <>
                <span className={`preview-icon ${active.kind}`}>
                  {(() => {
                    return <ResultGlyph result={active} size={32} />;
                  })()}
                </span>
                <h3>{active.name}</h3>
                <p>{active.description ?? active.path}</p>
                <div className="preview-actions">
                  <button className="button primary" onClick={() => void openTarget(active.path)}>
                    <ArrowUpRight size={16} /> 打开
                  </button>
                  {active.kind !== "link" ? (
                    <button
                      className="button secondary"
                      onClick={() => void openTarget(active.path, true)}
                    >
                      <FolderOpen size={16} /> 所在位置
                    </button>
                  ) : null}
                  <button
                    className="button ghost"
                    onClick={() => {
                      void copyText(active.path);
                      model.recordCopy("path");
                      notify("路径已复制");
                    }}
                  >
                    <Copy size={16} /> 复制路径
                  </button>
                </div>
              </>
            ) : (
              <div className="preview-placeholder">
                <Box size={25} />
                <span>选择结果后在这里查看操作</span>
              </div>
            )}
          </aside>
        </div>
      </section>
      <div className="search-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>ENTER</kbd> 打开</span>
        <span><kbd>ESC</kbd> 隐藏</span>
        <span className={`index-health ${indexStatus === "failed" ? "failed" : ""}`}>
          <i />
          {indexStatus === "indexing"
            ? "正在建立索引"
            : indexStatus === "failed"
              ? "索引建立失败"
              : indexStatus === "demo"
                ? "浏览器演示模式"
                : indexStatus === "idle"
                  ? "等待索引任务"
                  : "索引服务正常"}
        </span>
      </div>
    </>
  );
}

function PausedToolPage({
  tool,
  onEnable,
}: {
  tool: ToolId;
  onEnable: () => void;
}) {
  const meta = toolMeta[tool];
  const Icon = meta.icon;
  return (
    <section className="paused-page">
      <span className={`paused-icon ${meta.tint}`}>
        <Icon size={31} />
      </span>
      <span className="eyebrow">TOOL PAUSED</span>
      <h1>{meta.title}已暂停</h1>
      <p>这个工具不会执行后台任务，也不会响应相关操作。已有配置和数据仍会安全保留。</p>
      <button className="button primary" onClick={onEnable}>
        <Power size={16} /> 重新启用
      </button>
    </section>
  );
}

function PromptsPage({
  model,
  notify,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [editing, setEditing] = useState<PromptEntry | "new" | null>(null);
  const categories = useMemo(
    () => Array.from(new Set(model.snapshot.prompts.map((prompt) => prompt.category))).sort(),
    [model.snapshot.prompts],
  );
  const prompts = useMemo(
    () => filterPromptsByCategory(filterPrompts(model.snapshot.prompts, query), category),
    [category, model.snapshot.prompts, query],
  );

  return (
    <>
      <SectionHeading
        eyebrow="TOOL 03 · PROMPTS"
        title="提示词库"
        description="收藏那些真正有效的表达，在需要时一键带走。"
        action={
          <div className="heading-actions">
            <Switch
              checked={model.snapshot.tools.prompts.enabled}
              onChange={(enabled) => model.setToolEnabled("prompts", enabled)}
              label="提示词库"
            />
            <button className="button primary" onClick={() => setEditing("new")}>
              <Plus size={17} /> 新建提示词
            </button>
          </div>
        }
      />
      <div className="library-toolbar">
        <label className="compact-search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、内容或标签" />
        </label>
        <label className="category-filter">
          <ListFilter size={16} />
          <select
            className="filter-button"
            aria-label="提示词分类"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">全部分类</option>
            {categories.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
          <ChevronDown size={15} />
        </label>
        <div className="library-count">{model.snapshot.prompts.length} 条提示词</div>
      </div>
      <section className="prompt-grid">
        {prompts.map((prompt) => (
          <motion.article
            className="prompt-card"
            key={prompt.id}
            onClick={() => setEditing(prompt)}
          >
            <header>
              <span className="category-chip">{prompt.category}</span>
              <button
                className={`favorite-button ${prompt.favorite ? "active" : ""}`}
                aria-label={prompt.favorite ? "取消收藏" : "收藏"}
                onClick={(event) => {
                  event.stopPropagation();
                  model.upsertPrompt({ ...prompt, favorite: !prompt.favorite });
                }}
              >
                <Heart size={16} fill={prompt.favorite ? "currentColor" : "none"} />
              </button>
            </header>
            <h3>{prompt.title}</h3>
            <p>{prompt.content}</p>
            <div className="tag-row">
              {prompt.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}
            </div>
            <footer>
              <small>{new Date(prompt.updatedAt).toLocaleDateString("zh-CN")}</small>
              <button
                className="copy-button"
                onClick={(event) => {
                  event.stopPropagation();
                  void copyText(prompt.content);
                  model.recordCopy("prompt");
                  notify("提示词已复制");
                }}
              >
                <Clipboard size={15} /> 复制
              </button>
            </footer>
          </motion.article>
        ))}
        <button className="new-prompt-card" onClick={() => setEditing("new")}>
          <span><Plus size={22} /></span>
          <strong>新建提示词</strong>
          <small>把刚刚奏效的表达保存下来</small>
        </button>
      </section>
      {editing ? (
        <PromptEditor
          prompt={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={(prompt) => {
            model.upsertPrompt(prompt);
            setEditing(null);
            notify("提示词已保存");
          }}
          onDelete={
            editing === "new"
              ? undefined
              : () => {
                  model.removePrompt(editing.id);
                  setEditing(null);
                  notify("提示词已删除");
                }
          }
        />
      ) : null}
    </>
  );
}

function PromptEditor({
  prompt,
  onClose,
  onSave,
  onDelete,
}: {
  prompt?: PromptEntry;
  onClose: () => void;
  onSave: (entry: Partial<PromptEntry> & { title: string; content: string }) => void;
  onDelete?: () => void;
}) {
  const [title, setTitle] = useState(prompt?.title ?? "");
  const [content, setContent] = useState(prompt?.content ?? "");
  const [category, setCategory] = useState(prompt?.category ?? "通用");
  const [tags, setTags] = useState(prompt?.tags.join(", ") ?? "");

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <motion.div
        className="prompt-editor"
        initial={{ opacity: 0, scale: 0.98, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">{prompt ? "EDIT PROMPT" : "NEW PROMPT"}</span>
            <h2>{prompt ? "编辑提示词" : "记录一条好提示词"}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        </header>
        <label>
          <span>标题</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="给它一个容易找到的名字" autoFocus />
        </label>
        <label>
          <span>提示词内容</span>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="在这里输入完整提示词…" rows={9} />
        </label>
        <div className="form-row">
          <label>
            <span>分类</span>
            <input value={category} onChange={(event) => setCategory(event.target.value)} />
          </label>
          <label>
            <span>标签 <small>逗号分隔</small></span>
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="写作, 分析" />
          </label>
        </div>
        <footer>
          {onDelete ? <button className="button danger" onClick={onDelete}><Trash2 size={16} /> 删除</button> : <span />}
          <div>
            <button className="button secondary" onClick={onClose}>取消</button>
            <button
              className="button primary"
              disabled={!title.trim() || !content.trim()}
              onClick={() =>
                onSave({
                  ...prompt,
                  title: title.trim(),
                  content: content.trim(),
                  category: category.trim() || "未分类",
                  tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
                })
              }
            >
              保存提示词
            </button>
          </div>
        </footer>
      </motion.div>
    </div>
  );
}

function SettingsPage({
  model,
  notify,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
}) {
  const [migrating, setMigrating] = useState(false);
  const changeDirectory = async () => {
    const target = await chooseDirectory();
    if (!target) return;
    setMigrating(true);
    try {
      const result = await invokeNative<string>("migrate_data_directory", { target });
      model.setDataDirectory(result ?? target);
      notify("数据存储位置已更新");
    } catch (error) {
      notify(`迁移失败：${String(error)}`);
    } finally {
      setMigrating(false);
    }
  };

  return (
    <>
      <SectionHeading
        eyebrow="PREFERENCES"
        title="设置"
        description="决定 Atlas 如何融入你的电脑与日常习惯。"
      />
      <div className="settings-layout">
        <section className="settings-section">
          <header><Database size={19} /><div><h2>数据与存储</h2><p>选择数据库、提示词与搜索索引的保存位置。</p></div></header>
          <div className="setting-row storage-row">
            <span className="drive-icon"><HardDrive size={22} /></span>
            <div>
              <strong>当前存储位置</strong>
              <code>{model.snapshot.settings.dataDirectory}</code>
              <small>迁移时会先复制并校验新数据库，失败不会删除原数据。</small>
            </div>
            <button className="button secondary" onClick={() => void changeDirectory()} disabled={migrating} aria-label="更改位置">
              <FolderOpen size={16} /> {migrating ? "正在迁移…" : "更改位置"}
            </button>
          </div>
        </section>

        <section className="settings-section">
          <header><Keyboard size={19} /><div><h2>搜索与快捷键</h2><p>控制全局搜索的呼出方式和索引范围。</p></div></header>
          <div className="setting-row">
            <div><strong>全局快捷键</strong><small>在任何应用中呼出搜索浮窗</small></div>
            <button className="shortcut-editor"><kbd>ALT</kbd><b>+</b><kbd>SPACE</kbd></button>
          </div>
          <div className="setting-row">
            <div><strong>索引位置</strong><small>{model.snapshot.settings.indexRoots.join("、")}</small></div>
            <button className="button secondary"><Plus size={16} /> 添加目录</button>
          </div>
          <div className="setting-row">
            <div><strong>排除规则</strong><small>{model.snapshot.settings.excludedPatterns.join(" · ")}</small></div>
            <ArrowButton>管理规则</ArrowButton>
          </div>
        </section>

        <section className="settings-section">
          <header><Sparkles size={19} /><div><h2>外观</h2><p>选择适合当前环境的界面明暗。</p></div></header>
          <div className="theme-picker">
            <button className={model.snapshot.settings.theme === "light" ? "selected" : ""} onClick={() => model.setTheme("light")}>
              <span className="theme-preview light"><i /><i /><i /></span><Sun size={16} /> 浅色
            </button>
            <button className={model.snapshot.settings.theme === "dark" ? "selected" : ""} onClick={() => model.setTheme("dark")}>
              <span className="theme-preview dark"><i /><i /><i /></span><Moon size={16} /> 深色
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

function ClipboardPage({
  model,
  notify,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const entries = model.snapshot.clipboardHistory.filter(
    (entry) =>
      !normalized ||
      clipboardEntrySearchText(entry).toLocaleLowerCase().includes(normalized),
  );

  return (
    <>
      <SectionHeading
        eyebrow="TOOL 04 · CLIPBOARD"
        title="剪贴板历史"
        description={`最近 ${model.snapshot.settings.clipboardLimit} 条文字或图片会保存在本地，点击任意记录即可重新复制。`}
        action={
          <Switch
            checked={model.snapshot.tools.clipboard.enabled}
            onChange={(enabled) => model.setToolEnabled("clipboard", enabled)}
            label="剪贴板历史"
          />
        }
      />
      <label className="compact-search clipboard-search">
        <Search size={17} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索复制过的文字或图片"
        />
      </label>
      <section className="clipboard-list">
        {entries.length ? (
          entries.map((entry) => {
            const kind = clipboardEntryKind(entry);
            const text = entry.text ?? "";
            return (
              <button
                key={entry.id}
                className={`clipboard-entry ${kind}`}
                onClick={() => {
                  void activateClipboardEntry(entry.id, false).then(() => {
                    model.recordCopy("clipboard");
                    notify(kind === "image" ? "图片已恢复到剪贴板" : "已复制这条历史内容");
                  });
                }}
              >
                <span className={`clipboard-entry-icon ${kind}`}>
                  {kind === "image" ? <ImageIcon size={17} /> : <FileText size={17} />}
                </span>
                {kind === "image" ? (
                  <span className="clipboard-image-content">
                    {entry.previewDataUrl ? (
                      <img src={entry.previewDataUrl} alt="剪贴板图片预览" />
                    ) : (
                      <span className="clipboard-image-placeholder"><ImageIcon size={22} /></span>
                    )}
                    <span>
                      <strong>{entry.width ?? 0} × {entry.height ?? 0}</strong>
                      <small>{new Date(entry.copiedAt).toLocaleString("zh-CN")}</small>
                    </span>
                  </span>
                ) : (
                  <span>
                    <strong>{text.length > 180 ? `${text.slice(0, 180)}…` : text}</strong>
                    <small>{new Date(entry.copiedAt).toLocaleString("zh-CN")}</small>
                  </span>
                )}
                <Copy size={16} />
              </button>
            );
          })
        ) : (
          <EmptyState
            icon={<Clipboard size={28} />}
            title="还没有剪贴板记录"
            description="启用工具后，新复制的文字和图片会自动出现在这里。"
          />
        )}
      </section>
    </>
  );
}

function ShortcutRecorder({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  return (
    <button
      type="button"
      className={`shortcut-recorder ${recording ? "recording" : ""}`}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(event) => {
        if (!recording) return;
        event.preventDefault();
        if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
        const parts = [
          event.ctrlKey ? "Ctrl" : "",
          event.altKey ? "Alt" : "",
          event.shiftKey ? "Shift" : "",
          event.metaKey ? "Super" : "",
          event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key,
        ].filter(Boolean);
        if (parts.length < 2) return;
        onChange(parts.join("+"));
        setRecording(false);
      }}
    >
      <kbd>{recording ? "请按下组合键…" : value}</kbd>
    </button>
  );
}

function EnhancedSettingsPage({
  model,
  notify,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
}) {
  const [migrating, setMigrating] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [linkDraft, setLinkDraft] = useState<QuickLink | null>(null);

  const changeDirectory = async () => {
    const target = await chooseDirectory();
    if (!target) return;
    setMigrating(true);
    try {
      const result = await invokeNative<string>("migrate_data_directory", { target });
      model.setDataDirectory(result ?? target);
      notify("数据存储位置已更新");
    } catch (error) {
      notify(`迁移失败：${String(error)}`);
    } finally {
      setMigrating(false);
    }
  };

  const rebuild = async (roots: string[]) => {
    setIndexing(true);
    try {
      const quickCount = await rebuildSearchIndex(roots);
      if (roots.includes("*")) {
        notify(`快速索引已收录 ${quickCount} 项，全盘扫描将在后台继续`);
        return;
      }
      let status = await getSearchIndexStatus();
      while (status === "indexing") {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        status = await getSearchIndexStatus();
      }
      if (status === "failed") throw new Error("索引任务执行失败");
      const count = await getSearchIndexCount();
      notify(`索引完成，共收录 ${count} 项`);
    } catch (error) {
      notify(`索引失败：${String(error)}`);
    } finally {
      setIndexing(false);
    }
  };

  const addRoot = async () => {
    const root = await chooseDirectory();
    if (!root) return;
    const roots = Array.from(
      new Set([
        ...model.snapshot.settings.indexRoots.filter((item) => item !== "*"),
        root,
      ]),
    );
    model.addIndexRoot(root);
    await rebuild(roots);
  };

  const updateShortcut = (
    key: keyof typeof model.snapshot.settings.shortcuts,
    value: string,
  ) => {
    const duplicate = Object.entries(model.snapshot.settings.shortcuts).some(
      ([existingKey, existingValue]) =>
        existingKey !== key && existingValue.toLocaleLowerCase() === value.toLocaleLowerCase(),
    );
    if (duplicate) {
      notify(`快捷键 ${value} 已被其他工具使用`);
      return;
    }
    model.setSetting("shortcuts", {
      ...model.snapshot.settings.shortcuts,
      [key]: value,
    });
  };

  return (
    <>
      <SectionHeading
        eyebrow="PREFERENCES"
        title="设置"
        description="所有外观、快捷键、索引和历史记录设置都会自动保存。"
      />
      <div className="settings-layout">
        <section className="settings-section">
          <header>
            <Database size={19} />
            <div><h2>数据与存储</h2><p>默认保存在应用安装目录下的 data 文件夹。</p></div>
          </header>
          <div className="setting-row storage-row">
            <span className="drive-icon"><HardDrive size={22} /></span>
            <div>
              <strong>当前存储位置</strong>
              <code>{model.snapshot.settings.dataDirectory}</code>
              <small>提示词、配置、索引和剪贴板历史均保存在这里。</small>
            </div>
            <button
              className="button secondary"
              onClick={() => void changeDirectory()}
              disabled={migrating}
              aria-label="更改位置"
            >
              <FolderOpen size={16} /> {migrating ? "正在迁移…" : "更改位置"}
            </button>
          </div>
        </section>

        <section className="settings-section quick-link-settings">
          <header>
            <Link2 size={19} />
            <div>
              <h2>快捷链接</h2>
              <p>像 Alfred 一样通过名称或关键词打开网页，使用 {"{query}"} 接收参数。</p>
            </div>
            <button
              className="button secondary"
              onClick={() =>
                setLinkDraft({
                  id: "",
                  name: "",
                  description: "",
                  keyword: "",
                  urlTemplate: "https://",
                  enabled: true,
                })
              }
            >
              <Plus size={16} /> 新增链接
            </button>
          </header>
          {linkDraft ? (
            <form
              className="quick-link-editor"
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !linkDraft.name.trim() ||
                  !/^(?:https?:\/\/|microsoft-edge:https?:\/\/)/i.test(linkDraft.urlTemplate)
                ) {
                  notify("请填写名称和有效的网址或 Edge 搜索模板");
                  return;
                }
                model.upsertQuickLink({
                  ...linkDraft,
                  name: linkDraft.name.trim(),
                  description: linkDraft.description.trim(),
                  keyword: linkDraft.keyword.trim(),
                  urlTemplate: linkDraft.urlTemplate.trim(),
                  id: linkDraft.id || undefined,
                });
                setLinkDraft(null);
                notify("快捷链接已保存");
              }}
            >
              <input
                aria-label="链接名称"
                placeholder="名称，例如 Google 搜索"
                value={linkDraft.name}
                onChange={(event) => setLinkDraft({ ...linkDraft, name: event.target.value })}
              />
              <input
                aria-label="链接关键词"
                placeholder="关键词，例如 g"
                value={linkDraft.keyword}
                onChange={(event) => setLinkDraft({ ...linkDraft, keyword: event.target.value })}
              />
              <input
                aria-label="链接描述"
                placeholder="描述，支持模糊搜索"
                value={linkDraft.description}
                onChange={(event) =>
                  setLinkDraft({ ...linkDraft, description: event.target.value })
                }
              />
              <input
                className="link-template-input"
                aria-label="链接模板"
                placeholder="https://www.google.com/search?q={query}"
                value={linkDraft.urlTemplate}
                onChange={(event) =>
                  setLinkDraft({ ...linkDraft, urlTemplate: event.target.value })
                }
              />
              <p className="quick-link-help">
                参数位置使用 <code>{"{query}"}</code>。强制使用 Edge：
                <code>microsoft-edge:https://www.bing.com/search?q={"{query}"}</code>
              </p>
              <div className="quick-link-editor-actions">
                <button type="button" className="button ghost" onClick={() => setLinkDraft(null)}>
                  取消
                </button>
                <button type="submit" className="button primary">保存链接</button>
              </div>
            </form>
          ) : null}
          <div
            className={`quick-link-list ${
              model.snapshot.quickLinks.length > 3 ? "scrollable" : ""
            }`}
          >
            {model.snapshot.quickLinks.map((link) => (
              <div className="quick-link-row" key={link.id}>
                <span className="quick-link-mark"><Link2 size={17} /></span>
                <div>
                  <strong>{link.name}</strong>
                  <small>{link.description || link.urlTemplate}</small>
                </div>
                {link.keyword ? <code>{link.keyword} {"{query}"}</code> : null}
                <Switch
                  checked={link.enabled}
                  label={`${link.name} 快捷链接`}
                  onChange={(enabled) => model.upsertQuickLink({ ...link, enabled })}
                />
                <button className="icon-button" aria-label={`编辑 ${link.name}`} onClick={() => setLinkDraft(link)}>
                  <Settings size={15} />
                </button>
                <button className="icon-button danger" aria-label={`删除 ${link.name}`} onClick={() => model.removeQuickLink(link.id)}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            {!model.snapshot.quickLinks.length && !linkDraft ? (
              <p className="quick-link-empty">还没有快捷链接。添加后，它会优先出现在全局搜索结果中。</p>
            ) : null}
          </div>
        </section>

        <section className="settings-section">
          <header>
            <Keyboard size={19} />
            <div><h2>全局快捷键</h2><p>修改后自动重新注册，并在下一次启动时恢复。</p></div>
          </header>
          {([
            ["search", "全局搜索", "只弹出搜索浮窗"],
            ["prompts", "提示词库", "弹出提示词模糊搜索"],
            ["clipboard", "剪贴板历史", "弹出最近复制记录"],
          ] as const).map(([key, title, description]) => (
            <label className="setting-row shortcut-setting" key={key}>
              <div><strong>{title}</strong><small>{description}</small></div>
              <ShortcutRecorder
                value={model.snapshot.settings.shortcuts[key]}
                onChange={(value) => updateShortcut(key, value)}
              />
            </label>
          ))}
        </section>

        <section className="settings-section">
          <header>
            <FileSearch size={19} />
            <div><h2>全盘索引</h2><p>默认扫描所有可用磁盘，也可以只索引指定目录。</p></div>
          </header>
          <div className="setting-row">
            <div>
              <strong>当前索引范围</strong>
              <small>
                {model.snapshot.settings.indexRoots.includes("*")
                  ? "所有可用磁盘"
                  : model.snapshot.settings.indexRoots.join("、")}
              </small>
            </div>
            <div className="setting-actions">
              <button
                className="button secondary"
                disabled={indexing}
                onClick={() => {
                  model.setSetting("indexRoots", ["*"]);
                  void rebuild(["*"]);
                }}
              >
                <HardDrive size={16} /> 全部磁盘
              </button>
              <button className="button secondary" disabled={indexing} onClick={() => void addRoot()}>
                <Plus size={16} /> 添加目录
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <header>
            <Sparkles size={19} />
            <div><h2>字体与外观</h2><p>字体、字号和明暗主题会自动保存。</p></div>
          </header>
          <div className="setting-row">
            <div><strong>界面字体</strong><small>选择更适合阅读或编程的字体风格</small></div>
            <select
              value={model.snapshot.settings.fontFamily}
              onChange={(event) =>
                model.setSetting(
                  "fontFamily",
                  event.target.value as typeof model.snapshot.settings.fontFamily,
                )
              }
            >
              <option value="system">系统黑体</option>
              <option value="serif">人文宋体</option>
              <option value="mono">等宽字体</option>
            </select>
          </div>
          <div className="setting-row">
            <div><strong>文字大小</strong><small>{Math.round(model.snapshot.settings.fontScale * 100)}%</small></div>
            <input
              type="range"
              min="0.85"
              max="1.25"
              step="0.05"
              value={model.snapshot.settings.fontScale}
              onChange={(event) => model.setSetting("fontScale", Number(event.target.value))}
            />
          </div>
          <div className="theme-picker">
            <button
              className={model.snapshot.settings.theme === "light" ? "selected" : ""}
              onClick={() => model.setTheme("light")}
            >
              <span className="theme-preview light"><i /><i /><i /></span><Sun size={16} /> 浅色
            </button>
            <button
              className={model.snapshot.settings.theme === "dark" ? "selected" : ""}
              onClick={() => model.setTheme("dark")}
            >
              <span className="theme-preview dark"><i /><i /><i /></span><Moon size={16} /> 深色
            </button>
          </div>
        </section>

        <section className="settings-section">
          <header>
            <Clipboard size={19} />
            <div><h2>剪贴板历史</h2><p>设置跨重启保留的最近文本数量。</p></div>
          </header>
          <label className="setting-row">
            <div><strong>保留数量</strong><small>允许 10–500 条</small></div>
            <input
              className="number-setting no-native-spinner"
              type="number"
              min="10"
              max="500"
              value={model.snapshot.settings.clipboardLimit}
              onChange={(event) => {
                const limit = Math.min(
                  500,
                  Math.max(10, Number(event.target.value) || 10),
                );
                model.setSetting("clipboardLimit", limit);
                model.setClipboardHistory(
                  model.snapshot.clipboardHistory.slice(0, limit),
                );
              }}
            />
          </label>
        </section>
      </div>
    </>
  );
}
