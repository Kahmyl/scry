import type { ElementHandle } from "playwright";

import { PraxisStaleTargetError } from "../observation.js";
import type { PraxisTargetReference } from "../references/target-reference.js";

export class PraxisFormControlDispatchError extends Error {
  readonly code = "PRAXIS_FORM_CONTROL_DISPATCH_UNCERTAIN";

  constructor(options: { cause?: unknown } = {}) {
    super("Pinned form control mutation may have dispatched browser input", options);
    this.name = "PraxisFormControlDispatchError";
  }
}

export async function selectReferencedTarget(
  reference: PraxisTargetReference,
  value: string,
  options: { timeoutMs?: number } = {},
): Promise<{ dispatched: true }> {
  await reference.assertCurrent();
  const element = reference.element();
  await assertFormControlActionable(element, "select");
  await reference.assertCurrent();
  try {
    await element.selectOption(
      value,
      options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs },
    );
  } catch (error) {
    if (error instanceof PraxisStaleTargetError) throw error;
    throw new PraxisFormControlDispatchError({ cause: error });
  }
  return { dispatched: true };
}

export async function setCheckedReferencedTarget(
  reference: PraxisTargetReference,
  checked: boolean,
  options: { timeoutMs?: number } = {},
): Promise<{ dispatched: true }> {
  await reference.assertCurrent();
  const element = reference.element();
  await assertFormControlActionable(element, "check");
  await reference.assertCurrent();
  try {
    await element.setChecked(
      checked,
      options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs },
    );
  } catch (error) {
    if (error instanceof PraxisStaleTargetError) throw error;
    throw new PraxisFormControlDispatchError({ cause: error });
  }
  return { dispatched: true };
}

async function assertFormControlActionable(
  element: ElementHandle<HTMLElement>,
  kind: "select" | "check",
): Promise<void> {
  const state = await element
    .evaluate((node, expectedKind) => {
      const connected = node.isConnected;
      const disabled = "disabled" in node && Boolean((node as HTMLInputElement).disabled);
      const matches =
        expectedKind === "select"
          ? node instanceof HTMLSelectElement
          : node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type);
      return { connected, disabled, matches };
    }, kind)
    .catch(() => ({ connected: false, disabled: false, matches: false }));
  if (!state.connected) throw new PraxisStaleTargetError();
  if (!state.matches || state.disabled || !(await element.isVisible().catch(() => false)))
    throw new PraxisFormControlDispatchError();
}
