import type { ElementHandle, Page } from "playwright";

import { PraxisStaleTargetError } from "../observation.js";
import type { PraxisTargetReference } from "../references/target-reference.js";

export type PraxisClickReferencedTargetOptions = {
  /** Budget for actionability and dispatch, in milliseconds. */
  timeoutMs?: number;
};

export type PraxisClickPinnedElementOptions = {
  /** Budget for actionability and dispatch, in milliseconds. */
  timeoutMs?: number;
  /** Click point relative to the element's top-left corner. Defaults to center. */
  position?: { x: number; y: number };
  /**
   * Additional mechanical currency gate evaluated after the pointer reaches
   * the target and before any button event is dispatched. Must throw when the
   * pinned entity is no longer current.
   */
  isCurrent?: () => Promise<void>;
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
  // Pre-dispatch mechanical revalidation.
  await reference.assertCurrent();
  return clickPinnedElement(reference.page(), reference.element(), {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    isCurrent: () => reference.assertCurrent(),
  });
}

/**
 * Mechanically safe click against an already pinned entity handle.
 *
 * The handle is never re-resolved. After the pointer reaches the target and
 * before any button event is dispatched, the entity must still be connected,
 * any supplied currency gate must hold, and the entity must still be the hit
 * target at the click point; otherwise the click aborts with
 * PraxisStaleTargetError and no dispatch occurs.
 */
export async function clickPinnedElement(
  page: Page,
  element: ElementHandle<HTMLElement | SVGElement>,
  options: PraxisClickPinnedElementOptions = {},
): Promise<PraxisClickReferencedTargetOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Full actionability (attached, visible, stable, enabled, hit target,
  // scrolled into view) without dispatching any pointer input.
  await establishActionability(element, timeoutMs, options.position);

  const point = await actionPoint(element, options.position);
  if (!point) throw new PraxisStaleTargetError();

  // Moving the pointer over the target may mutate the document.
  await page.mouse.move(point.x, point.y);

  // Post-hover gates close the hover/dispatch window: a target replaced by
  // its own pointerover handler is stale and must not be clicked.
  const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
  if (!attached) throw new PraxisStaleTargetError();
  await options.isCurrent?.();

  // The entity at the click point must still be the referenced entity.
  if (!(await hitTargetIsEntity(element, point))) throw new PraxisStaleTargetError();

  await page.mouse.down();
  await page.mouse.up();
  return { dispatched: true };
}

async function establishActionability(
  element: ElementHandle<HTMLElement | SVGElement>,
  timeoutMs: number,
  position?: { x: number; y: number },
): Promise<void> {
  try {
    await element.click({
      trial: true,
      timeout: timeoutMs,
      ...(position ? { position } : {}),
    });
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
  element: ElementHandle<HTMLElement | SVGElement>,
  position?: { x: number; y: number },
): Promise<{ x: number; y: number } | undefined> {
  const box = await element.boundingBox().catch(() => null);
  if (!box || box.width === 0 || box.height === 0) return undefined;
  return position
    ? { x: box.x + position.x, y: box.y + position.y }
    : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function hitTargetIsEntity(
  element: ElementHandle<HTMLElement | SVGElement>,
  point: { x: number; y: number },
): Promise<boolean> {
  return element
    .evaluate((node, { x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit === node || node.contains(hit);
    }, point)
    .catch(() => false);
}
