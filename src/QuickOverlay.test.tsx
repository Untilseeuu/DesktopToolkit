import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QuickOverlay from "./QuickOverlay";
import { defaultSnapshot } from "./useToolkit";
import stylesheet from "./styles.css?inline";

const {
  clipboardHistoryHandler,
  hideOverlay,
  invokeNative,
  loadAppearanceAsset,
  loadSnapshot,
  openTarget,
  recordActivity,
  searchNative,
  snapshotUpdatedHandler,
} = vi.hoisted(() => ({
  clipboardHistoryHandler: { current: undefined as undefined | ((entries: unknown[]) => void) },
  hideOverlay: vi.fn(async () => undefined),
  invokeNative: vi.fn<(command: string) => Promise<unknown>>(async () => null),
  loadAppearanceAsset: vi.fn(async () => "data:font/ttf;base64,AA=="),
  loadSnapshot: vi.fn(),
  openTarget: vi.fn(async () => undefined),
  recordActivity: vi.fn(async () => undefined),
  searchNative: vi.fn(async () => []),
  snapshotUpdatedHandler: { current: undefined as undefined | (() => void) },
}));
const overlayEventHandlers = vi.hoisted(
  () => new Map<string, (event: { payload: unknown }) => void>(),
);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    overlayEventHandlers.set(event, handler);
    return () => overlayEventHandlers.delete(event);
  }),
}));

vi.mock("./native", () => ({
  activateClipboardEntry: vi.fn(async () => ({ pasted: false, kind: "image" })),
  bindClipboardHistory: vi.fn(async (handler: (entries: unknown[]) => void) => {
    clipboardHistoryHandler.current = handler;
    return () => {
      clipboardHistoryHandler.current = undefined;
    };
  }),
  bindSearchFilters: vi.fn(async () => () => undefined),
  bindSnapshotUpdated: vi.fn(async (handler: () => void) => {
    snapshotUpdatedHandler.current = handler;
    return () => {
      snapshotUpdatedHandler.current = undefined;
    };
  }),
  copyText: vi.fn(async () => undefined),
  getAppIcons: vi.fn(async () => ({})),
  hideOverlay,
  invokeNative,
  listSearchDrives: vi.fn(async () => ["C:", "D:"]),
  loadAppearanceAsset,
  loadSnapshot,
  openTarget,
  recordActivity,
  searchNative,
}));

