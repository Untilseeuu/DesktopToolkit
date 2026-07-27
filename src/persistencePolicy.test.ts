import { describe, expect, it } from "vitest";
import {
  shouldReportPersistenceError,
  shouldSkipNativePersistence,
} from "./persistencePolicy";

describe("native persistence policy", () => {
  it("skips a native-only render when no local edits are dirty", () => {
    const snapshot = { marker: "native" };
    expect(shouldSkipNativePersistence(snapshot, snapshot, 3, 3)).toBe(true);
  });

  it("never skips a batched native render that also contains an unsaved local edit", () => {
    const snapshot = { marker: "native-and-local" };
    expect(shouldSkipNativePersistence(snapshot, snapshot, 4, 3)).toBe(false);
  });

  it("does not show a false failure toast for a transient SQLite retry", () => {
    expect(shouldReportPersistenceError("database is locked", 1)).toBe(false);
    expect(shouldReportPersistenceError("database is locked", 2)).toBe(false);
    expect(shouldReportPersistenceError("database is locked", 3)).toBe(true);
  });
});
