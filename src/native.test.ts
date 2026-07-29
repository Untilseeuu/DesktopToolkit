import { describe, expect, it } from "vitest";
import { defaultSnapshot } from "./useToolkit";
import { formatLocalTimestamp, snapshotForNativePersistence } from "./native";

describe("native persistence payload", () => {
  it("does not resend backend-owned histories on every settings change", () => {
    const snapshot = {
      ...defaultSnapshot,
      startupItems: [{ id: "app" }] as never,
      startupFailures: [{ id: "failure" }] as never,
      clipboardHistory: [{ id: "clip", kind: "text", text: "large" }] as never,
      activity: {
        searches: [{ at: 1, query: "atlas" }],
        copies: [{ at: 2, source: "prompt" as const }],
      },
    };

    const payload = snapshotForNativePersistence(snapshot);

    expect(payload.startupItems).toEqual([]);
    expect(payload.startupFailures).toEqual([]);
    expect(payload.clipboardHistory).toEqual([]);
    expect(payload.activity).toEqual({ searches: [], copies: [] });
    expect(payload.settings).toBe(snapshot.settings);
    expect(payload.prompts).toBe(snapshot.prompts);
  });
});

describe("runtime log timestamps", () => {
  it("writes an explicit local UTC offset instead of a misleading UTC Z suffix", () => {
    const timestamp = formatLocalTimestamp(new Date(2026, 6, 29, 21, 8, 7, 6));
    expect(timestamp).toMatch(/^2026-07-29T21:08:07\.006[+-]\d{2}:\d{2}$/);
    expect(timestamp.endsWith("Z")).toBe(false);
  });
});
