import { describe, expect, it } from "vitest";
import { defaultSnapshot } from "./useToolkit";
import { snapshotForNativePersistence } from "./native";

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
