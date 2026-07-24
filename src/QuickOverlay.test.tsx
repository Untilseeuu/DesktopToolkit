import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QuickOverlay from "./QuickOverlay";
import { defaultSnapshot } from "./useToolkit";

const { hideOverlay } = vi.hoisted(() => ({
  hideOverlay: vi.fn(async () => undefined),
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
  openTarget: vi.fn(async () => undefined),
  recordActivity: vi.fn(async () => undefined),
  searchNative: vi.fn(async () => []),
}));

describe("QuickOverlay", () => {
  beforeEach(() => hideOverlay.mockClear());

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
});
