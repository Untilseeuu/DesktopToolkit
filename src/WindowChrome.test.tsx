import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import tauriConfig from "../src-tauri/tauri.conf.json";
import mainCapability from "../src-tauri/capabilities/default.json";
import WindowChrome from "./WindowChrome";

const windowActions = vi.hoisted(() => ({
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowActions,
}));

describe("custom desktop window chrome", () => {
  beforeEach(() => {
    Object.values(windowActions).forEach((action) => action.mockClear());
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
    expect(windowActions.close).toHaveBeenCalledOnce();
  });
});
