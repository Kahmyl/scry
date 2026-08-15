import type { ElementHandle, Page } from "playwright";

import { PraxisStaleTargetError } from "../observation.js";
import type { PraxisTargetReference } from "../references/target-reference.js";

export type PraxisScrollDirection = "into_view" | "up" | "down" | "left" | "right";

export async function scrollReferencedTarget(
  reference: PraxisTargetReference,
  direction: PraxisScrollDirection,
  options: { timeoutMs?: number } = {},
): Promise<{ dispatched: true }> {
  await reference.assertCurrent();
  const element = reference.element();
  if (direction === "into_view") {
    await element.scrollIntoViewIfNeeded(
      options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs },
    ).catch(async (error) => {
      if (!(await connected(element))) throw new PraxisStaleTargetError();
      throw error;
    });
  } else {
    await element.evaluate((node, requestedDirection) => {
      node.scrollBy({
        top: requestedDirection === "down" ? node.clientHeight : requestedDirection === "up" ? -node.clientHeight : 0,
        left: requestedDirection === "right" ? node.clientWidth : requestedDirection === "left" ? -node.clientWidth : 0,
      });
    }, direction).catch(async (error) => {
      if (!(await connected(element))) throw new PraxisStaleTargetError();
      throw error;
    });
  }
  return { dispatched: true };
}

export async function wheelPage(
  page: Page,
  deltaY: number,
): Promise<{ dispatched: true }> {
  await page.mouse.wheel(0, deltaY);
  return { dispatched: true };
}

async function connected(element: ElementHandle<HTMLElement>): Promise<boolean> {
  return element.evaluate((node) => node.isConnected).catch(() => false);
}
