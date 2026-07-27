import { describe, expect, it } from "vitest";
import tauriConfig from "../src-tauri/tauri.conf.json";

describe("desktop window lifecycle", () => {
  it("creates only the main webview at startup so hidden overlays consume no idle memory", () => {
    expect(tauriConfig.app.windows.map((window) => window.label)).toEqual(["main"]);
  });
});
