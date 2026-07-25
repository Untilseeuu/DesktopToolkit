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
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  Play,
  Rocket,
  Save,
  Search,
  Settings,
  Sparkles,
  Terminal,
  Sun,
  Tag,
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
import {
  activateClipboardEntry,
  bindNativeSearchShortcut,
  captureStartupSceneLayout,
  chooseDirectory,
  chooseExecutable,
  closePreviousStartupScene,
  copyText,
  getSearchIndexCount,
  getSearchIndexStatus,
  getAppIcons,
  invokeNative,
  launchStartupItems,
  listStartupSceneMonitors,
  openTarget,
  rebuildSearchIndex,
  restoreStartupSceneLayout,
  runCommandTask,
  searchNative,
} from "./native";
import QuickOverlay from "./QuickOverlay";
import { SearchQueryInput } from "./SearchQueryInput";
import WindowChrome from "./WindowChrome";
import type {
  CommandTask,
  FolderFavorite,
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
  const overlay = new URLSearchParams(window.location.search).get("overlay");
  if (overlay === "search" || overlay === "prompts" || overlay === "clipboard") {
    return <QuickOverlay mode={overlay} />;
  }
  return (
    <div className="desktop-frame">
      <WindowChrome />
      <MainApp />
    </div>
  );
}

function MainApp() {
  const model = useToolkit();
  const [activeNav, setActiveNav] = useState<NavId>("overview");
  const [toast, setToast] = useState<string | null>(null);
  const mainPanelRef = useRef<HTMLElement>(null);

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

  useEffect(() => {
    if (mainPanelRef.current) mainPanelRef.current.scrollTop = 0;
  }, [activeNav]);

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
      case "automation":
        return <AutomationPage model={model} notify={setToast} />;
      case "folders":
        return <FolderFavoritesPage model={model} notify={setToast} />;
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
          <span className="brand-mark brand-mark--fixed-contrast">
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

      <main className="main-panel" ref={mainPanelRef}>
        <div className="page">{page}</div>
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
          <small>{enabledCount} / 6 个工具正在运行</small>
        </div>
      </header>

      <section className="tool-grid" aria-label="工具列表">
        {(Object.keys(toolMeta) as ToolId[]).map((id) => {
          const meta = toolMeta[id];
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
                aria-label={`打开${meta.title}`}
                onClick={() => navigate(id)}
              />
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
    .sort((a, b) => a.order - b.order);
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
        title="启动编排"
        description="为工作、学习或自定义场景安排不同的应用组合，并按顺序启动。"
        action={<Switch checked={enabled} onChange={(value) => model.setToolEnabled("startup", value)} label="启动编排" />}
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
  const displayedResults = results.slice(0, 60);
  const active = displayedResults[selected];

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      const status = (await invokeNative<string>("get_index_status")) ?? "demo";
      if (!active) return;
      setIndexStatus(status);
      timer = window.setTimeout(
        refresh,
        status === "indexing" || status === "idle" ? 1200 : 10_000,
      );
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

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
        title="全局搜索"
        description="搜索应用、文件与文件夹；支持拼音、首字母、常见错拼和同义词。"
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
              <small>存储位置跟随软件安装目录</small>
            </div>
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
        title="自动化命令"
        description="把重复的终端步骤保存为任务。每条命令结束后，下一条才会开始。"
        action={
          <Switch
            checked={enabled}
            onChange={(value) => model.setToolEnabled("automation", value)}
            label="自动化命令"
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
  const [draft, setDraft] = useState<FolderFavorite | null>(null);
  const allFavorites = useMemo(
    () => model.snapshot.folderFavorites.map(normalizeFolderFavorite),
    [model.snapshot.folderFavorites],
  );
  const availableGroups = useMemo(
    () => groupFolderFavorites(allFavorites).map((group) => group.name),
    [allFavorites],
  );
  const visibleGroups = useMemo(
    () =>
      groupFolderFavorites(
        filterFolderFavorites(allFavorites, {
          query,
          group: groupFilter,
        }),
      ),
    [allFavorites, groupFilter, query],
  );
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
        title="文件夹收藏"
        description="收藏经常使用的项目、资料和下载目录，随时一键打开。"
        action={
          <Switch
            checked={enabled}
            onChange={(value) => model.setToolEnabled("folders", value)}
            label="文件夹收藏"
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
        <button className="button primary" disabled={!enabled} onClick={() => void addFolder()}>
          <Plus size={17} /> 收藏文件夹
        </button>
      </div>
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
              <input aria-label="文件夹分组" list="folder-groups" value={draft.group ?? ""} onChange={(event) => setDraft({ ...draft, group: event.target.value })} />
              <datalist id="folder-groups">{availableGroups.map((group) => <option value={group} key={group} />)}</datalist>
            </label>
            <label><span>标签</span><input aria-label="文件夹标签" placeholder="项目，常用" value={(draft.tags ?? []).join("，")} onChange={(event) => setDraft({ ...draft, tags: event.target.value.split(/[,，]/) })} /></label>
            <label className="folder-shortcut-field"><span>快捷键</span><ShortcutRecorder value={draft.shortcut || "点击录制"} onChange={(shortcut) => setDraft({ ...draft, shortcut })} /></label>
          </div>
          <label className="folder-description-field"><span>描述</span><input aria-label="文件夹描述" placeholder="这个文件夹用于什么" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <footer><button type="button" className="button ghost" onClick={() => setDraft(null)}>取消</button><button type="button" className="button primary" onClick={saveDraft}>保存设置</button></footer>
        </section>
      ) : null}
      <section className="folder-groups">
        {visibleGroups.map((group) => (
          <div className="folder-group" key={group.name}>
            <header><span><Folder size={15} /></span><strong>{group.name}</strong><small>{group.items.length}</small></header>
            <div className="folder-favorites-grid">
              {group.items.map((favorite) => (
                <article className="content-card folder-favorite-card" key={favorite.id}>
                  <button disabled={!enabled} className="folder-open-target" onClick={() => void openTarget(favorite.path)}>
                    <span className="folder-icon"><FolderOpen size={24} /></span>
                    <strong>{favorite.alias || favorite.name}</strong>
                    {favorite.alias ? <em>{favorite.name}</em> : null}
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
}: {
  model: ToolkitModel;
  notify: (message: string) => void;
}) {
  const [indexing, setIndexing] = useState(false);
  const [linkDraft, setLinkDraft] = useState<QuickLink | null>(null);
  const [excludedAppsText, setExcludedAppsText] = useState(
    model.snapshot.settings.clipboardExcludedApps.join(", "),
  );
  const [retentionDaysText, setRetentionDaysText] = useState(
    String(model.snapshot.settings.clipboardRetentionDays),
  );

  useEffect(() => {
    setExcludedAppsText(model.snapshot.settings.clipboardExcludedApps.join(", "));
  }, [model.snapshot.settings.clipboardExcludedApps]);

  useEffect(() => {
    setRetentionDaysText(String(model.snapshot.settings.clipboardRetentionDays));
  }, [model.snapshot.settings.clipboardRetentionDays]);

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
              aria-label="界面字体"
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
              <option value="yahei">微软雅黑</option>
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
      </div>
    </>
  );
}
