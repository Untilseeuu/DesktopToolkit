import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import App from "./App";
import { defaultSnapshot } from "./useToolkit";
import stylesheet from "./styles.css?inline";

afterEach(() => localStorage.clear());

describe("Atlas desktop toolkit", () => {
  it("never blocks first use with an index initialization dialog", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        settings: { ...defaultSnapshot.settings, indexSetup: "pending" },
      }),
    );
    render(<App />);

    await screen.findByRole("button", { name: "总览" });
    expect(screen.queryByRole("dialog", { name: /初始化全局搜索|正在建立搜索索引/ })).not.toBeInTheDocument();
  });

  it("shows a persistent search-page warning when setup was deferred", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        settings: { ...defaultSnapshot.settings, indexSetup: "deferred" },
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "全局搜索" }));

    expect(
      await screen.findByText("尚未建立文件索引"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "现在建立索引" })).toBeInTheDocument();
  });
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
    expect(screen.getByRole("button", { name: "查看日志" })).toBeInTheDocument();
    expect(screen.getByText(/data\\logs/)).toBeInTheDocument();
    expect(screen.getByText("全局快捷键")).toBeInTheDocument();
    expect(screen.getByText("全局个性化")).toBeInTheDocument();
    expect(screen.getByText("全盘索引")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "开机自启动 Atlas" })).toBeInTheDocument();
    const bootScene = screen.getByRole("combobox", { name: "开机启动场景" });
    await user.click(bootScene);
    expect(screen.getByRole("listbox", { name: "开机启动场景选项" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "无" })).toBeInTheDocument();
    expect(bootScene.closest(".settings-section")).toHaveClass("boot-settings-section");
    expect(screen.queryByText("登录启动")).not.toBeInTheDocument();
  });

  it("shows whether an index exists and confirms before building the selected scope", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        settings: {
          ...defaultSnapshot.settings,
          indexSetup: "deferred",
          indexRoots: ["*"],
        },
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(await screen.findByText("未建立索引")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "全部磁盘" }));
    expect(
      screen.getByRole("dialog", { name: "建立全部磁盘索引？" }),
    ).toBeInTheDocument();
  });

  it("does not rebuild an already indexed full-disk scope without a reason", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(await screen.findByText("索引已建立")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "全部磁盘" }));
    expect(await screen.findByText("当前全盘索引已经建立，无需重复建立")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "建立全部磁盘索引？" }),
    ).not.toBeInTheDocument();
  });

  it("applies global branding and custom tool names immediately", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "打开配置" }));

    const appName = screen.getByRole("textbox", { name: "软件名称" });
    await user.clear(appName);
    await user.type(appName, "NOVA");
    const startupName = screen.getByRole("textbox", { name: "启动编排" });
    await user.clear(startupName);
    await user.type(startupName, "开工场景");

    expect(screen.getAllByText("NOVA").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "开工场景" })).toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: "打开配置" }));

    const font = screen.getByRole("combobox", { name: "界面字体" });
    expect(font).toHaveTextContent("微软雅黑");
    expect(font).not.toHaveTextContent("等宽字体");
  });

  it("applies each built-in font across component-level font declarations", () => {
    expect(stylesheet).toMatch(
      /:root\[data-font="system"\]:not\(\[data-custom-font="true"\]\)\s+body\s+\*:not\(code\):not\(pre\):not\(kbd\)/,
    );
    expect(stylesheet).toMatch(
      /:root\[data-font="serif"\]:not\(\[data-custom-font="true"\]\)\s+body\s+\*:not\(code\):not\(pre\):not\(kbd\)[\s\S]*?"SimSun"/,
    );
    expect(stylesheet).toMatch(
      /:root\[data-font="yahei"\]:not\(\[data-custom-font="true"\]\)\s+body\s+\*:not\(code\):not\(pre\):not\(kbd\)[\s\S]*?"Microsoft YaHei"/,
    );
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
    await user.click(screen.getByRole("button", { name: "打开配置" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "界面主题" }), "builtin:dark");

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

  it("keeps every settings control at the boot scene selector type scale", () => {
    expect(stylesheet).toMatch(
      /\.settings-section\s+:is\(button,\s*select,\s*input:not\(\[type="range"\]\),\s*textarea,\s*kbd\)\s*\{[\s\S]*?font-size:\s*calc\(11px\s*\*\s*var\(--font-scale\)\)/,
    );
  });

  it("aligns the font-size thumb with both visual track endpoints", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "打开配置" }));
    await screen.findByText("文字大小");

    const slider = container.querySelector<HTMLElement>(".font-scale-slider");
    expect(slider?.querySelector("input[type='range']")).toBeInTheDocument();
    expect(slider?.style.getPropertyValue("--font-scale-progress")).toBe("37.5%");
    expect(stylesheet).toMatch(
      /\.font-scale-slider::before\s*\{[\s\S]*?inset:\s*50%\s+8px\s+auto/,
    );
    expect(stylesheet).toMatch(
      /\.font-scale-slider input\[type="range"\]\s*\{[\s\S]*?min-height:\s*24px/,
    );
  });

  it("uses dropdowns for extension and drive search filters", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "全局搜索" }));

    expect(
      container.querySelector('select[aria-label="文件扩展名"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('select[aria-label="所在磁盘"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('input[aria-label="文件扩展名"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('input[aria-label="所在磁盘"]'),
    ).not.toBeInTheDocument();
  });

  it("restores every global shortcut to its default combination", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        settings: {
          ...defaultSnapshot.settings,
          shortcuts: {
            search: "Ctrl+Alt+S",
            prompts: "Ctrl+Alt+P",
            clipboard: "Ctrl+Alt+V",
          },
        },
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(
      await screen.findByRole("button", { name: "恢复默认快捷键" }),
    );

    expect(screen.getByRole("button", { name: "Alt+Space" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alt+Shift+P" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alt+Shift+V" })).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "编辑 论文仓库" }));
    const group = screen.getByRole("combobox", { name: "文件夹分组" });
    expect(within(group).getByRole("option", { name: "学习" })).toBeInTheDocument();
  });

  it("orders startup applications automatically by their configured delay", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        startupItems: [
          { id: "slow", name: "慢启动", path: "D:\\slow.exe", delaySeconds: 8, enabled: true, order: 0 },
          { id: "fast", name: "快启动", path: "D:\\fast.exe", delaySeconds: 1, enabled: true, order: 1 },
        ],
        startupScenes: [{
          ...defaultSnapshot.startupScenes[0],
          itemIds: ["slow", "fast"],
        }],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "启动编排" }));

    const fast = (await screen.findAllByText("快启动")).find(
      (element) => element.matches(".startup-main strong"),
    )!;
    const slow = screen.getAllByText("慢启动").find(
      (element) => element.matches(".startup-main strong"),
    )!;
    expect(
      fast.compareDocumentPosition(slow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /拖动.*调整顺序/ })).not.toBeInTheDocument();
  });

  it("creates an empty folder group and shows descriptions on cards", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        folderFavorites: [{
          id: "folder-described",
          name: "论文",
          path: "D:\\论文",
          description: "保存毕业论文、参考文献和每周备份",
          group: "学习",
          tags: ["论文"],
          createdAt: 1,
        }],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "文件夹收藏" }));

    expect(await screen.findByText("保存毕业论文、参考文献和每周备份")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "新建分组" }));
    await user.type(screen.getByRole("textbox", { name: "分组名称" }), "客户项目");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(screen.getAllByText("客户项目").length).toBeGreaterThan(0);
  });

  it("edits a folder group and confirms deleting its contained favorites", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        folderGroups: ["学习"],
        folderFavorites: [{
          id: "folder-in-group",
          name: "论文",
          path: "D:\\论文",
          description: "",
          group: "学习",
          tags: [],
          createdAt: 1,
        }],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "文件夹收藏" }));

    await user.click(screen.getByRole("button", { name: "编辑分组 学习" }));
    const name = screen.getByRole("textbox", { name: "编辑分组名称" });
    await user.clear(name);
    await user.type(name, "研究");
    await user.click(screen.getByRole("button", { name: "保存分组" }));
    expect(screen.getAllByText("研究").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "删除分组 研究" }));
    expect(screen.getByText("该分组中的 1 个文件夹收藏也会被删除。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "删除分组和收藏" }));
    expect(screen.queryByText("论文")).not.toBeInTheDocument();
  });

  it("uses the same centered empty-state treatment for prompts and clipboard", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        prompts: [],
        clipboardHistory: [],
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "提示词库" }));
    expect(await screen.findByText("还没有提示词")).toBeInTheDocument();
    expect(container.querySelector(".prompt-grid > .empty-state")).toHaveClass("full-span-empty");

    await user.click(screen.getByRole("button", { name: "剪贴板历史" }));
    expect(await screen.findByText("还没有剪贴板记录")).toBeInTheDocument();
    expect(container.querySelector(".clipboard-list > .empty-state")).toHaveClass("full-span-empty");
    expect(container.querySelector(".clipboard-list")).toHaveClass("is-empty");
    expect(stylesheet).toMatch(
      /\.clipboard-list\.is-empty\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/,
    );
  });

  it("uses one control typography scale across toolbars and editors", () => {
    expect(stylesheet).toMatch(
      /\.favorites-filter\s*\{[\s\S]*?font-size:\s*calc\(11px \* var\(--font-scale\)\)/,
    );
    expect(stylesheet).toMatch(
      /\.folder-filter-bar input,\s*[\r\n]+\s*\.folder-filter-bar select\s*\{[\s\S]*?font-size:\s*calc\(11px \* var\(--font-scale\)\)/,
    );
  });

  it("consolidates built-in and imported fonts and themes under global personalization", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        settings: {
          ...defaultSnapshot.settings,
          customFonts: [{ id: "font-user", name: "霞鹜文楷", path: "data/font.ttf" }],
          customThemes: [{
            id: "theme-user",
            name: "雾蓝",
            mode: "light",
            colors: {
              paper: "#eef2f3",
              panel: "#f7f9f9",
              card: "#ffffff",
              ink: "#20282a",
              muted: "#68777a",
              accent: "#d85b3f",
              moss: "#557269",
            },
          }],
        },
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(screen.queryByRole("heading", { name: "字体与外观" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开配置" }));
    const font = screen.getByRole("combobox", { name: "界面字体" });
    const theme = screen.getByRole("combobox", { name: "界面主题" });
    expect(within(font).getByRole("option", { name: "霞鹜文楷" })).toBeInTheDocument();
    expect(within(theme).getByRole("option", { name: "雾蓝" })).toBeInTheDocument();
    expect(stylesheet).toMatch(
      /:root\[data-custom-font="true"\]\s+body\s+\*:not\(code\):not\(pre\):not\(kbd\)/,
    );
    expect(stylesheet).toMatch(/\.sidebar\s*\{[^}]*background:\s*var\(--sidebar\)/);
    expect(stylesheet).toMatch(/\.nav-item\.active\s*\{[^}]*var\(--sidebar-active\)/);
  });

  it("removes duplicate master controls and can delete an imported theme", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        settings: {
          ...defaultSnapshot.settings,
          theme: "light",
          activeCustomThemeId: "theme-review",
          customThemes: [{
            id: "theme-review",
            name: "验收主题",
            mode: "dark",
            colors: {
              paper: "#ffffff",
              panel: "#eeeeee",
              card: "#f8f8f8",
              ink: "#111111",
              muted: "#666666",
              accent: "#cc5500",
              moss: "#557755",
            },
          }],
        },
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-theme", "dark"),
    );
    await user.click(await screen.findByRole("button", { name: "设置" }));
    expect(screen.queryByText("功能总控")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开配置" }));
    await user.click(screen.getByRole("button", { name: "删除所选主题" }));
    expect(screen.queryByRole("option", { name: "验收主题" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-theme", "light"),
    );
  });

  it("deletes one clipboard history entry from its card", async () => {
    localStorage.setItem(
      "atlas-toolkit-state-v1",
      JSON.stringify({
        ...defaultSnapshot,
        clipboardHistory: [{
          id: "clipboard-delete",
          kind: "text",
          text: "这条记录需要删除",
          copiedAt: 1,
        }],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "剪贴板历史" }));
    expect(await screen.findByText("这条记录需要删除")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "删除这条剪贴板记录" }));

    expect(screen.queryByText("这条记录需要删除")).not.toBeInTheDocument();
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

    it("keeps index progress copy on one line at every supported font scale", () => {
      expect(stylesheet).toMatch(
        /\.index-progress-summary\s*\{[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
      );
      expect(stylesheet).toMatch(
        /\.index-progress-title\s*\{[\s\S]*?white-space:\s*nowrap[\s\S]*?text-overflow:\s*ellipsis/,
      );
      expect(stylesheet).toMatch(
        /\.index-progress-banner\s*\{[\s\S]*?width:\s*min\(clamp\(/,
      );
    });

    it("keeps compact control labels intact while allowing their toolbars to wrap", () => {
      expect(stylesheet).toMatch(
        /:is\(\.button,\s*\.nav-item,\s*\.filter-button,\s*\.favorites-filter,\s*\.shortcut-recorder\)\s*\{[\s\S]*?white-space:\s*nowrap/,
      );
      expect(stylesheet).toMatch(
        /:root\[data-font-size="large"\]\s+:is\(\.folder-filter-bar,\s*\.toolbar-actions,\s*\.setting-actions\)\s*\{[\s\S]*?flex-wrap:\s*wrap/,
      );
    });

  it("uses one full-window background layer and exposes an opacity control", async () => {
    expect(stylesheet).toMatch(
      /\.desktop-frame::before\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0/,
    );
    expect(stylesheet).toMatch(
      /:root\[data-background="true"\]\s+\.sidebar[\s\S]*?background:/,
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "打开配置" }));
    expect(screen.getByRole("slider", { name: "背景图片透明度" })).toBeInTheDocument();
  });
});
