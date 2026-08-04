import type { Page } from "playwright";
import { VeilChannelCollector } from "./channel-collector.js";

const clipboardCollectors = new WeakMap<Page, VeilClipboardCollector>();

export class VeilClipboardCleanupError extends Error {
  override name = "VeilClipboardCleanupError";
  readonly code = "VEIL_CLIPBOARD_CLEANUP_FAILED";
}

/** Veil-owned lifecycle capsule for clipboard values touched during protected work. */
export class VeilClipboardCollector extends VeilChannelCollector {
  private protectedClipboardTouched = false;

  constructor(
    private readonly page: Page,
    private readonly attempts = 3,
  ) {
    super("clipboard");
    clipboardCollectors.set(page, this);
  }

  markProtectedClipboardTouched(): void {
    this.protectedClipboardTouched = true;
  }

  override async finalize(): Promise<void> {
    if (this.protectedClipboardTouched) {
      let failure: unknown;
      for (let attempt = 0; attempt < this.attempts; attempt += 1) {
        try {
          await this.page.evaluate(async () => {
            await navigator.clipboard.writeText("");
            const observed = await navigator.clipboard.readText();
            if (observed !== "") throw new Error("clipboard remained non-empty");
          });
          this.protectedClipboardTouched = false;
          failure = undefined;
          break;
        } catch (error) {
          failure = error;
        }
      }
      if (failure)
        throw new VeilClipboardCleanupError(
          `Veil could not verify protected clipboard destruction: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
    }
    await super.finalize();
  }
}

export function markVeilProtectedClipboardTouched(page: Page): boolean {
  const collector = clipboardCollectors.get(page);
  collector?.markProtectedClipboardTouched();
  return Boolean(collector);
}
