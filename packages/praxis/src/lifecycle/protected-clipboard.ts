import { VeilClipboardCollector } from "@scry/veil";
import type { Page } from "playwright";

import { clearAndVerifyPraxisClipboard } from "../interaction/clipboard.js";

const collectors = new WeakMap<Page, VeilClipboardCollector>();

export function createVeilClipboardCollector(page: Page): VeilClipboardCollector {
  const collector = new VeilClipboardCollector(() => clearAndVerifyPraxisClipboard(page));
  collectors.set(page, collector);
  return collector;
}

export function markProtectedClipboardTouched(page: Page): boolean {
  const collector = collectors.get(page);
  collector?.markProtectedClipboardTouched();
  return Boolean(collector);
}
