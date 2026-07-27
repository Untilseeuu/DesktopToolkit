export function shouldSkipNativePersistence(
  nativeSnapshot: unknown,
  currentSnapshot: unknown,
  localRevision: number,
  persistedLocalRevision: number,
): boolean {
  return (
    nativeSnapshot === currentSnapshot &&
    localRevision === persistedLocalRevision
  );
}
