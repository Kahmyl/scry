import type { ElementHandle, Page } from "playwright";

import { PraxisStaleTargetError } from "../observation.js";
import type { PraxisTargetReference } from "../references/target-reference.js";

export type PraxisFillReferencedTargetOptions = {
  /** Budget for actionability and dispatch, in milliseconds. */
  timeoutMs?: number;
};

export type PraxisFillPinnedElementOptions = {
  /** Budget for actionability and dispatch, in milliseconds. */
  timeoutMs?: number;
};

export type PraxisFillReferencedTargetOutcome = {
  dispatched: true;
};

export type PraxisPinnedTextEntryStrategy = "content_editable" | "focus_keyboard";

export type PraxisEnterTextReferencedTargetOptions = {
  timeoutMs?: number;
  strategy: PraxisPinnedTextEntryStrategy;
};

export class PraxisFillDispatchError extends Error {
  readonly code = "PRAXIS_FILL_DISPATCH_UNCERTAIN";

  constructor(options: { cause?: unknown } = {}) {
    super("Pinned fill may have dispatched browser input", options);
    this.name = "PraxisFillDispatchError";
  }
}

export class PraxisTextEntryDispatchError extends Error {
  readonly code = "PRAXIS_TEXT_ENTRY_DISPATCH_UNCERTAIN";

