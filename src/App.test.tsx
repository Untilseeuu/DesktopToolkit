import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { defaultSnapshot } from "./useToolkit";
import stylesheet from "./styles.css?inline";

afterEach(() => localStorage.clear());

describe("Atlas desktop toolkit", () => {
  it("shows all three tools and lets the user disable one independently", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect((await screen.findAllByText("启动编排")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("全局搜索").length).toBeGreaterThan(0);
    expect(screen.getAllByText("提示词库").length).toBeGreaterThan(0);
    expect(screen.getAllByText("剪贴板历史").length).toBeGreaterThan(0);

    const searchSwitch = screen.getByRole("switch", { name: "全局搜索" });
    expect(searchSwitch).toBeChecked();
    await user.click(searchSwitch);
    expect(searchSwitch).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "全局搜索" }));
    expect(await screen.findByText("全局搜索已暂停")).toBeInTheDocument();
  });

  it("exposes working tool switches inside search and prompt pages", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "全局搜索" }));
    const searchSwitch = await screen.findByRole("switch", { name: "全局搜索" });
    await user.click(searchSwitch);
    expect(await screen.findByText("全局搜索已暂停")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "提示词库" }));
    const promptsSwitch = await screen.findByRole("switch", { name: "提示词库" });
    await user.click(promptsSwitch);
    expect(await screen.findByText("提示词库已暂停")).toBeInTheDocument();
  });

  it("expands prompt categories and filters prompt cards", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        prompts: [
          { ...defaultSnapshot.prompts[0], id: "writing", title: "写作助手", category: "写作" },
          { ...defaultSnapshot.prompts[0], id: "code", title: "代码助手", category: "开发" },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "提示词库" }));

    const category = await screen.findByRole("combobox", { name: "提示词分类" });
    await user.selectOptions(category, "写作");

    expect(screen.getByText("写作助手")).toBeInTheDocument();
    expect(screen.queryByText("代码助手")).not.toBeInTheDocument();
  });

  it("keeps data inside the selected software installation folder", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "设置" }));
    expect(await screen.findByText("数据与存储")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更改位置" })).not.toBeInTheDocument();
    expect(screen.getByText("存储位置跟随软件安装目录")).toBeInTheDocument();
    expect(screen.getByText("全局快捷键")).toBeInTheDocument();
    expect(screen.getByText("字体与外观")).toBeInTheDocument();
    expect(screen.getByText("全盘索引")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "开机自启动 Atlas" })).toBeInTheDocument();
    const bootScene = screen.getByRole("combobox", { name: "开机启动场景" });
    await user.click(bootScene);
    expect(screen.getByRole("listbox", { name: "开机启动场景选项" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "无" })).toBeInTheDocument();
    expect(bootScene.closest(".settings-section")).toHaveClass("boot-settings-section");
    expect(screen.queryByText("登录启动")).not.toBeInTheDocument();
  });

  it("lets the user pause clipboard capture and configure privacy retention", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "设置" }));
    const pause = await screen.findByRole("switch", { name: "暂停剪贴板采集" });
    expect(pause).not.toBeChecked();
    await user.click(pause);
    expect(pause).toBeChecked();

    const retention = screen.getByRole("spinbutton", { name: "剪贴板保留天数" });
    await user.clear(retention);
    await user.type(retention, "7");
    expect(retention).toHaveValue(7);

    const excluded = screen.getByRole("textbox", { name: "不记录这些应用" });
    await user.clear(excluded);
    await user.type(excluded, "SecretEditor.exe, PasswordVault.exe");
    fireEvent.blur(excluded);
    expect(excluded).toHaveValue("SecretEditor.exe, PasswordVault.exe");
  });

  it("exposes automation and folder favorites as independent tools", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: "自动化命令" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文件夹收藏" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "自动化命令" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "文件夹收藏" })).toBeChecked();
  });

  it("creates a sequential command task with multiple commands", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "自动化命令" }));
    await user.click(await screen.findByRole("button", { name: "新建任务" }));
    await user.type(screen.getByRole("textbox", { name: "任务名称" }), "安装依赖");
    await user.type(
      screen.getByRole("textbox", { name: "命令列表" }),
      "python -m pip install requests{enter}python app.py",
    );
    expect(screen.getByRole("switch", { name: "运行完毕后关闭终端" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "保存任务" }));

    expect(await screen.findByText("安装依赖")).toBeInTheDocument();
    expect(screen.getByText("2 步")).toBeInTheDocument();
  });

  it("offers Microsoft YaHei and removes the monospace interface font", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await screen.findByText("字体与外观");

    const font = screen.getByRole("combobox", { name: "界面字体" });
    expect(font).toHaveTextContent("微软雅黑");
    expect(font).not.toHaveTextContent("等宽字体");
  });

  it("lets the user explicitly disable the boot scene", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await screen.findByText("开机自启动");

    const scene = screen.getByRole("combobox", { name: "开机启动场景" });
    await user.click(scene);
    await user.click(screen.getByRole("option", { name: "无" }));
    expect(scene).toHaveTextContent("无");
    expect(scene).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the boot scene picker with the standard combobox arrow key", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    const scene = await screen.findByRole("combobox", { name: "开机启动场景" });

    fireEvent.keyDown(scene, { key: "ArrowDown" });

    expect(scene).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "开机启动场景选项" })).toBeInTheDocument();
  });

  it("switches pages immediately without retaining a fading long page", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await screen.findByRole("heading", { name: "设置", level: 1 });
    const main = screen.getByRole("main");
    main.scrollTop = 480;

    await user.click(screen.getByRole("button", { name: "自动化命令" }));

    expect(screen.getByRole("heading", { name: "自动化命令", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "设置", level: 1 })).not.toBeInTheDocument();
    expect(main.scrollTop).toBe(0);
  });

  it("keeps the brand mark on a fixed high-contrast surface in dark mode", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await screen.findByRole("heading", { name: "设置", level: 1 });
    await user.click(screen.getByRole("button", { name: "深色" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(container.querySelector(".brand-mark")).toHaveClass(
      "brand-mark--fixed-contrast",
    );
    const darkTheme = stylesheet.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const surface = darkTheme.match(/--brand-mark-surface:\s*(#[0-9a-f]{6})/i)?.[1];
    const glyph = darkTheme.match(/--brand-mark-ink:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(surface).toBe("#242925");
    expect(glyph).toBe("#f8f5ed");
    expect(surface).not.toBe(glyph);
  });

  it("centers empty states across full-width grid pages", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "自动化命令" }));
    await screen.findByRole("heading", { name: "自动化命令", level: 1 });
    expect(container.querySelector(".automation-grid > .empty-state")).toHaveClass(
      "full-span-empty",
    );

    await user.click(screen.getByRole("button", { name: "文件夹收藏" }));
    await screen.findByRole("heading", { name: "文件夹收藏", level: 1 });
    expect(container.querySelector(".folder-favorites-grid > .empty-state")).toHaveClass(
      "full-span-empty",
    );
  });

  it("makes prompt favorites visible and filterable", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        prompts: [
          { ...defaultSnapshot.prompts[0], id: "plain", title: "普通提示词", favorite: false },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "提示词库" }));
    await screen.findByRole("heading", { name: "提示词库", level: 1 });

    await user.click(screen.getByRole("button", { name: "收藏 普通提示词" }));
    expect(screen.getByRole("button", { name: "取消收藏 普通提示词" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "只看收藏" }));
    expect(screen.getByText("普通提示词")).toBeInTheDocument();
  });

  it("creates a custom startup scene", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "启动编排" }));
    await user.click(await screen.findByRole("button", { name: "新建场景" }));
    await user.type(screen.getByRole("textbox", { name: "场景名称" }), "学习模式");
    await user.type(screen.getByRole("textbox", { name: "场景描述" }), "打开学习软件");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect((await screen.findAllByText("学习模式")).length).toBeGreaterThan(0);
  });

  it("exposes safe scene switching and desktop layout controls", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "启动编排" }));

    expect(
      await screen.findByRole("switch", {
        name: "切换场景时关闭上一场景的软件",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "运行场景时恢复桌面布局" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /保存当前桌面布局/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/避免重复启动/)).toBeInTheDocument();
  });

  it("adds and removes a folder favorite", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "文件夹收藏" }));
    await user.click(await screen.findByRole("button", { name: "收藏文件夹" }));

    expect(await screen.findByText("AtlasData")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消收藏 AtlasData" }));
    expect(screen.queryByText("AtlasData")).not.toBeInTheDocument();
  });

  it("creates a parameterized quick link that appears first in global search", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "新增链接" }));
    await user.type(screen.getByRole("textbox", { name: "链接名称" }), "Google 搜索");
    await user.type(screen.getByRole("textbox", { name: "链接关键词" }), "g");
    await user.type(screen.getByRole("textbox", { name: "链接描述" }), "浏览器网页搜索");
    const template = screen.getByRole("textbox", { name: "链接模板" });
    await user.clear(template);
    await user.type(template, "https://google.com/search?q={{query}}");
    await user.click(screen.getByRole("button", { name: "保存链接" }));

    await user.click(screen.getByRole("button", { name: "全局搜索" }));
    const search = await screen.findByPlaceholderText("搜索应用、文件或文件夹…");
    await user.type(search, "g tauri");

    expect((await screen.findAllByText("Google 搜索 · tauri")).length).toBeGreaterThan(0);
  });

  it("accepts an Edge protocol search template", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "新增链接" }));
    await user.type(screen.getByRole("textbox", { name: "链接名称" }), "Edge 搜索");
    await user.type(screen.getByRole("textbox", { name: "链接关键词" }), "ll");
    const template = screen.getByRole("textbox", { name: "链接模板" });
    await user.clear(template);
    await user.type(
      template,
      "microsoft-edge:https://www.bing.com/search?q={{query}}",
    );
    await user.click(screen.getByRole("button", { name: "保存链接" }));

    await user.click(screen.getByRole("button", { name: "全局搜索" }));
    await user.type(
      await screen.findByPlaceholderText("搜索应用、文件或文件夹…"),
      "ll Tauri",
    );

    expect((await screen.findAllByText("Edge 搜索 · Tauri")).length).toBeGreaterThan(0);
  });

  it("shows a quick-link parameter token only when a parameter is configured", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        quickLinks: [{
          id: "douyin",
          name: "抖音",
          description: "抖音-记录美好生活",
          keyword: "dy",
          parameterName: "",
          urlTemplate: "https://www.douyin.com/",
          enabled: true,
        }],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(await screen.findByText("dy")).toBeInTheDocument();
    expect(screen.queryByText("dy {query}")).not.toBeInTheDocument();
  });

  it("opens the persistent clipboard history tool", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "剪贴板历史" }));

    expect(await screen.findByPlaceholderText("搜索复制过的文字或图片")).toBeInTheDocument();
  });

  it("opens the global search page when the native shortcut event fires", async () => {
    render(<App />);

    window.dispatchEvent(new CustomEvent("atlas-show-search"));

    expect(await screen.findByPlaceholderText("搜索应用、文件或文件夹…")).toHaveFocus();
  });

  it("does not show a stale hard-coded shortcut inside the search box", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "全局搜索" }));
    await screen.findByPlaceholderText("搜索应用、文件或文件夹…");

    expect(container.querySelector(".search-box .shortcut-inline")).toBeNull();
  });

  it("shows the configured global search shortcut on the overview", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        settings: {
          ...defaultSnapshot.settings,
          shortcuts: { ...defaultSnapshot.settings.shortcuts, search: "Alt+F" },
        },
      }),
    );
    const { container } = render(<App />);

    await screen.findByText("ATLAS");
    const keys = [...container.querySelectorAll(".shortcut-tile kbd")].map(
      (element) => element.textContent,
    );
    expect(keys).toEqual(["ALT", "F"]);
  });

  it("constrains the quick link list only after the third item", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        quickLinks: Array.from({ length: 4 }, (_, index) => ({
          id: `link-${index}`,
          name: `Link ${index}`,
          description: "",
          keyword: `l${index}`,
          urlTemplate: "https://example.com?q={query}",
          enabled: true,
        })),
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await screen.findByText("快捷链接");

    expect(container.querySelector(".quick-link-list")).toHaveClass("scrollable");
  });

  it("uses a spinner-free clipboard limit control", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await screen.findByText("保留数量");

    expect(container.querySelector(".number-setting")).toHaveClass("no-native-spinner");
  });

  it("keeps settings form controls at the same compact type scale as their labels", () => {
    expect(stylesheet).toMatch(
      /\.settings-section\s+:is\(select,\s*input:not\(\[type="range"\]\),\s*textarea\)\s*\{[\s\S]*?font-size:\s*calc\(9px\s*\*\s*var\(--font-scale\)\)/,
    );
  });

  it("shows folder favorites with groups, aliases, tags and shortcuts", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        folderFavorites: [{
          id: "folder-docs",
          name: "资料",
          alias: "论文仓库",
          path: "D:\\资料",
          description: "",
          group: "学习",
          tags: ["论文", "常用"],
          shortcut: "Ctrl+Alt+D",
          createdAt: 1,
        }],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "文件夹收藏" }));

    expect((await screen.findAllByText("学习")).length).toBeGreaterThan(0);
    expect(screen.getByText("论文仓库")).toBeInTheDocument();
    expect(screen.getByText("论文")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Alt+D")).toBeInTheDocument();
  });

  it("renders persisted clipboard image previews with an image marker", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        clipboardHistory: [{
          id: "image-1",
          kind: "image",
          imageFile: "clipboard-images/image-1.png",
          previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          width: 640,
          height: 480,
          copiedAt: 1,
        }],
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByText("ATLAS");
    const navButtons = container.querySelectorAll<HTMLButtonElement>("aside nav button");
    await user.click(navButtons[4]);

    expect(await screen.findByRole("img", { name: "剪贴板图片预览" })).toBeInTheDocument();
    expect(screen.getByText("640 × 480")).toBeInTheDocument();
  });

  it("reorders startup applications by dragging the handle", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        startupItems: [
          {
            id: "first",
            name: "First",
            path: "C:\\First.exe",
            args: [],
            delaySeconds: 0,
            enabled: true,
            order: 0,
          },
          {
            id: "second",
            name: "Second",
            path: "C:\\Second.exe",
            args: [],
            delaySeconds: 0,
            enabled: true,
            order: 1,
          },
        ],
        startupScenes: [{
          id: "default-scene",
          name: "默认场景",
          description: "",
          itemIds: ["first", "second"],
        }],
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "启动编排" }));
    await screen.findAllByText("First");

    const handles = container.querySelectorAll<HTMLButtonElement>(".drag-handle");
    fireEvent.dragStart(handles[0], {
      dataTransfer: { effectAllowed: "", dropEffect: "", setData: () => undefined },
    });
    fireEvent.dragOver(handles[1], {
      dataTransfer: { effectAllowed: "", dropEffect: "", setData: () => undefined },
    });
    fireEvent.drop(handles[1], {
      dataTransfer: { effectAllowed: "", dropEffect: "", setData: () => undefined },
    });

    await waitFor(() => {
      const names = [...container.querySelectorAll(".startup-main strong")].map(
        (element) => element.textContent,
      );
      expect(names).toEqual(["Second", "First"]);
    });
  });

  it("opens overview tool cards with the keyboard without toggling the tool", async () => {
    const user = userEvent.setup();
    render(<App />);

    const openSearch = await screen.findByRole("button", { name: "打开全局搜索" });
    openSearch.focus();
    await user.keyboard("{Enter}");

    expect(
      await screen.findByPlaceholderText("搜索应用、文件或文件夹…"),
    ).toHaveFocus();
    expect(screen.getByRole("switch", { name: "全局搜索" })).toBeChecked();
  });

  it("keeps large text layouts adaptive instead of forcing horizontal page scrolling", () => {
    expect(stylesheet).toContain(":root[data-font-size=\"large\"] .overview-hero");
    expect(stylesheet).toContain(":root[data-font-size=\"large\"] .activity-strip");
    expect(stylesheet).toContain("overflow-x: hidden");
    expect(stylesheet).toContain("scrollbar-gutter: stable");
  });
});
