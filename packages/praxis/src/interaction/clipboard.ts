import type { Locator, Page } from "playwright";

export function readPraxisClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

export function clearPraxisClipboard(page: Page): Promise<void> {
  return page.evaluate(() => navigator.clipboard.writeText(""));
}

export async function clearAndVerifyPraxisClipboard(page: Page): Promise<void> {
  await clearPraxisClipboard(page);
  if ((await readPraxisClipboard(page)) !== "")
    throw new Error("PRAXIS_CLIPBOARD_CLEAR_NOT_OBSERVED");
}

export async function observePraxisCopyEvent(page: Page, perform: () => Promise<unknown>) {
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __scryCopyObserved?: boolean }).__scryCopyObserved = false;
    document.addEventListener(
      "copy",
      () => {
        (globalThis as typeof globalThis & { __scryCopyObserved?: boolean }).__scryCopyObserved =
          true;
      },
      { once: true },
    );
  });
  await perform();
  return page.evaluate(
    () =>
      (globalThis as typeof globalThis & { __scryCopyObserved?: boolean }).__scryCopyObserved ===
      true,
  );
}

export function readPraxisElementValue(target: Locator): Promise<string> {
  return target.evaluate((element) =>
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
      ? element.value
      : (element.textContent ?? ""),
  );
}

export function readPraxisSelectedText(target: Locator): Promise<string> {
  return target.evaluate((element) => {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const value = selection?.toString() ?? "";
    selection?.removeAllRanges();
    return value;
  });
}
