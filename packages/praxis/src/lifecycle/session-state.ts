import type { BrowserContext, Page } from "playwright";

export function capturePraxisStorageState(
  context: BrowserContext,
  options: { indexedDB?: boolean } = {},
) {
  return context.storageState(options);
}

export function capturePraxisSessionStorage(page: Page): Promise<Array<[string, string]>> {
  return page.evaluate(() => Object.entries(sessionStorage));
}

export function installPraxisSessionStorage(
  context: BrowserContext,
  state: { origin: string; entries: Array<[string, string]> },
) {
  return context.addInitScript(({ origin, entries }) => {
    if (window.location.origin !== origin) return;
    for (const [key, value] of entries) window.sessionStorage.setItem(key, value);
  }, state);
}
