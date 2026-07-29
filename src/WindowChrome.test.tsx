import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import tauriConfig from "../src-tauri/tauri.conf.json";
import mainCapability from "../src-tauri/capabilities/default.json";
import WindowChrome from "./WindowChrome";
import stylesheet from "./styles.css?inline";

const { closeRequestedHandler, quitApplication, windowActions } = vi.hoisted(() => ({
  closeRequestedHandler: { current: undefined as undefined | (() => void) },
  quitApplication: vi.fn(async () => undefined),
  windowActions: {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowActions,
}));

vi.mock("./native", () => ({
  quitApplication,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: () => void) => {
    closeRequestedHandler.current = handler;
    return () => {
      closeRequestedHandler.current = undefined;
    };
  }),
}));

describe("custom desktop window chrome", () => {
  beforeEach(() => {
    Object.values(windowActions).forEach((action) => action.mockClear());
    quitApplication.mockClear();
    closeRequestedHandler.current = undefined;
  });

  it("turns off the native frame only for the main window", () => {
    const [mainWindow, ...overlayWindows] = tauriConfig.app.windows;

    expect(mainWindow.label).toBe("main");
    expect(mainWindow.decorations).toBe(false);
    expect(overlayWindows.every((window) => window.decorations === false)).toBe(true);
  });

  it("grants every native window permission required by the custom title bar", () => {
    expect(mainCapability.permissions).toEqual(
      expect.arrayContaining([
        "core:window:allow-start-dragging",
        "core:window:allow-minimize",
        "core:window:allow-toggle-maximize",
        "core:window:allow-close",
        "core:window:allow-hide",
      ]),
    );
  });

  it("provides a draggable title region and all native window controls", async () => {
    const user = userEvent.setup();
    const { container } = render(<WindowChrome />);

    expect(container.querySelector("[data-tauri-drag-region]")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "最小化" }));
    await user.click(screen.getByRole("button", { name: "最大化或还原" }));
    await user.click(screen.getByRole("button", { name: "关闭" }));

    expect(windowActions.minimize).toHaveBeenCalledOnce();
    expect(windowActions.toggleMaximize).toHaveBeenCalledOnce();
    expect(quitApplication).toHaveBeenCalledOnce();
    expect(windowActions.hide).not.toHaveBeenCalled();
  });

  it("asks before closing and lets the user disable future reminders", async () => {
    const user = userEvent.setup();
    const disableReminder = vi.fn();
    let finishSave: (() => void) | undefined;
    const onBeforeQuit = vi.fn(
      () => new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
    );
    render(
      <WindowChrome
        confirmOnClose
        onDisableCloseReminder={disableReminder}
        onBeforeQuit={onBeforeQuit}
      />,
    );

    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("dialog", { name: "确认关闭 Atlas" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "以后关闭时不再提醒" }));
    await user.click(screen.getByRole("button", { name: "确认关闭" }));

    expect(disableReminder).toHaveBeenCalledOnce();
    expect(onBeforeQuit).toHaveBeenCalledWith(true);
    expect(quitApplication).not.toHaveBeenCalled();
    finishSave?.();
    await vi.waitFor(() => expect(quitApplication).toHaveBeenCalledOnce());
  });

  it("routes Alt+F4 and taskbar close requests through the same confirmation", async () => {
    const user = userEvent.setup();
    render(<WindowChrome confirmOnClose />);
    await screen.findByRole("button", { name: "关闭" });
    await waitFor(() => expect(closeRequestedHandler.current).toBeTypeOf("function"));

    act(() => closeRequestedHandler.current?.());

    expect(screen.getByRole("dialog", { name: "确认关闭 Atlas" })).toBeInTheDocument();
    expect(quitApplication).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认关闭" }));
    expect(quitApplication).toHaveBeenCalledOnce();
  });

  it("keeps every title-bar control fully visible at the native minimum width", () => {
    expect(stylesheet).not.toMatch(
      /html,\s*body,\s*#root\s*\{[^}]*min-width:\s*960px/,
    );
    expect(stylesheet).toMatch(
      /\.window-chrome-controls\s*\{[^}]*position:\s*absolute[^}]*right:\s*0/,
    );
    expect(stylesheet).toMatch(
      /\.window-chrome-controls button\s*\{[^}]*flex:\s*0\s+0\s+46px/,
    );
  });

  it("keeps the close confirmation above the blocking index initializer", () => {
    expect(stylesheet).toMatch(
      /\.window-close-backdrop\s*\{[^}]*z-index:\s*600/,
    );
  });
});
