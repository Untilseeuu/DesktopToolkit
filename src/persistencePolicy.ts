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

export function shouldReportPersistenceError(
  error: unknown,
  consecutiveFailures: number,
): boolean {
  const message = String(error).toLocaleLowerCase();
  const transient =
    message.includes("database is locked") ||
    message.includes("database is busy") ||
    message.includes("resource temporarily unavailable");
  return transient ? consecutiveFailures >= 3 : consecutiveFailures >= 2;
}
