import type { ElementHandle, Page } from "playwright";

import { PraxisStaleTargetError } from "../observation.js";
import type { PraxisTargetReference } from "../references/target-reference.js";

export class PraxisKeyDispatchError extends Error {
  readonly code = "PRAXIS_KEY_DISPATCH_UNCERTAIN";

  constructor(options: { cause?: unknown } = {}) {
    super("Pinned key dispatch may have emitted browser input", options);
    this.name = "PraxisKeyDispatchError";
  }
}

export async function pressReferencedTarget(
  reference: PraxisTargetReference,
  key: string,
  _options: { timeoutMs?: number } = {},
): Promise<{ dispatched: true }> {
  await reference.assertCurrent();
  const element = reference.element();
  await assertKeyboardActionable(element);
  await element.focus();
  await reference.assertCurrent();
  const ownsFocus = await element
    .evaluate((node) => node.ownerDocument.activeElement === node)
    .catch(() => false);
  if (!ownsFocus) throw new PraxisStaleTargetError();
  try {
    // ElementHandle.press waits for navigation triggered by the key. Dispatch
    // truth and destination observation are separate lifecycle facts: once the
    // pinned entity owns focus and remains current, emit input through its Page
    // without waiting for a resulting document transition here.
    const keyboard = reference.page().keyboard;
    await keyboard.down(key);
    // A keydown can synchronously start document replacement. Key-up is still
    // emitted, but its protocol acknowledgement must not become an implicit
    // navigation wait after dispatch has already occurred.
    const release = keyboard.up(key);
    await Promise.race([release, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
    void release.catch(() => undefined);
  } catch (error) {
    if (error instanceof PraxisStaleTargetError) throw error;
    throw new PraxisKeyDispatchError({ cause: error });
  }
  return { dispatched: true };
}

export async function pressPageKey(page: Page, key: string): Promise<{ dispatched: true }> {
  try {
    await page.keyboard.press(key);
  } catch (error) {
    throw new PraxisKeyDispatchError({ cause: error });
  }
  return { dispatched: true };
}

export async function focusReferencedTarget(
  reference: PraxisTargetReference,
): Promise<{ focused: true }> {
  await reference.assertCurrent();
  const element = reference.element();
  await assertKeyboardActionable(element);
  await reference.assertCurrent();
  await element.focus().catch(async (error) => {
    const connected = await element.evaluate((node) => node.isConnected).catch(() => false);
    if (!connected) throw new PraxisStaleTargetError();
    throw error;
  });
  await reference.assertCurrent();
  return { focused: true };
}

async function assertKeyboardActionable(element: ElementHandle<HTMLElement>): Promise<void> {
  const state = await element
    .evaluate((node) => ({
      connected: node.isConnected,
      disabled: "disabled" in node && Boolean((node as HTMLInputElement).disabled),
    }))
    .catch(() => ({ connected: false, disabled: false }));
  if (!state.connected) throw new PraxisStaleTargetError();
  if (state.disabled || !(await element.isVisible().catch(() => false)))
    throw new Error("Pinned keyboard target is not actionable");
}
