import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  AppWindow,
  ArrowUpRight,
  BookOpenText,
  Bookmark,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
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
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  Play,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Settings,
  Sparkles,
  Terminal,
  Tag,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  EmptyState,
  ResultGlyph,
  SectionHeading,
  Switch,
  ToolBadge,
} from "./components";
import {
  calculateOverviewMetrics,
  DEFAULT_SHORTCUTS,
  buildQuickLinkResults,
  clipboardEntryKind,
  clipboardEntrySearchText,
  filterPrompts,
  filterPromptsByCategory,
  filterSearchResults,
  rankSearchResults,
  selectSearchResults,
  startupItemsForScene,
} from "./domain";
import {
  DEFAULT_FOLDER_GROUP,
  filterFolderFavorites,
  findFolderShortcutConflict,
  groupFolderFavorites,
  normalizeFolderFavorite,
  normalizeFolderShortcut,
  normalizeFolderTags,
} from "./folderFavorites";
import { installCustomFont, installTheme, writeAppearancePreview } from "./appearance";
import {
  activateClipboardEntry,
  bindNativeSearchShortcut,
  captureStartupSceneLayout,
  chooseDirectory,
  chooseExecutable,
  closePreviousStartupScene,
  copyText,
  deleteClipboardEntry,
  getSearchIndexProgress,
  getSearchIndexCount,
  getAppIcons,
  importAppearanceAsset,
  invokeNative,
  launchStartupItems,
  listStartupSceneMonitors,
  loadAppearanceAsset,
  openRuntimeLog,
  openTarget,
  recordRuntimeEvent,
  restoreStartupSceneLayout,
  rebuildSearchIndex,
  runCommandTask,
  searchNative,
  saveSnapshot,
} from "./native";
import { SearchQueryInput } from "./SearchQueryInput";
import { SearchFilterControls } from "./SearchFilterControls";
import WindowChrome from "./WindowChrome";
import type {
  CommandTask,
  FolderFavorite,
  IndexProgress,
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
  { id: "automation", label: "自动化命令", icon: Terminal },
  { id: "folders", label: "文件夹收藏", icon: Bookmark },
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
    caption: "跨越重启找回最近复制的文字与图片",
    number: "04",
    icon: Clipboard,
    tint: "vermillion",
  },
  automation: {
    title: "自动化命令",
    caption: "让重复的终端步骤按依赖顺序完成",
    number: "05",
    icon: Terminal,
    tint: "ink",
  },
  folders: {
    title: "文件夹收藏",
    caption: "把经常抵达的目录留在手边",
    number: "06",
    icon: Bookmark,
    tint: "moss",
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
  const model = useToolkit();
  return (
    <div className="desktop-frame">
      <WindowChrome
        title={model.snapshot.settings.branding.appName}
        description={model.snapshot.settings.branding.appDescription}
        confirmOnClose={model.snapshot.settings.confirmOnClose}
        onDisableCloseReminder={() => model.setSetting("confirmOnClose", false)}
        onBeforeQuit={async (disableReminder) => {
          const snapshot = disableReminder
            ? {
                ...model.snapshot,
                settings: {
                  ...model.snapshot.settings,
                  confirmOnClose: false,
                },
              }
            : model.snapshot;
          await saveSnapshot(snapshot);
        }}
      />
      <MainApp model={model} />
    </div>
  );
}

function MainApp({ model }: { model: ToolkitModel }) {
  const [activeNav, setActiveNav] = useState<NavId>("overview");
  const [toast, setToast] = useState<string | null>(null);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const mainPanelRef = useRef<HTMLElement>(null);
  const [appearanceAssets, setAppearanceAssets] = useState({
    logo: "",
    avatar: "",
    background: "",
  });
  const branding = model.snapshot.settings.branding;
  const customTheme = model.snapshot.settings.customThemes.find(
    (theme) => theme.id === model.snapshot.settings.activeCustomThemeId,
  );
  const customFont = model.snapshot.settings.customFonts.find(
    (font) => font.id === model.snapshot.settings.activeCustomFontId,
  );

  useEffect(() => {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setTitle(
          [branding.appName, branding.appDescription].filter(Boolean).join(" · "),
        ),
      )
      .catch(() => undefined);
  }, [branding.appDescription, branding.appName]);

  useEffect(() => {
    let active = true;
    const essentialPaths = [
      ["logo", branding.logoPath],
      ["avatar", branding.avatarPath],
    ] as const;
    void Promise.all(
      essentialPaths.map(async ([key, path]) => [
        key,
        path ? await loadAppearanceAsset(path).catch(() => "") : "",
      ] as const),
    ).then((loaded) => {
      if (active) {
        setAppearanceAssets((current) => ({
          ...current,
          ...Object.fromEntries(loaded),
        }));
      }
    });
    setAppearanceAssets((current) => ({ ...current, background: "" }));
    let backgroundTimer: number | undefined;
    const loadBackground = async () => {
      if (!branding.backgroundPath) return;
      const source = await loadAppearanceAsset(branding.backgroundPath).catch(() => "");
      if (!source || !active) return;
      const image = new Image();
      image.src = source;
      if (typeof image.decode === "function") {
        await image.decode().catch(() => undefined);
      }
      if (active) {
        setAppearanceAssets((current) => ({ ...current, background: source }));
      }
    };
    backgroundTimer = window.setTimeout(() => void loadBackground(), 650);
    return () => {
      active = false;
      if (backgroundTimer !== undefined) window.clearTimeout(backgroundTimer);
    };
  }, [branding.avatarPath, branding.backgroundPath, branding.logoPath]);

  useEffect(() => {
    const cleanup = installTheme(customTheme, model.snapshot.settings.theme);
    recordRuntimeEvent(
      "appearance.theme.apply",
      "success",
      customTheme
        ? `theme_id=${customTheme.id} mode=${customTheme.mode}`
        : `builtin_mode=${model.snapshot.settings.theme}`,
    );
    return cleanup;
  }, [customTheme, model.snapshot.settings.theme]);

  useEffect(() => {
    writeAppearancePreview({
      theme: model.snapshot.settings.theme,
      fontFamily: model.snapshot.settings.fontFamily,
      fontScale: model.snapshot.settings.fontScale,
      customFonts: model.snapshot.settings.customFonts,
      activeCustomFontId: model.snapshot.settings.activeCustomFontId,
      customThemes: model.snapshot.settings.customThemes,
      activeCustomThemeId: model.snapshot.settings.activeCustomThemeId,
    });
  }, [
    model.snapshot.settings.activeCustomFontId,
    model.snapshot.settings.activeCustomThemeId,
    model.snapshot.settings.customFonts,
    model.snapshot.settings.customThemes,
    model.snapshot.settings.fontFamily,
    model.snapshot.settings.fontScale,
    model.snapshot.settings.theme,
  ]);

  useEffect(() => {
    const root = document.documentElement;
    if (appearanceAssets.background) {
      root.dataset.background = "true";
      root.style.setProperty(
        "--appearance-background-image",
        `url("${appearanceAssets.background}")`,
      );
      root.style.setProperty(
        "--appearance-background-opacity",
        String(model.snapshot.settings.backgroundOpacity),
      );
    } else {
      delete root.dataset.background;
      root.style.removeProperty("--appearance-background-image");
      root.style.removeProperty("--appearance-background-opacity");
    }
    return () => {
      delete root.dataset.background;
      root.style.removeProperty("--appearance-background-image");
      root.style.removeProperty("--appearance-background-opacity");
    };
  }, [appearanceAssets.background, model.snapshot.settings.backgroundOpacity]);

  useEffect(() => {
    if (!customFont) {
      recordRuntimeEvent(
        "appearance.font.apply",
        "success",
        `builtin=${model.snapshot.settings.fontFamily}`,
      );
    }
    return installCustomFont(customFont?.path, (result, detail) => {
      recordRuntimeEvent(
        "appearance.font.apply",
        result,
        `font_id=${customFont?.id ?? "builtin"} ${detail}`,
      );
      if (result === "failed") {
        setToast("字体加载失败，请查看运行日志或重新导入字体");
      }
    });
  }, [customFont, model.snapshot.settings.fontFamily]);

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

  const previousIndexStatus = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousIndexStatus.current;
    previousIndexStatus.current = indexProgress?.status ?? null;
    if (
      previous !== "indexing" ||
      indexProgress?.status !== "ready" ||
      model.snapshot.settings.indexSetup === "ready"
    ) {
      return;
    }
    const scopeName = model.snapshot.settings.indexRoots.includes("*")
      ? "全盘索引"
      : "目录索引";
    void getSearchIndexCount().then((storedCount) => {
      const count = Math.max(storedCount, indexProgress.indexedItems);
      model.setSetting("indexSetup", "ready");
      setToast(`${scopeName}已经建立，共 ${count.toLocaleString()} 项`);
      recordRuntimeEvent(
        "search.index.complete",
        "success",
        `scope=${scopeName} indexed_items=${count}`,
      );
    });
  }, [
    indexProgress?.indexedItems,
    indexProgress?.status,
    model.snapshot.settings.indexRoots,
    model.snapshot.settings.indexSetup,
  ]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      const next = await getSearchIndexProgress();
      if (!active) return;
      setIndexProgress(next);
      timer = window.setTimeout(
        refresh,
        next.status === "indexing"
          ? 1_000
          : next.status === "idle"
            ? 2_500
            : 30_000,
      );
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (mainPanelRef.current) mainPanelRef.current.scrollTop = 0;
  }, [activeNav]);

  const startIndexBuild = async (roots: string[]) => {
    model.setSetting("indexRoots", roots);
    model.setSetting("indexSetup", "pending");
    const buildingSnapshot = {
      ...model.snapshot,
      settings: {
        ...model.snapshot.settings,
        indexRoots: roots,
        indexSetup: "pending" as const,
      },
    };
    try {
      // Persist the selected scope before scanning so an interrupted first-run
      // build resumes the same scope instead of falling back to all disks.
      await saveSnapshot(buildingSnapshot);
      const count = await rebuildSearchIndex(roots);
      model.setSetting("indexSetup", "ready");
      await saveSnapshot({
        ...buildingSnapshot,
        settings: { ...buildingSnapshot.settings, indexSetup: "ready" },
      });
      const storedCount = await getSearchIndexCount();
      setToast(
        `搜索索引已经建立，共 ${Math.max(count, storedCount).toLocaleString()} 项`,
      );
      setIndexProgress(await getSearchIndexProgress());
    } catch (error) {
      model.setSetting("indexSetup", "deferred");
      await saveSnapshot({
        ...buildingSnapshot,
        settings: { ...buildingSnapshot.settings, indexSetup: "deferred" },
      }).catch(() => undefined);
      setToast(`索引建立失败：${String(error)}`);
    }
  };

  if (!model.hydrated) {
    return (
      <div className="app-loading" role="status">
        <span className="brand-mark brand-mark--fixed-contrast"><Layers3 size={20} /></span>
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
          title={branding.toolNames[activeNav]}
          onEnable={() => model.setToolEnabled(activeNav, true)}
        />
      );
    }
    switch (activeNav) {
      case "startup":
        return <StartupPage model={model} notify={setToast} />;
      case "search":
        return (
          <SearchPage
            model={model}
            notify={setToast}
            indexProgress={indexProgress}
            onStartIndex={() => void startIndexBuild(model.snapshot.settings.indexRoots)}
          />
        );
      case "prompts":
        return <PromptsPage model={model} notify={setToast} />;
      case "clipboard":
        return <ClipboardPage model={model} notify={setToast} />;
      case "automation":
        return <AutomationPage model={model} notify={setToast} />;
      case "folders":
        return <FolderFavoritesPage model={model} notify={setToast} />;
      case "settings":
        return (
          <EnhancedSettingsPage
            model={model}
            notify={setToast}
            indexProgress={indexProgress}
            onStartIndex={(roots) => void startIndexBuild(roots)}
          />
        );
      default:
        return <OverviewPage model={model} navigate={setActiveNav} />;
    }
  })();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setActiveNav("overview")} aria-label={`${branding.appName} 首页`}>
          <span className="brand-mark brand-mark--fixed-contrast">
            {appearanceAssets.logo ? <img src={appearanceAssets.logo} alt="" /> : <Layers3 size={20} />}
          </span>
          <span>
            <strong>{branding.appName}</strong>
            <small>{branding.appDescription}</small>
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
                <span>{item.id === "overview" ? item.label : branding.toolNames[item.id as ToolId]}</span>
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
          <span className="profile-glyph">
            {appearanceAssets.avatar ? <img src={appearanceAssets.avatar} alt="" /> : "A"}
          </span>
          <span>
            <strong>{branding.workspaceName}</strong>
            <small>{branding.workspaceDescription}</small>
          </span>
          <MoreHorizontal size={17} />
        </div>
      </aside>

      <main className="main-panel" ref={mainPanelRef}>
        <div className="page">{page}</div>
      </main>

      {indexProgress?.status === "indexing" ? (
        <IndexProgressBanner progress={indexProgress} />
      ) : null}

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

