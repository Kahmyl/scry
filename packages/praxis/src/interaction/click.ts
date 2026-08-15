import type { ElementHandle, Frame, Page } from "playwright";

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
   * True only when the browser click sequence completed against the
   * referenced entity. A PraxisClickDispatchError rejection means button
   * input may already have occurred; other rejections are pre-button-input.
   */
  dispatched: true;
};

export class PraxisClickDispatchError extends Error {
  readonly code = "PRAXIS_CLICK_DISPATCH_UNCERTAIN";

  constructor(options: { cause?: unknown } = {}) {
    super("Pinned click may have dispatched browser input", options);
    this.name = "PraxisClickDispatchError";
  }
}

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
  const { point, geometry } = await establishActionability(
    element,
    timeoutMs,
    options.position,
    options.isCurrent,
  );
  if (!geometryContains(geometry, point)) {
    throw new Error("Target not actionable before click");
  }

  // Moving the pointer over the target may mutate the document.
  await page.mouse.move(point.x, point.y);

  // Post-hover gates close the hover/dispatch window: a target replaced by
  // its own pointerover handler is stale and must not be clicked.
  const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
  if (!attached) throw new PraxisStaleTargetError();
  await options.isCurrent?.();

  const postMove = await readActionabilitySnapshot(element, options.isCurrent);
  if (!postMove.visible || !postMove.enabled || !geometryContains(postMove.geometry, point)) {
    throw new Error("Target not actionable before click");
  }

  // The referenced entity must still be under the pointer at the dispatch
  // point. This is evaluated at the pointer's actual position, so a target
  // that moved after the pointer was positioned is refused as well.
  if (!(await hitTargetAtPointer(element, point))) throw new PraxisStaleTargetError();

  try {
    await page.mouse.down();
    await page.mouse.up();
  } catch (error) {
    await page.mouse.up().catch(() => undefined);
    if (error instanceof PraxisClickDispatchError) throw error;
    throw new PraxisClickDispatchError({ cause: error });
  }
  return { dispatched: true };
}

type ClickableGeometry = { x: number; y: number; width: number; height: number };
type ActionabilitySnapshot = {
  geometry: ClickableGeometry;
  visible: boolean;
  enabled: boolean;
};

async function establishActionability(
  element: ElementHandle<HTMLElement | SVGElement>,
  timeoutMs: number,
  position?: { x: number; y: number },
  isCurrent?: () => Promise<void>,
): Promise<{ point: { x: number; y: number }; geometry: ClickableGeometry }> {
  const deadline = performance.now() + timeoutMs;
  await element.scrollIntoViewIfNeeded({ timeout: timeoutRemainingOrThrow(deadline) }).catch(async () => {
    const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
    if (!attached) throw new PraxisStaleTargetError();
    throw new Error("Target not actionable before click");
  });

  let snapshot = await readActionabilitySnapshot(element, isCurrent);
  if (!snapshot.visible || !snapshot.enabled) {
    throw new Error("Target not actionable before click");
  }

  for (;;) {
    await waitForAnimationFrame();
    if (performance.now() >= deadline) {
      throw new Error("Target not stable before click");
    }

    const next = await readActionabilitySnapshot(element, isCurrent);
    if (!next.visible || !next.enabled) {
      throw new Error("Target not actionable before click");
    }
    if (geometryEquivalent(snapshot.geometry, next.geometry)) {
      const x = position
        ? next.geometry.x + position.x
        : next.geometry.x + next.geometry.width / 2;
      const y = position
        ? next.geometry.y + position.y
        : next.geometry.y + next.geometry.height / 2;
      return { point: { x, y }, geometry: next.geometry };
    }
    snapshot = next;
  }
}

async function readActionabilitySnapshot(
  element: ElementHandle<HTMLElement | SVGElement>,
  isCurrent?: () => Promise<void>,
): Promise<ActionabilitySnapshot> {
  if (isCurrent) await isCurrent();

  const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
  if (!attached) throw new PraxisStaleTargetError();

  const geometry = await element.boundingBox().catch(() => null);
  if (!geometry || geometry.width === 0 || geometry.height === 0) {
    throw new Error("Target not actionable before click");
  }

  const visible = await element.isVisible().catch(() => false);
  const enabled = await element.isEnabled().catch(() => false);
  return { geometry, visible, enabled };
}

/**
 * Whether the entity is the hit target at the pointer point after validating
 * the full frame ancestry.
 */
async function hitTargetAtPointer(
  element: ElementHandle<HTMLElement | SVGElement>,
  absolutePoint: { x: number; y: number },
): Promise<boolean> {
  const targetFrame = await element.ownerFrame();
  if (!targetFrame) return false;

  const targetPoint = await pointInFrame(targetFrame, absolutePoint);

  const isTarget = await element
    .evaluate((node, point) => {
      const hit = node.ownerDocument.elementFromPoint(point.x, point.y);
      return hit === node || node.contains(hit);
    }, targetPoint)
    .catch(() => false);
  if (!isTarget) return false;

  let frame = targetFrame;
  while (frame.parentFrame()) {
    const parent = frame.parentFrame();
    if (!parent) return false;

    const frameElement = await frame.frameElement().catch(() => null);
    if (!frameElement) return false;

    const parentPoint = await pointInFrame(parent, absolutePoint);
    const framePathHit = await frameElement
      .evaluate((frameNode, point) => {
        const frameDocument = (frameNode as Element).ownerDocument;
        if (!frameDocument) return false;
        const hit = frameDocument.elementFromPoint(point.x, point.y);
        return hit === frameNode || frameNode.contains(hit);
      }, parentPoint)
      .catch(() => false);

    if (!framePathHit) return false;
    frame = parent;
  }

  return true;
}

async function pointInFrame(
  frame: Frame,
  absolutePoint: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const origin = await frameOriginFromMainFrame(frame);
  return { x: absolutePoint.x - origin.x, y: absolutePoint.y - origin.y };
}

async function frameOriginFromMainFrame(frame: Frame): Promise<{ x: number; y: number }> {
  if (!frame.parentFrame()) return { x: 0, y: 0 };
  const frameElement = await frame.frameElement().catch(() => null);
  if (!frameElement) throw new PraxisStaleTargetError();
  const box = await frameElement.boundingBox().catch(() => null);
  if (!box) throw new PraxisStaleTargetError();
  const border = await frameElement.evaluate((node) => ({
    x: (node as HTMLElement).clientLeft,
    y: (node as HTMLElement).clientTop,
  }));
  return { x: box.x + border.x, y: box.y + border.y };
}

function geometryEquivalent(left: ClickableGeometry, right: ClickableGeometry): boolean {
  const drift = 0.5;
  return (
    Math.abs(left.x - right.x) <= drift &&
    Math.abs(left.y - right.y) <= drift &&
    Math.abs(left.width - right.width) <= drift &&
    Math.abs(left.height - right.height) <= drift
  );
}

async function waitForAnimationFrame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 16));
}

function timeoutRemainingOrThrow(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("Target not actionable before click");
  return remaining;
}

function geometryContains(geometry: ClickableGeometry, point: { x: number; y: number }): boolean {
  return (
    point.x >= geometry.x &&
    point.y >= geometry.y &&
    point.x <= geometry.x + geometry.width &&
    point.y <= geometry.y + geometry.height
  );
}
