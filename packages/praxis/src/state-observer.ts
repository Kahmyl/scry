import type { Locator, Page } from "playwright";

export type PraxisObservableState =
  "visible" | "hidden" | "attached" | "detached" | "enabled" | "disabled";

export class PraxisStateObserver {
  async readValue(locator: Locator) {
    return locator.evaluate((element) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
        return element.value;
      const label = element instanceof HTMLLabelElement ? element : element.closest("label");
      const control = label instanceof HTMLLabelElement ? label.control : null;
      if (
        control instanceof HTMLInputElement ||
        control instanceof HTMLTextAreaElement ||
        control instanceof HTMLSelectElement
      )
        return control.value;
      if (element instanceof HTMLElement && element.tagName === "DT") {
        const value = element.nextElementSibling;
        if (value?.tagName === "DD") return value.textContent ?? "";
      }
      return element.textContent ?? "";
    });
  }

  async checked(locator: Locator) {
    return locator.isChecked();
  }

  async matches(locator: Locator, state: PraxisObservableState) {
    if (state === "attached" || state === "detached") {
      const attached = (await locator.count()) > 0;
      return state === "attached" ? attached : !attached;
    }
    if (state === "visible" || state === "hidden") {
      const visible = await locator.isVisible();
      return state === "visible" ? visible : !visible;
    }
    const enabled = await locator.isEnabled();
    return state === "enabled" ? enabled : !enabled;
  }

  async wait(
    locator: Locator,
    state: PraxisObservableState,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    const deadline = performance.now() + timeoutMs;
    do {
      if (signal.aborted) throw new PraxisStateObservationCancelled();
      if (await this.matches(locator, state)) return true;
      await delay(Math.min(25, Math.max(1, deadline - performance.now())), signal);
    } while (performance.now() < deadline);
    return this.matches(locator, state);
  }

  async hasUniquePublicValue(page: Page, expected: string) {
    return page
      .locator("output, [data-scry-readable], dd, code, pre")
      .evaluateAll(
        (elements, value) =>
          elements.filter((element) => (element.textContent ?? "") === value).length === 1,
        expected,
      );
  }
}

export class PraxisStateObservationCancelled extends Error {
  constructor() {
    super("PRAXIS_STATE_OBSERVATION_CANCELLED");
    this.name = "PraxisStateObservationCancelled";
  }
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new PraxisStateObservationCancelled());
      },
      { once: true },
    );
  });
}
