import { afterEach, describe, expect, it, vi } from "vitest";
import {
  customThemeVariables,
  installCustomFont,
  readAppearancePreview,
  writeAppearancePreview,
} from "./appearance";
import tauriConfig from "../src-tauri/tauri.conf.json";

const { loadAppearanceAsset } = vi.hoisted(() => ({
  loadAppearanceAsset: vi.fn(async (path: string) =>
    `data:font/ttf;base64,${btoa(path)}`,
  ),
}));

vi.mock("./native", () => ({ loadAppearanceAsset }));

afterEach(() => {
  document.getElementById("atlas-custom-font")?.remove();
  document.documentElement.style.removeProperty("--custom-font");
  delete document.documentElement.dataset.customFont;
  vi.clearAllMocks();
  localStorage.clear();
});

describe("custom font installation", () => {
  it("allows data-backed font files in the desktop CSP", () => {
    expect(tauriConfig.app.security.csp).toContain("font-src 'self' data:");
  });

  it("uses a different CSS family when the imported font changes", async () => {
    installCustomFont("D:\\fonts\\first.ttf");
    await vi.waitFor(() =>
      expect(document.documentElement.dataset.customFont).toBe("true"),
    );
    const first = document.documentElement.style.getPropertyValue("--custom-font");

    installCustomFont("D:\\fonts\\second.ttf");
    await vi.waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--custom-font")).not.toBe(first),
    );

    expect(document.getElementById("atlas-custom-font")?.textContent).toContain(
      "data:font/ttf",
    );
    expect(document.getElementById("atlas-custom-font")?.textContent).toContain(
      "font-weight:normal",
    );
    expect(document.getElementById("atlas-custom-font")?.textContent).not.toContain(
      "font-weight:100 900",
    );
  });

  it("maps optional theme colors to the sidebar and window surfaces", () => {
    expect(
      customThemeVariables({
        paper: "#101010",
        panel: "#202020",
        card: "#303030",
        ink: "#f0f0f0",
        muted: "#a0a0a0",
        accent: "#ff5500",
        moss: "#668866",
        sidebar: "#15191b",
        sidebarActive: "#2b3133",
        sidebarInk: "#f7f2e8",
        sidebarMuted: "#9aa4a5",
      }),
    ).toMatchObject({
      "--sidebar": "#15191b",
      "--sidebar-active": "#2b3133",
      "--sidebar-ink": "#f7f2e8",
      "--sidebar-muted": "#9aa4a5",
    });
  });

  it("publishes the latest appearance synchronously for a newly opened overlay", () => {
    writeAppearancePreview({
      theme: "dark",
      fontFamily: "yahei",
      fontScale: 1.1,
      activeCustomFontId: "",
      customFonts: [],
      activeCustomThemeId: "",
      customThemes: [],
    });

    expect(readAppearancePreview()).toMatchObject({
      theme: "dark",
      fontFamily: "yahei",
      fontScale: 1.1,
    });
  });
});
