/** Preserve the baseline's distinct error representations for each sink. */
export function publicBrowserErrorCode(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : String(error);
  return /^SCRY_BROWSER_[A-Z0-9_]+$/u.test(raw) ? raw : undefined;
}

export function finalizationBrowserErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return /^SCRY_BROWSER_[A-Z0-9_]+(?::[A-Za-z0-9,_-]+)?$/u.test(raw)
    ? raw
    : "SCRY_BROWSER_FINALIZATION_FAILED";
}

export function storedBrowserFailureCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[^A-Za-z0-9:_-]/gu, "_").slice(0, 500);
}