describe("QuickOverlay", () => {
  beforeEach(() => {
    overlayEventHandlers.clear();
    clipboardHistoryHandler.current = undefined;
    snapshotUpdatedHandler.current = undefined;
    hideOverlay.mockClear();
    openTarget.mockClear();
    recordActivity.mockClear();
    invokeNative.mockReset();
    invokeNative.mockResolvedValue(null);
    loadAppearanceAsset.mockClear();
    loadSnapshot.mockReset();
    loadSnapshot.mockResolvedValue(defaultSnapshot);
    searchNative.mockReset();
    searchNative.mockResolvedValue([]);
  });

  it("installs the selected custom font inside the independent overlay webview", async () => {
    loadSnapshot.mockResolvedValue({
      ...defaultSnapshot,
      settings: {
        ...defaultSnapshot.settings,
        customFonts: [{ id: "font-1", name: "测试字体", path: "D:\\font.ttf" }],
        activeCustomFontId: "font-1",
      },
    });

    const { unmount } = render(<QuickOverlay mode="prompts" />);

    await waitFor(() => {
      expect(loadAppearanceAsset).toHaveBeenCalledWith("D:\\font.ttf");
      expect(document.documentElement.dataset.customFont).toBe("true");
    });
    expect(document.getElementById("atlas-custom-font")?.textContent).toContain(
      'font-family:"Atlas Custom ',
    );
    unmount();
  });

  it("switches tool modes inside one reusable overlay webview", async () => {
    render(<QuickOverlay mode="search" />);
    await screen.findByPlaceholderText("搜索所有磁盘中的应用、文件或文件夹");
    await waitFor(() =>
      expect(overlayEventHandlers.has("atlas-overlay-mode")).toBe(true),
    );

    act(() => {
      overlayEventHandlers.get("atlas-overlay-mode")?.({ payload: "prompts" });
    });

    expect(
      screen.getByPlaceholderText("模糊搜索标题、内容、分类或标签"),
    ).toBeInTheDocument();
  });

  it("reads the latest mode after event listeners are ready", async () => {
    invokeNative.mockImplementation(async (command: string) =>
      command === "get_quick_overlay_mode" ? "clipboard" : null
    );

    render(<QuickOverlay mode="search" />);

    expect(await screen.findByPlaceholderText(/最近复制/)).toBeInTheDocument();
    expect(invokeNative).toHaveBeenCalledWith("get_quick_overlay_mode");
  });

  it("does not let a stale startup mode overwrite a newer shortcut event", async () => {
    let resolveMode: (mode: unknown) => void = () => undefined;
    invokeNative.mockImplementation(
      (command: string) =>
        command === "get_quick_overlay_mode"
          ? new Promise((resolve) => {
              resolveMode = resolve;
            })
          : Promise.resolve(null),
    );
    render(<QuickOverlay mode="search" />);
    await waitFor(() =>
      expect(overlayEventHandlers.has("atlas-overlay-mode")).toBe(true),
    );

    act(() => {
      overlayEventHandlers.get("atlas-overlay-mode")?.({ payload: "prompts" });
    });
    expect(
      screen.getByPlaceholderText("模糊搜索标题、内容、分类或标签"),
    ).toBeInTheDocument();

    await act(async () => resolveMode("search"));

    expect(
      screen.getByPlaceholderText("模糊搜索标题、内容、分类或标签"),
    ).toBeInTheDocument();
  });

  it("reconciles the tool mode after a hidden overlay regains browser focus", async () => {
    let mode = "search";
    invokeNative.mockImplementation(async (command: string) =>
      command === "get_quick_overlay_mode" ? mode : null
    );
    render(<QuickOverlay mode="search" />);
    await waitFor(() =>
      expect(overlayEventHandlers.has("atlas-overlay-mode")).toBe(true),
    );
    await waitFor(() =>
      expect(invokeNative).toHaveBeenCalledWith("get_quick_overlay_mode"),
    );
    mode = "prompts";

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(
      await screen.findByPlaceholderText("模糊搜索标题、内容、分类或标签"),
    ).toBeInTheDocument();
    expect(invokeNative).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale focus reconciliation overwrite a newer shortcut mode", async () => {
    let modeReads = 0;
    let resolveFocusedMode: (mode: unknown) => void = () => undefined;
    invokeNative.mockImplementation((command: string) => {
      if (command !== "get_quick_overlay_mode") return Promise.resolve(null);
      modeReads += 1;
      if (modeReads === 1) return Promise.resolve("search");
      return new Promise((resolve) => {
        resolveFocusedMode = resolve;
      });
    });
    render(<QuickOverlay mode="search" />);
    await waitFor(() => expect(overlayEventHandlers.has("atlas-overlay-mode")).toBe(true));
    await waitFor(() => expect(modeReads).toBe(1));

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(modeReads).toBe(2));
    act(() => {
      overlayEventHandlers.get("atlas-overlay-mode")?.({ payload: "clipboard" });
    });
    await act(async () => resolveFocusedMode("search"));

    expect(screen.getByPlaceholderText(/最近复制/)).toBeInTheDocument();
  });

  it("shows explicit empty states for prompt and clipboard overlays", async () => {
    loadSnapshot.mockResolvedValue({
      ...defaultSnapshot,
      prompts: [],
      clipboardHistory: [],
    });
    const { container, unmount } = render(<QuickOverlay mode="prompts" />);
    expect(await screen.findByText("还没有提示词。")).toBeInTheDocument();
    expect(container.querySelector(".quick-results")).toHaveClass("is-empty");
    unmount();

    const clipboard = render(<QuickOverlay mode="clipboard" />);
    expect(await screen.findByText("还没有剪贴板记录。")).toBeInTheDocument();
    expect(clipboard.container.querySelector(".quick-results")).toHaveClass("is-empty");
    expect(stylesheet).toMatch(
      /\.quick-results\.is-empty\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/,
    );
  });

  it("reloads hidden clipboard and prompt data when the overlay regains focus", async () => {
    render(<QuickOverlay mode="clipboard" />);
    await screen.findByPlaceholderText(/最近复制/);
    loadSnapshot.mockResolvedValue({
      ...defaultSnapshot,
      clipboardHistory: [{
        id: "hidden-copy",
        kind: "text",
        text: "隐藏期间复制的内容",
        copiedAt: Date.now(),
      }],
      prompts: [{
        id: "hidden-prompt",
        title: "隐藏期间新增的提示词",
        content: "同步内容",
        category: "测试",
        tags: [],
        note: "",
        favorite: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(await screen.findByText("隐藏期间复制的内容")).toBeInTheDocument();
    act(() => {
      overlayEventHandlers.get("atlas-overlay-mode")?.({ payload: "prompts" });
    });
    expect(await screen.findByText("隐藏期间新增的提示词")).toBeInTheDocument();
  });

  it("retries a transient snapshot read so the first clipboard opening is not blank", async () => {
    loadSnapshot
      .mockRejectedValueOnce(new Error("database temporarily busy"))
      .mockRejectedValueOnce(new Error("database temporarily busy"))
      .mockRejectedValueOnce(new Error("database temporarily busy"))
      .mockResolvedValue({
        ...defaultSnapshot,
        clipboardHistory: [{
          id: "retry-copy",
          kind: "text",
          text: "首次打开也能显示",
          copiedAt: Date.now(),
        }],
      });

    render(<QuickOverlay mode="clipboard" />);

    expect(await screen.findByText("首次打开也能显示")).toBeInTheDocument();
    expect(loadSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("recovers when the first native snapshot read never settles", async () => {
    loadSnapshot
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({
        ...defaultSnapshot,
        clipboardHistory: [{
          id: "timeout-copy",
          kind: "text",
          text: "首次挂起后仍能恢复",
          copiedAt: Date.now(),
        }],
      });

    render(<QuickOverlay mode="clipboard" />);

    expect(
      await screen.findByText("首次挂起后仍能恢复", {}, { timeout: 3_000 }),
    ).toBeInTheDocument();
    expect(loadSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("uses dropdowns for extension and drive filters", async () => {
    const { container } = render(<QuickOverlay mode="search" />);

    expect(
      await screen.findByRole("combobox", { name: "文件扩展名" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "所在磁盘" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector('input[aria-label="文件扩展名"]'),
    ).not.toBeInTheDocument();
  });

  it("closes the search overlay with Escape", async () => {
    render(<QuickOverlay mode="search" />);
    await screen.findByPlaceholderText("搜索所有磁盘中的应用、文件或文件夹");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(hideOverlay).toHaveBeenCalledWith("search"));
  });

  it("closes from the explicit close button", async () => {
    const user = userEvent.setup();
    render(<QuickOverlay mode="search" />);

    await user.click(await screen.findByRole("button", { name: "关闭" }));

    expect(hideOverlay).toHaveBeenCalledWith("search");
  });

  it("shows image previews in clipboard history", async () => {
    loadSnapshot.mockResolvedValue({
      ...defaultSnapshot,
      clipboardHistory: [{
        id: "image-1",
        kind: "image",
        imageFile: "clipboard-images/image-1.png",
        previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        width: 320,
        height: 200,
        copiedAt: 1,
      }],
    });
    render(<QuickOverlay mode="clipboard" />);

    expect(await screen.findByRole("img", { name: "剪贴板图片预览" })).toBeInTheDocument();
    expect(screen.getAllByText("图片")).toHaveLength(2);
  });

  it("updates clipboard results when native history changes after opening", async () => {
    render(<QuickOverlay mode="clipboard" />);
    await screen.findByPlaceholderText(/最近复制/);
    await waitFor(() => expect(clipboardHistoryHandler.current).toBeTypeOf("function"));

    act(() => {
      clipboardHistoryHandler.current?.([{
        id: "fresh-text",
        kind: "text",
        text: "刚刚复制的新内容",
        copiedAt: Date.now(),
      }]);
    });

    expect(screen.getByText("刚刚复制的新内容")).toBeInTheDocument();
  });

  it("refreshes prompt data after another window saves the snapshot", async () => {
    render(<QuickOverlay mode="prompts" />);
    await screen.findByPlaceholderText(/模糊搜索/);
    await waitFor(() => expect(snapshotUpdatedHandler.current).toBeTypeOf("function"));
    loadSnapshot.mockResolvedValue({
      ...defaultSnapshot,
      prompts: [{
        id: "new-prompt",
        title: "新提示词",
        content: "新内容",
        category: "测试",
        tags: [],
        note: "",
        favorite: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    act(() => snapshotUpdatedHandler.current?.());

    expect(await screen.findByText("新提示词")).toBeInTheDocument();
  });

  it("ignores a slow stale search after a newer query has completed", async () => {
    let resolveOld: (value: never[]) => void = () => undefined;
    searchNative
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce([
        { id: "new", name: "New result", path: "D:\\new.txt", kind: "file" },
      ] as never);
    const user = userEvent.setup();
    render(<QuickOverlay mode="search" />);
    const input = await screen.findByPlaceholderText("搜索所有磁盘中的应用、文件或文件夹");

    await user.type(input, "old");
    await waitFor(() => expect(searchNative).toHaveBeenCalledTimes(1));
    await user.clear(input);
    await user.type(input, "new");
    expect(await screen.findByText("New result")).toBeInTheDocument();

    resolveOld([]);
    await waitFor(() => expect(screen.getByText("New result")).toBeInTheDocument());
  });

  it("shows a compact loading indicator while native search is still running", async () => {
    let finishSearch: (value: never[]) => void = () => undefined;
    searchNative.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishSearch = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<QuickOverlay mode="search" />);

    await user.type(
      await screen.findByPlaceholderText("搜索所有磁盘中的应用、文件或文件夹"),
      "毕业设计",
    );
    expect(await screen.findByRole("status", { name: "正在搜索" })).toBeInTheDocument();

    finishSearch([]);
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "正在搜索" })).not.toBeInTheDocument(),
    );
  });

  it("clears stale results when the native search rejects", async () => {
    searchNative
      .mockResolvedValueOnce([
        { id: "old", name: "Old result", path: "D:\\old.txt", kind: "file" },
      ] as never)
      .mockRejectedValueOnce(new Error("index locked"));
    const user = userEvent.setup();
    render(<QuickOverlay mode="search" />);
    const input = await screen.findByPlaceholderText("搜索所有磁盘中的应用、文件或文件夹");

    await user.type(input, "old");
    expect(await screen.findByText("Old result")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "new");

    await waitFor(() => expect(screen.queryByText("Old result")).not.toBeInTheDocument());
  });

  it("limits rendered search rows and records activity only when opening a result", async () => {
    searchNative.mockResolvedValue(
      Array.from({ length: 75 }, (_, index) => ({
        id: `result-${index}`,
        name: `Result ${index}`,
        path: `D:\\result-${index}.txt`,
        kind: "file",
      })) as never,
    );
    const user = userEvent.setup();
    render(<QuickOverlay mode="search" />);
    const input = (await screen.findAllByRole("textbox"))[0];

    await user.type(input, "result");
    await waitFor(() => expect(searchNative).toHaveBeenCalled());
    expect(screen.getAllByRole("button")).toHaveLength(41);
    expect(recordActivity).not.toHaveBeenCalled();

    await user.click(screen.getByText("Result 0"));
    expect(openTarget).toHaveBeenCalledWith("D:\\result-0.txt");
    expect(recordActivity).toHaveBeenCalledWith("search", "result");
  });
});
