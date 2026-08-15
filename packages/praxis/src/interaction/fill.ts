import type { ElementHandle } from "playwright";

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

export class PraxisFillDispatchError extends Error {
  readonly code = "PRAXIS_FILL_DISPATCH_UNCERTAIN";

  constructor(options: { cause?: unknown } = {}) {
    super("Pinned fill may have dispatched browser input", options);
    this.name = "PraxisFillDispatchError";
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
  await element.scrollIntoViewIfNeeded({ timeout: timeoutRemainingOrThrow(deadline) }).catch(async () => {
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
