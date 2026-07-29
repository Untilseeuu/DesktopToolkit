import { loadAppearanceAsset } from "./native";
import type { CustomTheme } from "./types";

const CUSTOM_FONT_STYLE_ID = "atlas-custom-font";

function customFontFamily(path: string): string {
  let hash = 2166136261;
  for (const character of path) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `Atlas Custom ${Math.abs(hash >>> 0).toString(36)}`;
}

function clearCustomFont() {
  const root = document.documentElement;
  root.style.removeProperty("--custom-font");
  delete root.dataset.customFont;
  document.getElementById(CUSTOM_FONT_STYLE_ID)?.remove();
}

export function installCustomFont(
  path?: string,
  onResult?: (result: "success" | "failed", detail: string) => void,
): () => void {
  if (!path) {
    clearCustomFont();
    return () => undefined;
  }

  let active = true;
  void loadAppearanceAsset(path)
    .then((source) => {
      if (!active) return;
      const family = customFontFamily(path);
      let style = document.getElementById(CUSTOM_FONT_STYLE_ID) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = CUSTOM_FONT_STYLE_ID;
        document.head.append(style);
      }
      style.textContent =
        `@font-face{font-family:"${family}";src:url("${source}");` +
        "font-display:swap;font-style:normal;font-weight:normal}";
      const apply = () => {
        if (!active) return;
        document.documentElement.style.setProperty("--custom-font", `"${family}"`);
        document.documentElement.dataset.customFont = "true";
        onResult?.("success", `family=${family}`);
      };
      const fonts = document.fonts;
      if (fonts?.load) {
        void fonts
          .load(`16px "${family}"`, "Atlas 字体测试")
          .then((faces) => {
            if (!faces.length) {
              throw new Error("字体文件没有提供可用字形");
            }
            apply();
          })
          .catch(() => {
            if (active) {
              clearCustomFont();
              onResult?.("failed", "浏览器无法加载所选字体文件");
            }
          });
      } else {
        apply();
      }
    })
    .catch((error) => {
      if (active) {
        clearCustomFont();
        onResult?.("failed", String(error));
      }
    });

  return () => {
    active = false;
  };
}

export function customThemeVariables(
  colors?: CustomTheme["colors"],
): Record<string, string | undefined> {
  return {
    "--paper": colors?.paper,
    "--panel": colors?.panel,
    "--card": colors?.card,
    "--ink": colors?.ink,
    "--muted": colors?.muted,
    "--vermillion": colors?.accent,
    "--moss": colors?.moss,
    "--line":
      colors?.line ??
      (colors?.ink ? `color-mix(in srgb, ${colors.ink} 12%, transparent)` : undefined),
    "--line-strong":
      colors?.lineStrong ??
      (colors?.ink ? `color-mix(in srgb, ${colors.ink} 20%, transparent)` : undefined),
    "--sidebar": colors?.sidebar ?? colors?.panel,
    "--sidebar-active": colors?.sidebarActive ?? colors?.card,
    "--sidebar-ink": colors?.sidebarInk ?? colors?.ink,
    "--sidebar-muted": colors?.sidebarMuted ?? colors?.muted,
    "--brand-mark-surface": colors?.brandSurface ?? colors?.ink,
    "--brand-mark-ink": colors?.brandInk ?? colors?.paper,
  };
}

export function installTheme(
  theme: CustomTheme | undefined,
  builtinMode: "light" | "dark",
): () => void {
  const root = document.documentElement;
  const variables = customThemeVariables(theme?.colors);
  root.dataset.theme = theme?.mode ?? builtinMode;
  Object.entries(variables).forEach(([key, value]) => {
    if (value) root.style.setProperty(key, value);
    else root.style.removeProperty(key);
  });
  return () => {
    Object.keys(variables).forEach((key) => root.style.removeProperty(key));
  };
}
