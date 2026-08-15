import type { ElementHandle } from "playwright";

import { PraxisStaleTargetError } from "../observation.js";
import type { PraxisTargetReference } from "../references/target-reference.js";

export type PraxisClickReferencedTargetOptions = {
  /** Budget for actionability and dispatch, in milliseconds. */
  timeoutMs?: number;
};

export type PraxisClickReferencedTargetOutcome = {
  /**
   * True only when the browser click sequence was dispatched against the
   * referenced entity. When this promise rejects, no dispatch occurred.
   */
  dispatched: true;
};

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Mechanically safe click against a pinned target reference.
 *
 * The pointer move that precedes dispatch can mutate the document: a hover
 * handler may remove or replace the target between actionability checks and
 * the button events. The reference is therefore revalidated after the pointer
 * reaches the target and before any button event is dispatched. A replaced or
 * detached entity aborts the click with PraxisStaleTargetError and no
 * dispatch occurs. The click never re-resolves another entity: when dispatch
 * happens, it happens against the referenced entity.
 */
export async function clickReferencedTarget(
  reference: PraxisTargetReference,
  options: PraxisClickReferencedTargetOptions = {},
): Promise<PraxisClickReferencedTargetOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const page = reference.page();
  const element = reference.element();

  // Pre-dispatch mechanical revalidation.
  await reference.assertCurrent();

  // Full actionability (attached, visible, stable, enabled, hit target,
  // scrolled into view) without dispatching any pointer input.
  await establishActionability(element, timeoutMs);

  const point = await actionPoint(element);
  if (!point) throw new PraxisStaleTargetError();

  // Moving the pointer over the target may mutate the document.
  await page.mouse.move(point.x, point.y);

  // Post-hover revalidation closes the hover/dispatch window: a target
  // replaced by its own pointerover handler is stale and must not be clicked.
  await reference.assertCurrent();

  // The entity at the click point must still be the referenced entity.
  if (!(await hitTargetIsEntity(element))) throw new PraxisStaleTargetError();

  await page.mouse.down();
  await page.mouse.up();
  return { dispatched: true };
}

async function establishActionability(
  element: ElementHandle<HTMLElement>,
  timeoutMs: number,
): Promise<void> {
  try {
    await element.click({ trial: true, timeout: timeoutMs });
  } catch (error) {
    // If the entity went stale while establishing actionability, report that;
    // otherwise preserve the original actionability failure.
    const attached = await element
      .evaluate((node) => node.isConnected)
      .catch(() => false);
    if (!attached) throw new PraxisStaleTargetError();
    throw error;
  }
}

async function actionPoint(
  element: ElementHandle<HTMLElement>,
): Promise<{ x: number; y: number } | undefined> {
  const box = await element.boundingBox().catch(() => null);
  if (!box || box.width === 0 || box.height === 0) return undefined;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function hitTargetIsEntity(element: ElementHandle<HTMLElement>): Promise<boolean> {
  return element
    .evaluate((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return hit === node || node.contains(hit);
    })
    .catch(() => false);
}
