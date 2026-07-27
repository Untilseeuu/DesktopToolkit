import { describe, expect, it } from "vitest";
import { shouldSkipNativePersistence } from "./persistencePolicy";

describe("native persistence policy", () => {
  it("skips a native-only render when no local edits are dirty", () => {
    const snapshot = { marker: "native" };
    expect(shouldSkipNativePersistence(snapshot, snapshot, 3, 3)).toBe(true);
  });

  it("never skips a batched native render that also contains an unsaved local edit", () => {
    const snapshot = { marker: "native-and-local" };
    expect(shouldSkipNativePersistence(snapshot, snapshot, 4, 3)).toBe(false);
  });
});
