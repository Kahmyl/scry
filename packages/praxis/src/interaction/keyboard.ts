import type { ElementHandle } from "playwright";

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
  options: { timeoutMs?: number } = {},
): Promise<{ dispatched: true }> {
  await reference.assertCurrent();
  const element = reference.element();
  await assertKeyboardActionable(element);
  await reference.assertCurrent();
  try {
    await element.press(key, options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs });
  } catch (error) {
    if (error instanceof PraxisStaleTargetError) throw error;
    throw new PraxisKeyDispatchError({ cause: error });
  }
  return { dispatched: true };
}

async function assertKeyboardActionable(element: ElementHandle<HTMLElement>): Promise<void> {
  const state = await element.evaluate((node) => ({
    connected: node.isConnected,
    disabled: "disabled" in node && Boolean((node as HTMLInputElement).disabled),
  })).catch(() => ({ connected: false, disabled: false }));
  if (!state.connected) throw new PraxisStaleTargetError();
  if (state.disabled || !(await element.isVisible().catch(() => false)))
    throw new Error("Pinned keyboard target is not actionable");
}