  constructor(options: { cause?: unknown } = {}) {
    super("Pinned text entry may have dispatched browser input", options);
    this.name = "PraxisTextEntryDispatchError";
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;

export async function fillReferencedTarget(
  reference: PraxisTargetReference,
  value: string,
  options: PraxisFillReferencedTargetOptions = {},
): Promise<PraxisFillReferencedTargetOutcome> {
  await reference.assertCurrent();
  return fillPinnedElement(reference.element(), value, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

export async function fillPinnedElement(
  element: ElementHandle<HTMLElement>,
  value: string,
  options: PraxisFillPinnedElementOptions = {},
): Promise<PraxisFillReferencedTargetOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await establishActionability(element, timeoutMs);
  await ensureStillCurrent(element);

  try {
    await element.fill(value, { timeout: timeoutMs });
  } catch (error) {
    await element.evaluate((node) => (node as HTMLElement).blur()).catch(() => undefined);
    if (error instanceof PraxisFillDispatchError) throw error;
    throw new PraxisFillDispatchError({ cause: error });
  }

  return { dispatched: true };
}

export async function enterTextReferencedTarget(
  reference: PraxisTargetReference,
  value: string,
  options: PraxisEnterTextReferencedTargetOptions,
): Promise<PraxisFillReferencedTargetOutcome> {
  await reference.assertCurrent();
  return enterTextPinnedElement(reference.page(), reference.element(), value, {
    ...options,
    isCurrent: () => reference.assertCurrent(),
  });
}

type PraxisEnterTextPinnedElementOptions = PraxisEnterTextReferencedTargetOptions & {
  isCurrent?: () => Promise<void>;
};

async function enterTextPinnedElement(
  page: Page,
  element: ElementHandle<HTMLElement>,
  value: string,
  options: PraxisEnterTextPinnedElementOptions,
): Promise<PraxisFillReferencedTargetOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await establishKeyboardActionability(element, timeoutMs, options.strategy);
  await options.isCurrent?.();

  await element.focus().catch(async (error) => {
    const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
    if (!attached) throw new PraxisStaleTargetError();
    throw error;
  });
  await options.isCurrent?.();

  const focused = await element
    .evaluate(
      (node) =>
        node === node.ownerDocument.activeElement ||
        node.contains(node.ownerDocument.activeElement),
    )
    .catch(() => false);
  if (!focused) throw new Error("Target not focused before text entry");

  try {
    if (options.strategy === "content_editable") {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await options.isCurrent?.();
      const stillFocused = await element
        .evaluate(
          (node) =>
            node === node.ownerDocument.activeElement ||
            node.contains(node.ownerDocument.activeElement),
        )
        .catch(() => false);
      if (!stillFocused) throw new PraxisTextEntryDispatchError();
    }
    await page.keyboard.insertText(value);
  } catch (error) {
    await element.evaluate((node) => node.blur()).catch(() => undefined);
    if (error instanceof PraxisTextEntryDispatchError) throw error;
    throw new PraxisTextEntryDispatchError({ cause: error });
  }

  return { dispatched: true };
}

type FillableGeometry = { x: number; y: number; width: number; height: number };

type FillabilitySnapshot = {
  geometry: FillableGeometry;
  visible: boolean;
  enabled: boolean;
};

async function establishActionability(
  element: ElementHandle<HTMLElement>,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  await element
    .scrollIntoViewIfNeeded({ timeout: timeoutRemainingOrThrow(deadline) })
    .catch(async () => {
      const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
      if (!attached) throw new PraxisStaleTargetError();
      throw new Error("Target not actionable before fill");
    });

  let snapshot = await readActionabilitySnapshot(element);
  if (!snapshot.visible || !snapshot.enabled) {
    throw new Error("Target not actionable before fill");
  }

  for (;;) {
    await waitForAnimationFrame();
    if (performance.now() >= deadline) {
      throw new Error("Target not stable before fill");
    }

    const next = await readActionabilitySnapshot(element);
    if (!next.visible || !next.enabled) {
      throw new Error("Target not actionable before fill");
    }
    if (geometryEquivalent(snapshot.geometry, next.geometry)) {
      return;
    }
    snapshot = next;
  }
}

async function establishKeyboardActionability(
  element: ElementHandle<HTMLElement>,
  timeoutMs: number,
  strategy: PraxisPinnedTextEntryStrategy,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  await element
    .scrollIntoViewIfNeeded({ timeout: timeoutRemainingOrThrow(deadline) })
    .catch(async () => {
      const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
      if (!attached) throw new PraxisStaleTargetError();
      throw new Error("Target not actionable before text entry");
    });

  let geometry = await readKeyboardGeometry(element, strategy);
  for (;;) {
    await waitForAnimationFrame();
    if (performance.now() >= deadline) throw new Error("Target not stable before text entry");
    const next = await readKeyboardGeometry(element, strategy);
    if (geometryEquivalent(geometry, next)) return;
    geometry = next;
  }
}

async function readKeyboardGeometry(
  element: ElementHandle<HTMLElement>,
  strategy: PraxisPinnedTextEntryStrategy,
): Promise<FillableGeometry> {
  const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
  if (!attached) throw new PraxisStaleTargetError();
  const visible = await element.isVisible().catch(() => false);
  const enabled = await element.isEnabled().catch(() => false);
  const editable = strategy === "focus_keyboard" || (await element.isEditable().catch(() => false));
  const geometry = await element.boundingBox().catch(() => null);
  if (
    !visible ||
    !enabled ||
    !editable ||
    !geometry ||
    geometry.width === 0 ||
    geometry.height === 0
  ) {
    throw new Error("Target not actionable before text entry");
  }
  return geometry;
}

async function readActionabilitySnapshot(
  element: ElementHandle<HTMLElement>,
): Promise<FillabilitySnapshot> {
  const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
  if (!attached) throw new PraxisStaleTargetError();

  const editable = await element.isEditable().catch(() => false);
  const enabled = await element.isEnabled().catch(() => false);
  const geometry = await element.boundingBox().catch(() => null);
  if (!editable || !geometry || geometry.width === 0 || geometry.height === 0) {
    throw new Error("Target not actionable before fill");
  }

  const visible = await element.isVisible().catch(() => false);
  return { geometry, visible, enabled };
}

async function ensureStillCurrent(element: ElementHandle<HTMLElement>): Promise<void> {
  const attached = await element.evaluate((node) => node.isConnected).catch(() => false);
  if (!attached) throw new PraxisStaleTargetError();
}

function geometryEquivalent(left: FillableGeometry, right: FillableGeometry): boolean {
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
  if (remaining <= 0) throw new Error("Target not actionable before fill");
  return remaining;
}