export function IndexProgressBanner({ progress }: { progress: IndexProgress }) {
  const [collapsed, setCollapsed] = useState(false);
  const max = Math.max(progress.totalRoots, 1);
  const fastNtfs = progress.phase === "authorizing" || progress.phase === "mft";
  const finalizing = progress.phase === "finalizing";
  const activityOnly = fastNtfs || finalizing;
  if (collapsed) {
    return (
      <aside className="index-progress-banner collapsed" role="status" aria-label="后台索引进度">
        <span className="index-progress-pulse" aria-hidden="true" />
        <strong>索引中</strong>
        <button type="button" aria-label="展开索引详情" onClick={() => setCollapsed(false)}>
          <ChevronUp size={14} />
        </button>
      </aside>
    );
  }
  return (
    <aside className="index-progress-banner" role="status" aria-label="后台索引进度">
      <div className="index-progress-summary">
        <div className="index-progress-copy">
          <strong className="index-progress-title">
            {progress.phase === "authorizing"
              ? "正在等待管理员授权"
              : finalizing
                ? "正在整理搜索索引"
              : fastNtfs
                ? "正在建立 NTFS 快速索引"
                : "正在建立全盘索引"}
          </strong>
          <small>
            {progress.currentRoot ? `${progress.currentRoot} · ` : ""}
            已发现 {progress.indexedItems.toLocaleString("zh-CN")} 项
          </small>
          {progress.fallbackReason ? (
            <small className="index-progress-fallback">
              快速索引未生效：{progress.fallbackReason}，已切换兼容扫描
            </small>
          ) : null}
        </div>
        <span className="index-progress-position">
          {finalizing
            ? "文件读取已完成，正在安全切换索引"
            : fastNtfs
              ? progress.phase === "authorizing"
                ? "等待系统确认"
                : "读取磁盘文件表"
              : progress.completedRoots > 0
                ? `${progress.completedRoots} / ${progress.totalRoots} 个位置`
                : `第 ${Math.min(1, progress.totalRoots)} / ${progress.totalRoots} 个位置`}
        </span>
      </div>
      {activityOnly ? (
        <div className="index-progress-activity" aria-label="快速索引正在运行">
          <span className="index-progress-pulse" aria-hidden="true" />
          <span>
            {progress.phase === "authorizing"
              ? "等待系统确认"
              : finalizing
                ? "正在写入索引元数据"
                : "持续读取中"}
          </span>
        </div>
      ) : (
        <progress
          aria-label="全盘索引进度"
          max={max}
          {...(progress.completedRoots > 0 ? { value: progress.completedRoots } : {})}
        />
      )}
      <button type="button" aria-label="隐藏索引详情" onClick={() => setCollapsed(true)}>
        <ChevronDown size={15} />
      </button>
    </aside>
  );
}

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
          <small>{enabledCount} / 6 个工具正在运行</small>
        </div>
      </header>

      <section className="tool-grid" aria-label="工具列表">
        {(Object.keys(toolMeta) as ToolId[]).map((id) => {
          const meta = toolMeta[id];
          const displayTitle = model.snapshot.settings.branding.toolNames[id];
          const Icon = meta.icon;
          const enabled = model.snapshot.tools[id].enabled;
          const resolvedStat = {
            startup: `${model.snapshot.startupScenes.length} 个场景`,
            search: model.snapshot.settings.shortcuts.search.replaceAll("+", " + "),
            prompts: `${model.snapshot.prompts.length} 条收藏`,
            clipboard: `${model.snapshot.clipboardHistory.length} 条记录`,
            automation: `${model.snapshot.commandTasks.length} 个任务`,
            folders: `${model.snapshot.folderFavorites.length} 个文件夹`,
          }[id];
          return (
            <motion.article
              className={`tool-card ${meta.tint} ${enabled ? "" : "disabled"}`}
              key={id}
            >
              <button
                type="button"
                className="tool-card-hit-target"
                aria-label={`打开${displayTitle}`}
                onClick={() => navigate(id)}
              />
              <div className="tool-card-top">
                <span className="tool-number">{meta.number}</span>
                <Switch
                  checked={enabled}
                  label={displayTitle}
                  onChange={(value) => model.setToolEnabled(id, value)}
                />
              </div>
              <div className="tool-icon">
                <Icon size={25} strokeWidth={1.7} />
              </div>
              <h2>{displayTitle}</h2>
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
  const [activeSceneId, setActiveSceneId] = useState(
    model.snapshot.startupScenes[0]?.id ?? "default-scene",
  );
  const [sceneDraft, setSceneDraft] = useState<{ name: string; description: string } | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);
  const [monitors, setMonitors] = useState<Array<{
    deviceName: string;
    primary: boolean;
  }>>([]);
  const [lastLaunchedSceneId, setLastLaunchedSceneId] = useState(
    () => sessionStorage.getItem("atlas-last-startup-scene") ?? "",
  );
  const activeScene =
    model.snapshot.startupScenes.find((scene) => scene.id === activeSceneId) ??
    model.snapshot.startupScenes[0];
  const sceneItems = (activeScene?.itemIds ?? [])
    .map((id) => model.snapshot.startupItems.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => a.delaySeconds - b.delaySeconds || a.order - b.order);
  useEffect(() => {
    let cancelled = false;
    void listStartupSceneMonitors()
      .then((available) => {
        if (!cancelled) setMonitors(available);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const updateActiveScene = (
    patch: Partial<NonNullable<typeof activeScene>>,
  ) => {
    if (!activeScene) return;
    model.setSnapshot((current) => ({
      ...current,
      startupScenes: current.startupScenes.map((scene) =>
        scene.id === activeScene.id ? { ...scene, ...patch } : scene,
      ),
    }));
  };
  const captureLayout = async () => {
    if (!activeScene) return;
    setSceneBusy(true);
    try {
      const capture = await captureStartupSceneLayout(sceneItems);
      updateActiveScene({
        windowLayouts: capture.layouts,
        restoreLayout: capture.layouts.length > 0,
      });
      notify(
        capture.layouts.length
          ? `已保存 ${capture.layouts.length} 个应用窗口的位置${capture.errors.length ? `，${capture.errors.length} 项未捕获` : ""}`
          : "未找到可捕获的应用窗口，请先运行场景中的应用",
      );
    } catch (error) {
      notify(`保存桌面布局失败：${String(error)}`);
    } finally {
      setSceneBusy(false);
    }
  };
  const runActiveScene = async () => {
    if (!activeScene || sceneBusy) return;
    setSceneBusy(true);
    try {
      let closed = 0;
      const previousScene = model.snapshot.startupScenes.find(
        (scene) => scene.id === lastLaunchedSceneId,
      );
      if (
        activeScene.closePreviousApps &&
        previousScene &&
        previousScene.id !== activeScene.id
      ) {
        const closeResults = await closePreviousStartupScene(
          startupItemsForScene(model.snapshot.startupItems, previousScene),
          sceneItems,
        );
        closed = closeResults.filter((result) => result.status === "closeRequested").length;
      }
      const results = await launchStartupItems(sceneItems);
      const failed = results.filter((result) => !result.success);
      const skipped = results.filter((result) => result.status === "alreadyRunning").length;
      if (activeScene.restoreLayout && activeScene.windowLayouts?.length) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        await restoreStartupSceneLayout(activeScene.windowLayouts);
      }
      model.setSnapshot((current) => ({
        ...current,
        activity: { ...current.activity, startupLastRunAt: Date.now() },
      }));
      setLastLaunchedSceneId(activeScene.id);
      sessionStorage.setItem("atlas-last-startup-scene", activeScene.id);
      notify(
        failed.length
          ? `已启动 ${results.length - failed.length - skipped} 项，${skipped} 项已在运行，${failed.length} 项失败`
          : `场景已运行：新启动 ${results.length - skipped} 项，跳过 ${skipped} 个已运行应用${closed ? `，已请求关闭 ${closed} 项` : ""}`,
      );
    } catch (error) {
      notify(`启动失败：${String(error)}`);
    } finally {
      setSceneBusy(false);
    }
  };
  const addItem = async () => {
    const item = await chooseExecutable();
    if (!item) return;
    model.addStartupItem(item);
    model.setSnapshot((current) => ({
      ...current,
      startupScenes: current.startupScenes.map((scene) =>
        scene.id === activeScene?.id && !scene.itemIds.includes(item.id)
          ? { ...scene, itemIds: [...scene.itemIds, item.id] }
          : scene,
      ),
    }));
    notify("应用已加入启动队列");
  };

  return (
    <>
      <SectionHeading
        eyebrow="TOOL 01 · STARTUP"
        title={model.snapshot.settings.branding.toolNames.startup}
        description="为工作、学习或自定义场景安排应用组合，并按启动延迟自动排序。"
        action={<Switch checked={enabled} onChange={(value) => model.setToolEnabled("startup", value)} label={model.snapshot.settings.branding.toolNames.startup} />}
      />
      <section className="scene-switcher">
        <div className="scene-tabs" role="tablist" aria-label="启动场景">
          {model.snapshot.startupScenes.map((scene) => (
            <button
              type="button"
              role="tab"
              aria-selected={scene.id === activeScene?.id}
              className={scene.id === activeScene?.id ? "active" : ""}
              key={scene.id}
              onClick={() => setActiveSceneId(scene.id)}
            >
              <Layers3 size={15} />
              <span><strong>{scene.name}</strong><small>{scene.itemIds.length} 个应用</small></span>
            </button>
          ))}
          <button type="button" className="add-scene" onClick={() => setSceneDraft({ name: "", description: "" })}>
            <Plus size={16} /> 新建场景
          </button>
        </div>
        {sceneDraft ? (
          <form
            className="scene-editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (!sceneDraft.name.trim()) {
                notify("请填写场景名称");
                return;
              }
              const scene = {
                id: `scene-${Date.now()}`,
                name: sceneDraft.name.trim(),
                description: sceneDraft.description.trim(),
                itemIds: [] as string[],
                closePreviousApps: false,
                restoreLayout: false,
                windowLayouts: [],
              };
              model.setSnapshot((current) => ({
                ...current,
                startupScenes: [...current.startupScenes, scene],
              }));
              setActiveSceneId(scene.id);
              setSceneDraft(null);
            }}
          >
            <input aria-label="场景名称" placeholder="例如：学习模式" value={sceneDraft.name} onChange={(event) => setSceneDraft({ ...sceneDraft, name: event.target.value })} />
            <input aria-label="场景描述" placeholder="这个场景用于什么" value={sceneDraft.description} onChange={(event) => setSceneDraft({ ...sceneDraft, description: event.target.value })} />
            <button type="button" className="button ghost" onClick={() => setSceneDraft(null)}>取消</button>
            <button className="button primary" type="submit">创建</button>
          </form>
        ) : null}
        {activeScene ? (
          <div className="scene-summary">
            <div>
              <span className="eyebrow">ACTIVE SCENE</span>
              <strong>{activeScene.name}</strong>
              <small>{activeScene.description || "自定义应用组合"}</small>
            </div>
            {model.snapshot.startupScenes.length > 1 ? (
              <button
                className="button ghost danger"
                onClick={() => {
                  const remaining = model.snapshot.startupScenes.filter((scene) => scene.id !== activeScene.id);
                  model.setSnapshot((current) => ({
                    ...current,
                    startupScenes: remaining,
                    settings: {
                      ...current.settings,
                      loginSceneId:
                        current.settings.loginSceneId === activeScene.id
                          ? remaining[0].id
                          : current.settings.loginSceneId,
                    },
                  }));
                  setActiveSceneId(remaining[0].id);
                }}
              >
                <Trash2 size={15} /> 删除场景
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
      {model.snapshot.startupFailures?.length ? (
        <div className="startup-failure-banner" role="status">
          <AlertTriangle size={17} />
          <span>
            上次开机时有 {model.snapshot.startupFailures.length} 个应用未能启动：
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
          <span>{enabled ? "场景已就绪；开机行为由设置单独控制" : "所有启动场景当前暂停"}</span>
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="button secondary"
            disabled={!sceneItems.length || sceneBusy}
            onClick={() => void runActiveScene()}
          >
            <Zap size={16} />
            {sceneBusy ? "处理中…" : "立即运行"}
          </button>
          <button type="button" className="button primary" onClick={() => void addItem()}>
            <Plus size={17} />
            添加应用
          </button>
        </div>
      </div>

      {activeScene ? (
        <section className="content-card scene-behavior">
          <header>
            <div>
              <strong>场景切换与桌面布局</strong>
              <small>避免重复启动；也可以关闭上一场景独有的软件，并恢复窗口位置。</small>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={!sceneItems.length || sceneBusy}
              onClick={() => void captureLayout()}
            >
              <Save size={15} /> 保存当前桌面布局
            </button>
          </header>
          <div className="scene-behavior-options">
            <label>
              <span><strong>关闭上一场景的软件</strong><small>先正常关闭；仍驻留托盘时会结束对应应用进程</small></span>
              <Switch
                checked={activeScene.closePreviousApps ?? false}
                onChange={(closePreviousApps) => updateActiveScene({ closePreviousApps })}
                label="切换场景时关闭上一场景的软件"
              />
            </label>
            <label>
              <span><strong>恢复桌面布局</strong><small>运行场景后还原窗口位置、大小、最大化状态和显示器</small></span>
              <Switch
                checked={activeScene.restoreLayout ?? false}
                onChange={(restoreLayout) => updateActiveScene({ restoreLayout })}
                label="运行场景时恢复桌面布局"
              />
            </label>
          </div>
          {activeScene.windowLayouts?.length ? (
            <div className="scene-layout-list">
              {activeScene.windowLayouts.map((layout) => {
                const item = model.snapshot.startupItems.find(
                  (candidate) => candidate.id === layout.itemId,
                );
                const updateLayout = (
                  patch: Partial<typeof layout>,
                ) =>
                  updateActiveScene({
                    windowLayouts: activeScene.windowLayouts?.map((candidate) =>
                      candidate.itemId === layout.itemId
                        ? { ...candidate, ...patch }
                        : candidate,
                    ),
                  });
                return (
                  <div className="scene-layout-row" key={layout.itemId}>
                    <span className="scene-layout-app"><AppWindow size={15} /><strong>{item?.name ?? layout.itemId}</strong></span>
                    <label><span>X</span><input aria-label={`${item?.name ?? layout.itemId} 窗口 X`} type="number" value={layout.rect.x} onChange={(event) => updateLayout({ rect: { ...layout.rect, x: Number(event.target.value) } })} /></label>
                    <label><span>Y</span><input aria-label={`${item?.name ?? layout.itemId} 窗口 Y`} type="number" value={layout.rect.y} onChange={(event) => updateLayout({ rect: { ...layout.rect, y: Number(event.target.value) } })} /></label>
                    <label><span>宽</span><input aria-label={`${item?.name ?? layout.itemId} 窗口宽度`} type="number" min={240} value={layout.rect.width} onChange={(event) => updateLayout({ rect: { ...layout.rect, width: Math.max(240, Number(event.target.value)) } })} /></label>
                    <label><span>高</span><input aria-label={`${item?.name ?? layout.itemId} 窗口高度`} type="number" min={160} value={layout.rect.height} onChange={(event) => updateLayout({ rect: { ...layout.rect, height: Math.max(160, Number(event.target.value)) } })} /></label>
                    <label className="scene-monitor-select">
                      <Monitor size={14} />
                      <select
                        aria-label={`${item?.name ?? layout.itemId} 显示器`}
                        value={layout.monitorDeviceName ?? ""}
                        onChange={(event) => updateLayout({ monitorDeviceName: event.target.value || undefined })}
                      >
                        <option value="">自动选择显示器</option>
                        {monitors.map((monitor, index) => (
                          <option value={monitor.deviceName} key={monitor.deviceName}>
                            {`显示器 ${index + 1}${monitor.primary ? "（主显示器）" : ""}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="scene-layout-empty"><Monitor size={15} />运行场景中的应用并摆好窗口后，点击“保存当前桌面布局”。</p>
          )}
        </section>
      ) : null}

      <section className="content-card startup-list">
        <div className="list-header">
          <span>应用</span>
          <span>启动延迟</span>
          <span>状态</span>
          <span />
        </div>
        {sceneItems.length ? (
          sceneItems.map((item, index) => (
            <div className="startup-row" key={item.id}>
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
              {index < sceneItems.length - 1 ? (
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

      {model.snapshot.startupItems.length ? (
        <section className="content-card scene-membership">
          <header>
            <div><strong>场景应用</strong><small>勾选要包含在“{activeScene?.name}”中的应用</small></div>
          </header>
          <div>
            {model.snapshot.startupItems.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={activeScene?.itemIds.includes(item.id) ?? false}
                  onChange={(event) =>
                    model.setSnapshot((current) => ({
                      ...current,
                      startupScenes: current.startupScenes.map((scene) =>
                        scene.id === activeScene?.id
                          ? {
                              ...scene,
                              itemIds: event.target.checked
                                ? Array.from(new Set([...scene.itemIds, item.id]))
                                : scene.itemIds.filter((id) => id !== item.id),
                            }
                          : scene,
                      ),
                    }))
                  }
                />
                <span>{item.name}</span>
              </label>
            ))}
          </div>
        </section>
      ) : null}

      <aside className="note-panel">
        <Info size={17} />
        <p>
          是否让 Atlas 随 Windows 开机自启动由“设置 → 开机自启动”单独控制；启动编排开关只控制开机后是否执行所选场景。
        </p>
      </aside>
    </>
  );
}

function SearchPage({
  model,
  notify,
  indexProgress,
  onStartIndex,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
  indexProgress: IndexProgress | null;
  onStartIndex: () => void;
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
  const indexStatus = indexProgress?.status ?? "ready";
  const displayedResults = results.slice(0, 60);
  const active = displayedResults[selected];

  useEffect(() => {
    const requestId = ++requestSequence.current;
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
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
        });
        setSelected(0);
      })
      .catch((error: unknown) => {
        if (requestId !== requestSequence.current) return;
        setResults([]);
        notify(`搜索失败：${String(error)}`);
      })
      .finally(() => {
        if (requestId === requestSequence.current) setLoading(false);
      });
  }, [filters, model.snapshot.quickLinks, notify, query]);

  const activateResult = (result: SearchResult) => {
    const normalizedQuery = query.trim();
    if (normalizedQuery && normalizedQuery !== lastRecordedQuery.current) {
      lastRecordedQuery.current = normalizedQuery;
      recordSearch(normalizedQuery);
    }
    void openTarget(result.path);
  };
  return (
    <>
      <SectionHeading
        eyebrow="TOOL 02 · FINDER"
        title={model.snapshot.settings.branding.toolNames.search}
        description="搜索应用、文件与文件夹；支持绝对路径、拼音、首字母、常见错拼和同义词。"
        action={
          <Switch
            checked={enabled}
            onChange={(value) => model.setToolEnabled("search", value)}
            label={model.snapshot.settings.branding.toolNames.search}
          />
        }
      />
      <section className="search-stage">
        {model.snapshot.settings.indexSetup === "deferred" ? (
          <div className="index-deferred-notice">
            <span><FileSearch size={20} /></span>
            <div>
              <strong>尚未建立文件索引</strong>
              <small>快捷链接和应用仍可搜索；建立索引后才能完整搜索文件与文件夹。</small>
            </div>
            <button className="button secondary" onClick={onStartIndex}>
              现在建立索引
            </button>
          </div>
        ) : null}
        <div className="search-box">
          <Search size={22} />
          <SearchQueryInput
            autoFocus
            onSearchChange={setQuery}
            showClear
            placeholder="搜索应用、文件或文件夹…"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((value) =>
                  Math.max(0, Math.min(value + 1, displayedResults.length - 1)),
                );
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => Math.max(value - 1, 0));
              }
            }}
            onSubmit={(inputQuery) => {
              if (inputQuery === query && active) {
                activateResult(active);
              } else {
                setQuery(inputQuery);
              }
            }}
          />
          {loading ? (
            <LoaderCircle
              className="search-loading-indicator"
              size={18}
              aria-label="正在搜索"
              role="status"
            />
          ) : null}
        </div>
        <SearchFilterControls
          className="search-filter-bar"
          filters={filters}
          onChange={model.setSearchFilters}
          showHint
        />

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
            ) : loading && !results.length ? (
              <div className="loading-lines"><i /><i /><i /></div>
            ) : results.length ? (
              <>
                <div className="result-count">
                  <span>最佳匹配</span>
                  <small>{results.length} 项结果</small>
                </div>
                {displayedResults.map((result, index) => {
                  return (
                    <button
                      type="button"
                      className={`result-row ${selected === index ? "selected" : ""}`}
                      key={result.id}
                      onMouseEnter={() => setSelected(index)}
                      onDoubleClick={() => activateResult(result)}
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
                  <button className="button primary" onClick={() => activateResult(active)}>
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
  title,
  onEnable,
}: {
  tool: ToolId;
  title: string;
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
      <h1>{title}已暂停</h1>
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
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [editing, setEditing] = useState<PromptEntry | "new" | null>(null);
  const categories = useMemo(
    () => Array.from(new Set(model.snapshot.prompts.map((prompt) => prompt.category))).sort(),
    [model.snapshot.prompts],
  );
  const prompts = useMemo(() => {
    const filtered = filterPromptsByCategory(
      filterPrompts(model.snapshot.prompts, query),
      category,
    );
    return favoritesOnly ? filtered.filter((prompt) => prompt.favorite) : filtered;
  }, [category, favoritesOnly, model.snapshot.prompts, query]);

  return (
    <>
      <SectionHeading
        eyebrow="TOOL 03 · PROMPTS"
        title={model.snapshot.settings.branding.toolNames.prompts}
        description="收藏那些真正有效的表达，在需要时一键带走。"
        action={
          <div className="heading-actions">
            <Switch
              checked={model.snapshot.tools.prompts.enabled}
              onChange={(enabled) => model.setToolEnabled("prompts", enabled)}
              label={model.snapshot.settings.branding.toolNames.prompts}
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
        <button
          type="button"
          className={`favorites-filter ${favoritesOnly ? "active" : ""}`}
          aria-pressed={favoritesOnly}
          onClick={() => setFavoritesOnly((value) => !value)}
        >
          <Heart size={15} fill={favoritesOnly ? "currentColor" : "none"} />
          只看收藏
        </button>
        <div className="library-count">{model.snapshot.prompts.length} 条提示词</div>
      </div>
      <section className="prompt-grid">
        {prompts.map((prompt) => (
          <motion.article
            className={`prompt-card ${prompt.favorite ? "is-favorite" : ""}`}
            key={prompt.id}
            onClick={() => setEditing(prompt)}
          >
            <header>
              <span className="category-chip">{prompt.category}</span>
              <button
                className={`favorite-button ${prompt.favorite ? "active" : ""}`}
                type="button"
                aria-label={`${prompt.favorite ? "取消收藏" : "收藏"} ${prompt.title}`}
                aria-pressed={prompt.favorite}
                onClick={(event) => {
                  event.stopPropagation();
                  model.upsertPrompt({ ...prompt, favorite: !prompt.favorite });
                  notify(prompt.favorite ? "已取消收藏" : "已加入收藏");
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
        {model.snapshot.prompts.length ? (
          <button className="new-prompt-card" onClick={() => setEditing("new")}>
            <span><Plus size={22} /></span>
            <strong>新建提示词</strong>
            <small>把刚刚奏效的表达保存下来</small>
          </button>
        ) : (
          <EmptyState
            icon={<BookOpenText size={28} />}
            title="还没有提示词"
            description="保存常用表达后，可在主界面或快捷小窗中随时搜索并复制。"
            fullSpan
          />
        )}
        {model.snapshot.prompts.length > 0 && prompts.length === 0 ? (
          <EmptyState
            icon={<Search size={28} />}
            title="没有匹配的提示词"
            description="换个关键词、分类或取消“只看收藏”后再试。"
            fullSpan
          />
        ) : null}
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
        title={model.snapshot.settings.branding.toolNames.clipboard}
        description={`最近 ${model.snapshot.settings.clipboardLimit} 条文字或图片会保存在本地，点击任意记录即可重新复制。`}
        action={
          <Switch
            checked={model.snapshot.tools.clipboard.enabled}
            onChange={(enabled) => model.setToolEnabled("clipboard", enabled)}
            label={model.snapshot.settings.branding.toolNames.clipboard}
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
      <section className={`clipboard-list ${entries.length ? "" : "is-empty"}`}>
        {entries.length ? (
          entries.map((entry) => {
            const kind = clipboardEntryKind(entry);
            const text = entry.text ?? "";
            return (
              <article
                key={entry.id}
                className={`clipboard-entry ${kind}`}
              >
                <button
                  type="button"
                  className="clipboard-entry-main"
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
                <button
                  type="button"
                  className="clipboard-entry-delete"
                  aria-label="删除这条剪贴板记录"
                  onClick={() => {
                    void deleteClipboardEntry(entry.id)
                      .then((clipboardHistory) => {
                        model.setClipboardHistory(clipboardHistory);
                        notify("剪贴板记录已删除");
                      })
                      .catch((error: unknown) => notify(`删除失败：${String(error)}`));
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </article>
            );
          })
        ) : (
          <EmptyState
            icon={<Clipboard size={28} />}
            title="还没有剪贴板记录"
            description="启用工具后，新复制的文字和图片会自动出现在这里。"
            fullSpan
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
      aria-label={recording ? "请按下组合键" : value}
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

function AutomationPage({
  model,
  notify,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
}) {
  const enabled = model.snapshot.tools.automation.enabled;
  const [draft, setDraft] = useState<CommandTask | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<{
    command: string;
    success: boolean;
    exitCode?: number;
    stdout: string;
    stderr: string;
  }>>([]);

  const saveTask = (task: CommandTask) => {
    const normalized = {
      ...task,
      name: task.name.trim(),
      description: task.description.trim(),
      commands: task.commands.map((command) => command.trim()).filter(Boolean),
      workingDirectory: task.workingDirectory?.trim() || undefined,
      updatedAt: Date.now(),
    };
    if (!normalized.name || !normalized.commands.length) {
      notify("请填写任务名称和至少一条命令");
      return;
    }
    model.setSnapshot((current) => ({
      ...current,
      commandTasks: current.commandTasks.some((item) => item.id === normalized.id)
        ? current.commandTasks.map((item) =>
            item.id === normalized.id ? normalized : item,
          )
        : [normalized, ...current.commandTasks],
    }));
    setDraft(null);
    notify("命令任务已保存");
  };

  return (
    <>
      <SectionHeading
        eyebrow="TOOL 05 · AUTOMATION"
        title={model.snapshot.settings.branding.toolNames.automation}
        description="把重复的终端步骤保存为任务。每条命令结束后，下一条才会开始。"
        action={
          <Switch
            checked={enabled}
            onChange={(value) => model.setToolEnabled("automation", value)}
            label={model.snapshot.settings.branding.toolNames.automation}
          />
        }
      />
      <div className="page-toolbar">
        <div className="toolbar-state">
          <Terminal size={16} />
          <span>命令严格串行；任一命令失败后立即停止后续步骤</span>
        </div>
        <button
          className="button primary"
          onClick={() =>
            setDraft({
              id: `command-${Date.now()}`,
              name: "",
              description: "",
              commands: [""],
              showTerminal: true,
              closeTerminalOnFinish: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            })
          }
        >
          <Plus size={17} /> 新建任务
        </button>
      </div>

      {draft ? (
        <form
          className="content-card command-editor"
          onSubmit={(event) => {
            event.preventDefault();
            saveTask(draft);
          }}
        >
          <div className="command-editor-grid">
            <label>
              <span>任务名称</span>
              <input
                aria-label="任务名称"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="例如：初始化 Python 环境"
              />
            </label>
            <label>
              <span>工作目录（可选）</span>
              <input
                aria-label="命令工作目录"
                value={draft.workingDirectory ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, workingDirectory: event.target.value })
                }
                placeholder="D:\Workspace\Project"
              />
            </label>
          </div>
          <label>
            <span>描述</span>
            <input
              aria-label="任务描述"
              value={draft.description}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
              placeholder="说明这个任务会完成什么"
            />
          </label>
          <label>
            <span>命令列表（每行一条，按顺序执行）</span>
            <textarea
              aria-label="命令列表"
              rows={7}
              value={draft.commands.join("\n")}
              onChange={(event) =>
                setDraft({ ...draft, commands: event.target.value.split("\n") })
              }
              placeholder={"python -m venv .venv\n.venv\\Scripts\\python -m pip install -r requirements.txt"}
            />
          </label>
          <div className="command-terminal-options">
            <label className="command-terminal-option">
              <span>
                <strong>显示命令窗口</strong>
                <small>全部命令会在同一个终端中按顺序执行，不再为每条命令重复弹窗。</small>
              </span>
              <Switch
                checked={draft.showTerminal}
                label="显示命令窗口"
                onChange={(showTerminal) => setDraft({ ...draft, showTerminal })}
              />
            </label>
            <label className={`command-terminal-option ${draft.showTerminal ? "" : "disabled"}`}>
              <span>
                <strong>运行完毕后关闭终端</strong>
                <small>关闭此项可保留终端，适合开发服务器、监听任务或执行完成后继续输入命令。</small>
              </span>
              <Switch
                checked={draft.closeTerminalOnFinish}
                label="运行完毕后关闭终端"
                disabled={!draft.showTerminal}
                onChange={(closeTerminalOnFinish) =>
                  setDraft({ ...draft, closeTerminalOnFinish })
                }
              />
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="button ghost" onClick={() => setDraft(null)}>
              取消
            </button>
            <button type="submit" className="button primary">保存任务</button>
          </div>
        </form>
      ) : null}

      <section className="automation-grid">
        {model.snapshot.commandTasks.map((task) => (
          <article className="content-card command-task-card" key={task.id}>
            <header>
              <span className="task-terminal"><Terminal size={19} /></span>
              <div>
                <h3>{task.name}</h3>
                <p>{task.description || "无描述"}</p>
              </div>
              <span className="command-count">{task.commands.length} 步</span>
            </header>
            <ol>
              {task.commands.slice(0, 4).map((command, index) => (
                <li key={`${task.id}-${index}`}><code>{command}</code></li>
              ))}
            </ol>
            <footer>
              <button className="button ghost" onClick={() => setDraft(task)}>
                <Settings size={15} /> 编辑
              </button>
              <button
                className="icon-button danger"
                aria-label={`删除 ${task.name}`}
                onClick={() =>
                  model.setSnapshot((current) => ({
                    ...current,
                    commandTasks: current.commandTasks.filter((item) => item.id !== task.id),
                  }))
                }
              >
                <Trash2 size={16} />
              </button>
              <button
                className="button primary run-task"
                disabled={runningId !== null}
                onClick={() => {
                  setRunningId(task.id);
                  setLogs([]);
                  void runCommandTask(task)
                    .then((results) => {
                      setLogs(results);
                      const failed = results.find((result) => !result.success);
                       notify(
                         failed
                           ? `任务在“${failed.command}”处停止`
                           : task.showTerminal && !task.closeTerminalOnFinish
                             ? `任务“${task.name}”已在终端中启动`
                             : `任务“${task.name}”已完成`,
                       );
                    })
                    .catch((error: unknown) => notify(`执行失败：${String(error)}`))
                    .finally(() => setRunningId(null));
                }}
              >
                <Play size={15} />
                {runningId === task.id ? "执行中…" : "运行"}
              </button>
            </footer>
          </article>
        ))}
        {!model.snapshot.commandTasks.length && !draft ? (
          <EmptyState
            icon={<Terminal size={28} />}
            title="还没有自动化任务"
            description="把安装依赖、构建、备份等连续命令保存下来，一次点击顺序完成。"
            fullSpan
          />
        ) : null}
      </section>

      {logs.length ? (
        <section className="content-card command-console" aria-label="命令执行结果">
          <header><Terminal size={17} /><strong>执行结果</strong></header>
          {logs.map((result, index) => (
            <div className={result.success ? "success" : "failed"} key={`${result.command}-${index}`}>
              <p><span>{result.success ? "✓" : "×"}</span><code>{result.command}</code><em>退出码 {result.exitCode ?? "—"}</em></p>
              {result.stdout ? <pre>{result.stdout}</pre> : null}
              {result.stderr ? <pre className="stderr">{result.stderr}</pre> : null}
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}

function FolderFavoritesPage({
  model,
  notify,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
}) {
  const enabled = model.snapshot.tools.folders.enabled;
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<string | null>(null);
  const [draft, setDraft] = useState<FolderFavorite | null>(null);
  const allFavorites = useMemo(
    () => model.snapshot.folderFavorites.map(normalizeFolderFavorite),
    [model.snapshot.folderFavorites],
  );
  const availableGroups = useMemo(
    () =>
      groupFolderFavorites(allFavorites, model.snapshot.folderGroups).map(
        (group) => group.name,
      ),
    [allFavorites, model.snapshot.folderGroups],
  );
  const visibleGroups = useMemo(
    () =>
      groupFolderFavorites(
        filterFolderFavorites(allFavorites, {
          query,
          group: groupFilter,
        }),
        !query ? model.snapshot.folderGroups.filter(
          (group) => !groupFilter || group === groupFilter,
        ) : [],
      ),
    [allFavorites, groupFilter, model.snapshot.folderGroups, query],
  );
  const createGroup = () => {
    const name = newGroupName.trim().normalize("NFKC").slice(0, 24);
    if (!name) {
      notify("请输入分组名称");
      return;
    }
    if (availableGroups.some((group) => group.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      notify("这个分组已经存在");
      return;
    }
    model.setSnapshot((current) => ({
      ...current,
      folderGroups: [...current.folderGroups, name],
    }));
    setNewGroupName("");
    setCreatingGroup(false);
    setGroupFilter(name);
    notify("分组已创建");
  };
  const saveGroupName = () => {
    if (!editingGroup) return;
    const name = newGroupName.trim().normalize("NFKC").slice(0, 24);
    if (!name) {
      notify("请输入分组名称");
      return;
    }
    if (
      availableGroups.some(
        (group) =>
          group !== editingGroup &&
          group.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      notify("这个分组已经存在");
      return;
    }
    model.setSnapshot((current) => ({
      ...current,
      folderGroups: current.folderGroups.map((group) =>
        group === editingGroup ? name : group,
      ),
      folderFavorites: current.folderFavorites.map((favorite) =>
        normalizeFolderFavorite(favorite).group === editingGroup
          ? { ...favorite, group: name }
          : favorite,
      ),
    }));
    if (groupFilter === editingGroup) setGroupFilter(name);
    setEditingGroup(null);
    setNewGroupName("");
    notify("分组名称已更新");
  };
  const confirmDeleteGroup = () => {
    if (!deletingGroup) return;
    model.setSnapshot((current) => ({
      ...current,
      folderGroups: current.folderGroups.filter((group) => group !== deletingGroup),
      folderFavorites: current.folderFavorites.filter(
        (favorite) => normalizeFolderFavorite(favorite).group !== deletingGroup,
      ),
    }));
    if (groupFilter === deletingGroup) setGroupFilter("");
    setDeletingGroup(null);
    notify("分组和其中的收藏已删除");
  };
  const addFolder = async () => {
    const path = await chooseDirectory();
    if (!path) return;
    if (model.snapshot.folderFavorites.some((item) => item.path === path)) {
      notify("这个文件夹已经收藏");
      return;
    }
    const favorite: FolderFavorite = {
      id: `folder-${Date.now()}`,
      name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
      path,
      description: "",
      group: DEFAULT_FOLDER_GROUP,
      tags: [],
      alias: "",
      shortcut: "",
      createdAt: Date.now(),
    };
    model.setSnapshot((current) => ({
      ...current,
      folderFavorites: [favorite, ...current.folderFavorites],
    }));
    setDraft(favorite);
    notify("文件夹已收藏");
  };
  const saveDraft = () => {
    if (!draft) return;
    const normalized = normalizeFolderFavorite({
      ...draft,
      shortcut: normalizeFolderShortcut(draft.shortcut),
      tags: normalizeFolderTags(draft.tags),
    });
    if (draft.shortcut && !normalized.shortcut) {
      notify("快捷键无效，请使用 Ctrl/Alt/Shift 加一个按键");
      return;
    }
    const conflict = findFolderShortcutConflict(
      model.snapshot.folderFavorites,
      normalized.shortcut,
      normalized.id,
    );
    if (conflict) {
      notify(`快捷键已被“${conflict.alias || conflict.name}”使用`);
      return;
    }
    const toolConflict = Object.entries(model.snapshot.settings.shortcuts).find(
      ([, shortcut]) =>
        normalized.shortcut &&
        shortcut.toLocaleLowerCase() === normalized.shortcut.toLocaleLowerCase(),
    );
    if (toolConflict) {
      notify("该快捷键已被工具快捷窗口使用，请换一个组合键");
      return;
    }
    model.setSnapshot((current) => ({
      ...current,
      folderFavorites: current.folderFavorites.map((favorite) =>
        favorite.id === normalized.id ? normalized : favorite,
      ),
    }));
    setDraft(null);
    notify("文件夹收藏设置已保存");
  };
  return (
    <>
      <SectionHeading
        eyebrow="TOOL 06 · PLACES"
        title={model.snapshot.settings.branding.toolNames.folders}
        description="收藏经常使用的项目、资料和下载目录，随时一键打开。"
        action={
          <Switch
            checked={enabled}
            onChange={(value) => model.setToolEnabled("folders", value)}
            label={model.snapshot.settings.branding.toolNames.folders}
          />
        }
      />
      <div className="page-toolbar">
        <div className="folder-filter-bar">
          <label>
            <Search size={15} />
            <input
              aria-label="搜索文件夹收藏"
              placeholder="搜索名称、别名、标签或路径"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="按分组筛选文件夹"
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.target.value)}
          >
            <option value="">全部分组</option>
            {availableGroups.map((group) => (
              <option value={group} key={group}>{group}</option>
            ))}
          </select>
          <span>{allFavorites.length} 个常用位置</span>
        </div>
        <div className="folder-toolbar-actions">
          <button className="button ghost" disabled={!enabled} onClick={() => setCreatingGroup(true)}>
            <Layers3 size={16} /> 新建分组
          </button>
          <button className="button primary" disabled={!enabled} onClick={() => void addFolder()}>
            <Plus size={17} /> 收藏文件夹
          </button>
        </div>
      </div>
      {creatingGroup || editingGroup ? (
        <section
          className="content-card folder-group-creator"
          aria-label={editingGroup ? "编辑文件夹分组" : "新建文件夹分组"}
        >
          <label>
            <span>{editingGroup ? "编辑分组名称" : "分组名称"}</span>
            <input
              aria-label={editingGroup ? "编辑分组名称" : "分组名称"}
              autoFocus
              maxLength={24}
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  if (editingGroup) saveGroupName();
                  else createGroup();
                }
                if (event.key === "Escape") {
                  setCreatingGroup(false);
                  setEditingGroup(null);
                }
              }}
              placeholder="例如：项目、学习资料"
            />
          </label>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              setCreatingGroup(false);
              setEditingGroup(null);
              setNewGroupName("");
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="button primary"
            aria-label={editingGroup ? "保存分组" : "创建"}
            onClick={editingGroup ? saveGroupName : createGroup}
          >
            {editingGroup ? "保存" : "创建"}
          </button>
        </section>
      ) : null}
      {draft ? (
        <section className="content-card folder-favorite-editor" aria-label="编辑文件夹收藏">
          <header>
            <div><strong>整理收藏</strong><small>{draft.path}</small></div>
            <button type="button" className="icon-button" aria-label="关闭编辑" onClick={() => setDraft(null)}>
              <X size={16} />
            </button>
          </header>
          <div className="folder-editor-grid">
            <label><span>别名</span><input aria-label="文件夹别名" placeholder={draft.name} value={draft.alias ?? ""} onChange={(event) => setDraft({ ...draft, alias: event.target.value })} /></label>
            <label>
              <span>分组</span>
              <select
                aria-label="文件夹分组"
                value={draft.group || DEFAULT_FOLDER_GROUP}
                onChange={(event) => setDraft({ ...draft, group: event.target.value })}
              >
                {availableGroups.map((group) => (
                  <option value={group} key={group}>{group}</option>
                ))}
              </select>
            </label>
            <label><span>标签（最多 5 个，每个 12 字）</span><input aria-label="文件夹标签" placeholder="项目，常用" value={(draft.tags ?? []).join("，")} onChange={(event) => setDraft({ ...draft, tags: event.target.value.split(/[,，]/) })} /></label>
            <label className="folder-shortcut-field"><span>快捷键</span><ShortcutRecorder value={draft.shortcut || "点击录制"} onChange={(shortcut) => setDraft({ ...draft, shortcut })} /></label>
          </div>
          <label className="folder-description-field"><span>描述（最多 120 字）</span><input maxLength={120} aria-label="文件夹描述" placeholder="这个文件夹用于什么" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <footer><button type="button" className="button ghost" onClick={() => setDraft(null)}>取消</button><button type="button" className="button primary" onClick={saveDraft}>保存设置</button></footer>
        </section>
      ) : null}
      <section className="folder-groups">
        {visibleGroups.map((group) => (
          <div className="folder-group" key={group.name}>
            <header>
              <span><Folder size={15} /></span>
              <strong>{group.name}</strong>
              <small>{group.items.length}</small>
              {group.name !== DEFAULT_FOLDER_GROUP ? (
                <div className="folder-group-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`编辑分组 ${group.name}`}
                    onClick={() => {
                      setCreatingGroup(false);
                      setEditingGroup(group.name);
                      setNewGroupName(group.name);
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={`删除分组 ${group.name}`}
                    onClick={() => setDeletingGroup(group.name)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ) : null}
            </header>
            <div className="folder-favorites-grid">
              {group.items.map((favorite) => (
                <article className="content-card folder-favorite-card" key={favorite.id}>
                  <button disabled={!enabled} className="folder-open-target" onClick={() => void openTarget(favorite.path)}>
                    <span className="folder-icon"><FolderOpen size={24} /></span>
                    <strong>{favorite.alias || favorite.name}</strong>
                    {favorite.alias ? <em>{favorite.name}</em> : null}
                    {favorite.description ? (
                      <p className="folder-description" title={favorite.description}>
                        {favorite.description}
                      </p>
                    ) : null}
                    <small title={favorite.path}>{favorite.path}</small>
                    {favorite.tags.length ? <span className="folder-tags">{favorite.tags.map((tag) => <i key={tag}><Tag size={11} />{tag}</i>)}</span> : null}
                    {favorite.shortcut ? <kbd className="folder-shortcut">{favorite.shortcut}</kbd> : null}
                  </button>
                  <div className="folder-card-actions">
                    <button type="button" className="icon-button" aria-label={`编辑 ${favorite.alias || favorite.name}`} onClick={() => setDraft(favorite)}><Pencil size={15} /></button>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`取消收藏 ${favorite.alias || favorite.name}`}
                      onClick={() =>
                        model.setSnapshot((current) => ({
                          ...current,
                          folderFavorites: current.folderFavorites.filter(
                            (item) => item.id !== favorite.id,
                          ),
                        }))
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
        {!allFavorites.length ? (
          <div className="folder-favorites-grid empty-folder-grid">
            <EmptyState
              icon={<Bookmark size={28} />}
              title="还没有收藏文件夹"
              description="收藏后点击卡片即可在资源管理器中打开。"
              fullSpan
            />
          </div>
        ) : !visibleGroups.length ? (
          <div className="folder-favorites-grid empty-folder-grid">
            <EmptyState icon={<Search size={28} />} title="没有匹配的收藏" description="换个关键词或分组试试。" fullSpan />
          </div>
        ) : null}
      </section>
      {deletingGroup ? (
        <div className="modal-backdrop">
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-folder-group-title"
          >
            <span className="confirm-dialog-icon danger"><Trash2 size={20} /></span>
            <div>
              <h2 id="delete-folder-group-title">删除“{deletingGroup}”分组？</h2>
              <p>
                该分组中的{" "}
                {allFavorites.filter((favorite) => favorite.group === deletingGroup).length}{" "}
                个文件夹收藏也会被删除。
              </p>
            </div>
            <footer>
              <button className="button ghost" onClick={() => setDeletingGroup(null)}>取消</button>
              <button
                className="button danger"
                aria-label="删除分组和收藏"
                onClick={confirmDeleteGroup}
              >
                删除分组和收藏
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function BootScenePicker({
  value,
  scenes,
  onChange,
}: {
  value: string;
  scenes: Array<{ id: string; name: string }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options = [{ id: "", name: "无" }, ...scenes];
  const selected = options.find((option) => option.id === value) ?? options[0];

  const focusOption = (position: "first" | "last" | "next" | "previous") => {
    const optionButtons = [
      ...(pickerRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []),
    ];
    if (!optionButtons.length) return;
    const activeIndex = optionButtons.indexOf(document.activeElement as HTMLButtonElement);
    const selectedIndex = optionButtons.findIndex(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    const baseIndex = activeIndex >= 0 ? activeIndex : Math.max(selectedIndex, 0);
    const targetIndex =
      position === "first"
        ? 0
        : position === "last"
          ? optionButtons.length - 1
          : position === "next"
            ? (baseIndex + 1) % optionButtons.length
            : (baseIndex - 1 + optionButtons.length) % optionButtons.length;
    optionButtons[targetIndex]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  return (
    <div
      className={`boot-scene-picker ${open ? "is-open" : ""}`}
      ref={pickerRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? "next" : "previous";
          if (!open) {
            setOpen(true);
            window.requestAnimationFrame(() =>
              focusOption(event.key === "ArrowDown" ? "first" : "last"),
            );
          } else {
            focusOption(direction);
          }
          return;
        }
        if (open && (event.key === "Home" || event.key === "End")) {
          event.preventDefault();
          focusOption(event.key === "Home" ? "first" : "last");
        }
      }}
    >
      <button
        type="button"
        className="boot-scene-trigger"
        ref={triggerRef}
        role="combobox"
        aria-label="开机启动场景"
        aria-controls="boot-scene-options"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
      >
        <Rocket size={15} />
        <span title={selected.name}>{selected.name}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div
          className="boot-scene-options"
          id="boot-scene-options"
          role="listbox"
          aria-label="开机启动场景选项"
        >
          {options.map((option) => {
            const isSelected = option.id === selected.id;
            return (
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                className={isSelected ? "selected" : ""}
                key={option.id || "none"}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span>{option.name}</span>
                {isSelected ? <Check size={14} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function EnhancedSettingsPage({
  model,
  notify,
  indexProgress,
  onStartIndex,
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
  indexProgress: IndexProgress | null;
  onStartIndex: (roots: string[]) => void;
}) {
  type PendingIndexScope = {
    roots: string[];
    title: string;
    description: string;
  };
  const [linkDraft, setLinkDraft] = useState<QuickLink | null>(null);
  const [personalizationOpen, setPersonalizationOpen] = useState(false);
  const [pendingIndexScope, setPendingIndexScope] =
    useState<PendingIndexScope | null>(null);
  const [excludedAppsText, setExcludedAppsText] = useState(
    model.snapshot.settings.clipboardExcludedApps.join(", "),
  );
  const [retentionDaysText, setRetentionDaysText] = useState(
    String(model.snapshot.settings.clipboardRetentionDays),
  );
  const fontScaleProgress = `${Number(
    (((model.snapshot.settings.fontScale - 0.85) / 0.4) * 100).toFixed(1),
  )}%`;

  useEffect(() => {
    setExcludedAppsText(model.snapshot.settings.clipboardExcludedApps.join(", "));
  }, [model.snapshot.settings.clipboardExcludedApps]);

  useEffect(() => {
    setRetentionDaysText(String(model.snapshot.settings.clipboardRetentionDays));
  }, [model.snapshot.settings.clipboardRetentionDays]);

  const normalizeIndexRoots = (roots: string[]) => {
    if (roots.includes("*")) return ["*"];
    return Array.from(
      new Set(
        roots.map((root) =>
          root.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase(),
        ),
      ),
    ).sort();
  };
  const sameIndexScope = (left: string[], right: string[]) =>
    JSON.stringify(normalizeIndexRoots(left)) === JSON.stringify(normalizeIndexRoots(right));
  const indexBuilding = indexProgress?.status === "indexing";
  const indexReady =
    model.snapshot.settings.indexSetup === "ready" &&
    !indexBuilding &&
    indexProgress?.status !== "failed";

  const requestIndexScope = (
    roots: string[],
    title: string,
    description: string,
    alreadyBuiltMessage: string,
  ) => {
    if (
      indexBuilding &&
      sameIndexScope(roots, model.snapshot.settings.indexRoots)
    ) {
      notify(`${roots.includes("*") ? "全盘" : "当前目录"}索引正在建立，请稍候`);
      return;
    }
    if (indexReady && sameIndexScope(roots, model.snapshot.settings.indexRoots)) {
      notify(alreadyBuiltMessage);
      return;
    }
    setPendingIndexScope({ roots, title, description });
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
    requestIndexScope(
      roots,
      "建立指定目录索引？",
      `确认后将把索引范围切换为 ${roots.length} 个指定目录，并重新建立可搜索的文件列表。`,
      "该目录已在当前索引范围中，索引已经建立",
    );
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
    notify("快捷键已更新");
  };
  const updateBranding = (
    patch: Partial<typeof model.snapshot.settings.branding>,
  ) => {
    model.setSetting("branding", {
      ...model.snapshot.settings.branding,
      ...patch,
    });
  };
  const chooseAppearanceAsset = async (
    kind: "font" | "logo" | "avatar" | "background",
  ) => {
    try {
      const path = await importAppearanceAsset(kind);
      if (!path) return;
      if (kind === "font") {
        const name = path.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, "") ?? "自定义字体";
        const font = { id: `font-${Date.now()}`, name, path };
        model.setSetting("customFonts", [
          ...model.snapshot.settings.customFonts,
          font,
        ]);
        model.setSetting("activeCustomFontId", font.id);
      } else {
        updateBranding({ [`${kind}Path`]: path });
      }
      notify(
        kind === "font"
          ? "字体已导入并启用"
          : kind === "background"
            ? "背景图片已导入"
            : kind === "logo"
              ? "软件图标已更新"
              : "工作区头像已更新",
      );
    } catch (error) {
      notify(`导入失败：${String(error)}`);
    }
  };
  const importTheme = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as {
        name?: string;
        mode?: "light" | "dark";
        colors?: Record<string, string>;
      };
      const required = ["paper", "panel", "card", "ink", "muted", "accent", "moss"];
      const optional = [
        "sidebar",
        "sidebarActive",
        "sidebarInk",
        "sidebarMuted",
        "line",
        "lineStrong",
        "brandSurface",
        "brandInk",
      ];
      if (
        !parsed.name ||
        !parsed.colors ||
        required.some((key) => !/^#[0-9a-f]{6}$/i.test(parsed.colors?.[key] ?? "")) ||
        optional.some(
          (key) =>
            parsed.colors?.[key] !== undefined &&
            !/^#[0-9a-f]{6}$/i.test(parsed.colors[key]),
        )
      ) {
        throw new Error("主题需要名称及 paper、panel、card、ink、muted、accent、moss 七个十六进制颜色");
      }
      const theme = {
        id: `theme-${Date.now()}`,
        name: parsed.name.slice(0, 32),
        mode: parsed.mode === "dark" ? "dark" as const : "light" as const,
        colors: parsed.colors as typeof model.snapshot.settings.customThemes[number]["colors"],
      };
      model.setSetting("customThemes", [...model.snapshot.settings.customThemes, theme]);
      model.setSetting("activeCustomThemeId", theme.id);
      recordRuntimeEvent(
        "appearance.theme.import",
        "success",
        `theme_id=${theme.id} mode=${theme.mode}`,
      );
      notify("主题已导入并启用");
    } catch (error) {
      recordRuntimeEvent("appearance.theme.import", "failed", String(error));
      notify(`主题导入失败：${String(error)}`);
    }
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
            <div><h2>数据与存储</h2><p>固定保存在软件安装目录内部的 data 文件夹。</p></div>
          </header>
          <div className="setting-row storage-row">
            <span className="drive-icon"><HardDrive size={22} /></span>
            <div>
              <strong>当前存储位置</strong>
              <code>{model.snapshot.settings.dataDirectory}</code>
              <small>存储位置跟随软件安装目录</small>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>运行日志</strong>
              <small>
                记录功能调用、耗时、执行结果和错误；日志保存在当前 data\logs 目录。
              </small>
            </div>
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void openRuntimeLog().catch((error) =>
                  notify(`打开运行日志失败：${String(error)}`),
                )
              }
            >
              <FileText size={16} /> 查看日志
            </button>
          </div>
        </section>

        <section className="settings-section boot-settings-section">
          <header>
            <Power size={19} />
            <div>
              <h2>开机自启动</h2>
              <p>Atlas 必须随 Windows 开机自启动，才能在开机后执行所选启动场景。</p>
            </div>
          </header>
          <div className="setting-row">
            <div>
              <strong>开机自启动 Atlas</strong>
              <small>关闭后，仍可手动打开 Atlas 和运行任意场景。</small>
            </div>
            <Switch
              checked={model.snapshot.settings.launchAtLogin}
              label="开机自启动 Atlas"
              onChange={(launchAtLogin) =>
                model.setSetting("launchAtLogin", launchAtLogin)
              }
            />
          </div>
          <div className="setting-row boot-scene-row">
            <div>
              <strong>开机时运行场景</strong>
              <small>选择“无”时只启动 Atlas，不自动打开场景中的应用。</small>
            </div>
            <BootScenePicker
              value={model.snapshot.settings.loginSceneId}
              scenes={model.snapshot.startupScenes}
              onChange={(sceneId) => model.setSetting("loginSceneId", sceneId)}
            />
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
                  parameterName: "",
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
                const parameterName =
                  linkDraft.parameterName?.trim() ||
                  linkDraft.urlTemplate.match(/\{([a-zA-Z][\w-]*)\}/)?.[1] ||
                  "";
                if (
                  parameterName &&
                  !linkDraft.urlTemplate
                    .toLocaleLowerCase()
                    .includes(`{${parameterName}}`.toLocaleLowerCase())
                ) {
                  notify(`链接模板中需要包含 {${parameterName}}`);
                  return;
                }
                model.upsertQuickLink({
                  ...linkDraft,
                  name: linkDraft.name.trim(),
                  description: linkDraft.description.trim(),
                  keyword: linkDraft.keyword.trim(),
                  parameterName,
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
                aria-label="链接参数名"
                placeholder="参数名（可选），例如 query"
                value={linkDraft.parameterName ?? ""}
                onChange={(event) =>
                  setLinkDraft({ ...linkDraft, parameterName: event.target.value })
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
                无参数链接请留空。填写参数名 <code>query</code> 后，在网址中使用
                <code>{"{query}"}</code>。强制使用 Edge：
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
                {link.keyword ? (
                  <code>
                    {link.keyword}
                    {link.parameterName ? ` {${link.parameterName}}` : ""}
                  </code>
                ) : null}
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
          <header className="settings-section-header-with-action">
            <Keyboard size={19} />
            <div><h2>全局快捷键</h2><p>修改后自动重新注册，并在下一次启动时恢复。</p></div>
            <button
              type="button"
              className="button secondary settings-header-action"
              aria-label="恢复默认快捷键"
              onClick={() => {
                model.setSetting("shortcuts", { ...DEFAULT_SHORTCUTS });
                notify("已恢复默认快捷键");
              }}
            >
              <RotateCcw size={14} /> 恢复默认
            </button>
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

        <section className="settings-section personalization-settings">
          <header className="settings-section-header-with-action">
            <Sparkles size={19} />
            <div>
              <h2>全局个性化</h2>
              <p>统一配置品牌文字、工具名称、头像、字体、主题和背景。</p>
            </div>
            <button
              type="button"
              className="button secondary settings-header-action"
              onClick={() => setPersonalizationOpen((value) => !value)}
              aria-expanded={personalizationOpen}
            >
              {personalizationOpen ? "收起配置" : "打开配置"}
            </button>
          </header>
          {personalizationOpen ? (
            <div className="personalization-panel">
              <div className="personalization-grid">
                {([
                  ["appName", "软件名称"],
                  ["appDescription", "软件描述"],
                  ["workspaceName", "工作区名称"],
                  ["workspaceDescription", "工作区描述"],
                ] as const).map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <input
                      maxLength={48}
                      value={model.snapshot.settings.branding[key]}
                      onChange={(event) => updateBranding({ [key]: event.target.value })}
                    />
                  </label>
                ))}
              </div>
              <div className="personalization-subsection">
                <strong>工具名称</strong>
                <div className="personalization-grid tool-name-grid">
                  {(Object.keys(model.snapshot.settings.branding.toolNames) as ToolId[]).map((tool) => (
                    <label key={tool}>
                      <span>{toolMeta[tool].title}</span>
                      <input
                        maxLength={16}
                        value={model.snapshot.settings.branding.toolNames[tool]}
                        onChange={(event) => updateBranding({
                          toolNames: {
                            ...model.snapshot.settings.branding.toolNames,
                            [tool]: event.target.value,
                          },
                        })}
                      />
                    </label>
                  ))}
                </div>
              </div>
              <div className="appearance-asset-actions">
                <button type="button" className="button secondary" onClick={() => void chooseAppearanceAsset("logo")}>导入软件图标</button>
                <button type="button" className="button secondary" onClick={() => void chooseAppearanceAsset("avatar")}>导入工作区头像</button>
                <button type="button" className="button secondary" onClick={() => void chooseAppearanceAsset("background")}>导入背景图片</button>
              </div>
              <div className="appearance-control-grid">
                <section className="appearance-control-card">
                  <div>
                    <strong>界面字体</strong>
                    <small>内置字体与导入字体统一管理</small>
                  </div>
                  <select
                    aria-label="界面字体"
                    value={
                      model.snapshot.settings.activeCustomFontId
                        ? `custom:${model.snapshot.settings.activeCustomFontId}`
                        : `builtin:${model.snapshot.settings.fontFamily}`
                    }
                    onChange={(event) => {
                      if (event.target.value.startsWith("custom:")) {
                        model.setSetting("activeCustomFontId", event.target.value.slice(7));
                        notify("界面字体已更新");
                        return;
                      }
                      model.setSetting("activeCustomFontId", "");
                      model.setSetting(
                        "fontFamily",
                        event.target.value.slice(8) as typeof model.snapshot.settings.fontFamily,
                      );
                      notify("界面字体已更新");
                    }}
                  >
                    <option value="builtin:system">系统黑体</option>
                    <option value="builtin:serif">人文宋体</option>
                    <option value="builtin:yahei">微软雅黑</option>
                    {model.snapshot.settings.customFonts.map((font) => (
                      <option key={font.id} value={`custom:${font.id}`}>{font.name}</option>
                    ))}
                  </select>
                  <div className="appearance-control-actions">
                   <button type="button" className="button secondary" onClick={() => void chooseAppearanceAsset("font")}>
                     导入字体
                   </button>
                  <button
                    type="button"
                    className="button ghost danger"
                    aria-label="删除所选字体"
                    disabled={!model.snapshot.settings.activeCustomFontId}
                    onClick={() => {
                      const font = model.snapshot.settings.customFonts.find(
                        (item) => item.id === model.snapshot.settings.activeCustomFontId,
                      );
                      if (!font) return;
                      model.setSetting("customFonts", model.snapshot.settings.customFonts.filter((item) => item.id !== font.id));
                      model.setSetting("activeCustomFontId", "");
                      notify("导入字体已删除，已恢复默认字体");
                    }}
                   >
                    <Trash2 size={14} /> 删除导入字体
                   </button>
                  </div>
                </section>
                <section className="appearance-control-card">
                  <div>
                    <strong>文字大小</strong>
                    <small>{Math.round(model.snapshot.settings.fontScale * 100)}%，界面会同步自适应</small>
                  </div>
                  <div
                    className="font-scale-slider"
                    style={{ "--font-scale-progress": fontScaleProgress } as CSSProperties}
                  >
                    <input
                      aria-label="文字大小"
                      type="range"
                      min="0.85"
                      max="1.25"
                      step="0.05"
                      value={model.snapshot.settings.fontScale}
                      onChange={(event) => model.setSetting("fontScale", Number(event.target.value))}
                    />
                  </div>
                </section>
                <section className="appearance-control-card">
                  <div>
                    <strong>界面主题</strong>
                    <small>内置明暗模式与导入主题统一管理</small>
                  </div>
                  <select
                    aria-label="界面主题"
                    value={
                      model.snapshot.settings.activeCustomThemeId
                        ? `custom:${model.snapshot.settings.activeCustomThemeId}`
                        : `builtin:${model.snapshot.settings.theme}`
                    }
                    onChange={(event) => {
                      if (event.target.value.startsWith("custom:")) {
                        model.setSetting("activeCustomThemeId", event.target.value.slice(7));
                        notify("界面主题已更新");
                        return;
                      }
                      model.setSetting("activeCustomThemeId", "");
                      model.setTheme(event.target.value.slice(8) as "light" | "dark");
                      notify("界面主题已更新");
                    }}
                  >
                    <option value="builtin:light">浅色</option>
                    <option value="builtin:dark">深色</option>
                    {model.snapshot.settings.customThemes.map((theme) => (
                      <option key={theme.id} value={`custom:${theme.id}`}>{theme.name}</option>
                    ))}
                  </select>
                  <div className="appearance-control-actions">
                   <label className="theme-file-button button secondary">
                     导入主题 JSON
                    <input type="file" accept=".json,application/json" onChange={(event) => {
                      void importTheme(event.target.files?.[0]);
                      event.currentTarget.value = "";
                    }} />
                  </label>
                  <button
                    type="button"
                    className="button ghost danger"
                    aria-label="删除所选主题"
                    disabled={!model.snapshot.settings.activeCustomThemeId}
                    onClick={() => {
                      const themeId = model.snapshot.settings.activeCustomThemeId;
                      if (!themeId) return;
                      model.setSetting(
                        "customThemes",
                        model.snapshot.settings.customThemes.filter((theme) => theme.id !== themeId),
                      );
                      model.setSetting("activeCustomThemeId", "");
                      notify("导入主题已删除，已恢复内置主题");
                    }}
                   >
                    <Trash2 size={14} /> 删除导入主题
                   </button>
                  </div>
                </section>
                <section className="appearance-control-card">
                  <div>
                    <strong>背景图片透明度</strong>
                    <small>
                      {Math.round(model.snapshot.settings.backgroundOpacity * 100)}%，
                      背景会覆盖标题栏与侧边栏
                    </small>
                  </div>
                  <div
                    className="font-scale-slider"
                    style={{
                      "--font-scale-progress":
                        `${((model.snapshot.settings.backgroundOpacity - 0.05) / 0.85) * 100}%`,
                    } as CSSProperties}
                  >
                    <input
                      aria-label="背景图片透明度"
                      type="range"
                      min="0.05"
                      max="0.9"
                      step="0.05"
                      value={model.snapshot.settings.backgroundOpacity}
                      disabled={!model.snapshot.settings.branding.backgroundPath}
                      onChange={(event) =>
                        model.setSetting("backgroundOpacity", Number(event.target.value))
                      }
                    />
                  </div>
                </section>
              </div>
              <div className="personalization-footer">
                <small>
                  默认字体不可删除。主题还可设置 sidebar、sidebarActive、sidebarInk、
                  sidebarMuted、line、brandSurface 等颜色。
                </small>
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => {
                    model.setSetting("branding", {
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
                    });
                    model.setSetting("activeCustomFontId", "");
                    model.setSetting("activeCustomThemeId", "");
                    model.setTheme("light");
                    model.setSetting("fontFamily", "system");
                    model.setSetting("fontScale", 1);
                    model.setSetting("backgroundOpacity", 0.35);
                    notify("已恢复默认外观与品牌文字");
                  }}
                >
                  <RotateCcw size={14} /> 恢复默认外观
                </button>
              </div>
            </div>
          ) : null}
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
              <span
                className={`index-scope-status ${
                  indexBuilding ? "building" : indexReady ? "ready" : "missing"
                }`}
              >
                {indexBuilding
                  ? "正在建立索引"
                  : indexReady
                    ? "索引已建立"
                    : "未建立索引"}
              </span>
            </div>
            <div className="setting-actions">
              <button
                className="button primary"
                disabled={indexBuilding}
                onClick={() => onStartIndex(model.snapshot.settings.indexRoots)}
              >
                <FileSearch size={16} />
                {indexReady ? "重建索引" : "建立索引"}
              </button>
              <button
                className="button secondary"
                onClick={() =>
                  requestIndexScope(
                    ["*"],
                    "建立全部磁盘索引？",
                    "确认后将索引电脑上的所有可用磁盘，并替换当前索引范围。建立期间仍可继续使用其他工具。",
                    "当前全盘索引已经建立，无需重复建立",
                  )
                }
              >
                <HardDrive size={16} /> 全部磁盘
              </button>
              <button className="button secondary" onClick={() => void addRoot()}>
                <Plus size={16} /> 添加目录
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <header>
            <Clipboard size={19} />
            <div><h2>剪贴板历史与隐私</h2><p>控制本地保留周期，并避开密码管理器等敏感应用。</p></div>
          </header>
          <div className="setting-row">
            <div>
              <strong>暂停采集</strong>
              <small>已有历史仍可使用，恢复后再记录新的复制内容。</small>
            </div>
            <Switch
              checked={model.snapshot.settings.clipboardCapturePaused}
              label="暂停剪贴板采集"
              onChange={(clipboardCapturePaused) =>
                model.setSetting("clipboardCapturePaused", clipboardCapturePaused)
              }
            />
          </div>
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
          <label className="setting-row">
            <div><strong>保留天数</strong><small>到期记录和对应图片会自动清理</small></div>
            <input
              aria-label="剪贴板保留天数"
              className="number-setting no-native-spinner"
              type="number"
              min="1"
              max="3650"
              value={retentionDaysText}
              onChange={(event) => setRetentionDaysText(event.target.value)}
              onBlur={() => {
                const days = Math.min(
                  3650,
                  Math.max(1, Number(retentionDaysText) || 30),
                );
                setRetentionDaysText(String(days));
                model.setSetting("clipboardRetentionDays", days);
              }}
            />
          </label>
          <label className="setting-row privacy-apps-setting">
            <div>
              <strong>敏感应用排除</strong>
              <small>逗号分隔进程名；这些应用位于前台时不会读取剪贴板</small>
            </div>
            <textarea
              aria-label="不记录这些应用"
              rows={2}
              value={excludedAppsText}
              onChange={(event) => setExcludedAppsText(event.target.value)}
              onBlur={() =>
                model.setSetting(
                  "clipboardExcludedApps",
                  Array.from(
                    new Set(
                      excludedAppsText
                        .split(/[,，\n]/)
                        .map((item) => item.trim())
                        .filter(Boolean),
                    ),
                  ),
                )
              }
            />
          </label>
        </section>

        <section className="settings-section">
          <header>
            <AppWindow size={19} />
            <div><h2>窗口行为</h2><p>控制关闭主窗口时是否需要再次确认。</p></div>
          </header>
          <div className="setting-row">
            <div>
              <strong>关闭前确认</strong>
              <small>避免误触关闭；确认框中也可以选择以后不再提醒。</small>
            </div>
            <Switch
              checked={model.snapshot.settings.confirmOnClose}
              label="关闭窗口前确认"
              onChange={(confirmOnClose) => model.setSetting("confirmOnClose", confirmOnClose)}
            />
          </div>
        </section>
      </div>
      {pendingIndexScope ? (
        <div className="modal-backdrop">
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-index-scope-title"
          >
            <span className="confirm-dialog-icon"><FileSearch size={20} /></span>
            <div>
              <h2 id="confirm-index-scope-title">{pendingIndexScope.title}</h2>
              <p>{pendingIndexScope.description}</p>
            </div>
            <footer>
              <button className="button ghost" onClick={() => setPendingIndexScope(null)}>
                取消
              </button>
              <button
                className="button primary"
                onClick={() => {
                  const roots = pendingIndexScope.roots;
                  setPendingIndexScope(null);
                  onStartIndex(roots);
                }}
              >
                确认建立
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
