import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { defaultSnapshot } from "./useToolkit";

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

  it("opens settings and exposes a custom data location action", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "设置" }));
    expect(await screen.findByText("数据与存储")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更改位置" })).toBeInTheDocument();
    expect(screen.getByText("全局快捷键")).toBeInTheDocument();
    expect(screen.getByText("字体与外观")).toBeInTheDocument();
    expect(screen.getByText("全盘索引")).toBeInTheDocument();
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
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "启动编排" }));
    await screen.findByText("First");

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
});
