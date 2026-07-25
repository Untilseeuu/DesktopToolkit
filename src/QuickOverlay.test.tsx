import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QuickOverlay from "./QuickOverlay";
import { defaultSnapshot } from "./useToolkit";

const { hideOverlay, openTarget, recordActivity, searchNative } = vi.hoisted(() => ({
  hideOverlay: vi.fn(async () => undefined),
  openTarget: vi.fn(async () => undefined),
  recordActivity: vi.fn(async () => undefined),
  searchNative: vi.fn(async () => []),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("./native", () => ({
  activateClipboardEntry: vi.fn(async () => ({ pasted: false, kind: "image" })),
  bindClipboardHistory: vi.fn(async () => () => undefined),
  bindSearchFilters: vi.fn(async () => () => undefined),
  copyText: vi.fn(async () => undefined),
  getAppIcons: vi.fn(async () => ({})),
  hideOverlay,
  invokeNative: vi.fn(async () => null),
  loadSnapshot: vi.fn(async () => defaultSnapshot),
  openTarget,
  recordActivity,
  searchNative,
}));

describe("QuickOverlay", () => {
  beforeEach(() => {
    hideOverlay.mockClear();
    openTarget.mockClear();
    recordActivity.mockClear();
    searchNative.mockReset();
    searchNative.mockResolvedValue([]);
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
    vi.mocked((await import("./native")).loadSnapshot).mockResolvedValueOnce({
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
