import type { ElementHandle, Frame, Locator, Page } from "playwright";

import {
  PraxisDocumentEpoch,
  PraxisDocumentIdentity,
  PraxisStaleTargetError,
  PraxisTargetHandle,
} from "../observation.js";

export const PRAXIS_TARGET_REFERENCE_VERSION = 1;

/**
 * A pinned reference to the exact browser entity that was observed.
 *
 * The reference records mechanical identity only: page, frame, document
 * identity, document epoch, and the entity handle captured at observation
 * time. It never re-resolves by selector, role, accessible name, text, or any
 * other semantic description. A removed-and-replaced element is a different
 * browser entity, and this reference can never silently retarget to it.
 *
 * Revalidation is mechanical as well: page open, frame attached, document
 * unchanged, observed entity still connected. No semantic similarity, no
 * confidence, no candidate ranking.
 */
export class PraxisTargetReference {
  readonly pageId: string;
  readonly frameId: string;
  readonly documentEpoch: number;
  readonly documentIdentity: string;
  readonly referenceVersion: typeof PRAXIS_TARGET_REFERENCE_VERSION =
    PRAXIS_TARGET_REFERENCE_VERSION;

  readonly #handle: PraxisTargetHandle;
  readonly #element: ElementHandle<HTMLElement>;

  constructor(
    page: Page,
    frame: Frame,
    locator: Locator | undefined,
    element: ElementHandle<HTMLElement>,
    documentEpoch: number,
    documentIdentity: string,
  ) {
    this.#handle = new PraxisTargetHandle(page, frame, locator, documentEpoch, documentIdentity);
    this.#element = element;
    this.pageId = this.#handle.pageId;
    this.frameId = this.#handle.frameId;
    this.documentEpoch = documentEpoch;
    this.documentIdentity = documentIdentity;
  }

  /**
   * The observed entity. Identity is fixed at observation time and is never
   * re-resolved through a locator.
   */
  element(): ElementHandle<HTMLElement> {
    return this.#element;
  }

  page(): Page {
    return this.#handle.page();
  }

  /**
   * Mechanical revalidation. Throws PraxisStaleTargetError when the page
   * closed, the frame detached, the document identity changed, or the
   * observed entity is no longer attached to the document.
   */
  async assertCurrent(): Promise<void> {
    await this.#handle.assertCurrent();
    const attached = await this.#element
      .evaluate((element) => element.isConnected)
      .catch(() => false);
    if (!attached) throw new PraxisStaleTargetError();
  }

  async dispose(): Promise<void> {
    await this.#element.dispose().catch(() => undefined);
  }

  toJSON() {
    return {
      referenceVersion: this.referenceVersion,
      pageId: this.pageId,
      frameId: this.frameId,
      documentEpoch: this.documentEpoch,
      documentIdentity: this.documentIdentity,
    };
  }
}

/**
 * Observe the entity a locator currently denotes and pin a reference to that
 * exact entity. The locator is consulted once, at observation time only, and
 * is never used for later re-resolution.
 */
export async function observeTargetReference(
  page: Page,
  locator: Locator,
  options: { timeoutMs?: number } = {},
): Promise<PraxisTargetReference> {
  const element = (await locator.elementHandle(
    options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
  )) as ElementHandle<HTMLElement> | null;
  if (!element) throw new PraxisStaleTargetError();
  const frame = (await element.ownerFrame()) ?? page.mainFrame();
  const documentEpoch = await PraxisDocumentEpoch.current(page, frame);
  const documentIdentity = await PraxisDocumentIdentity.current(page, frame);
  return new PraxisTargetReference(page, frame, locator, element, documentEpoch, documentIdentity);
}

/**
 * Pin an element that was discovered beneath an already-authoritative exact
 * region handle. The element is never converted back into a selector or
 * semantically re-resolved.
 */
export async function observeExactTargetReference(
  page: Page,
  element: ElementHandle<HTMLElement>,
): Promise<PraxisTargetReference> {
  const frame = (await element.ownerFrame()) ?? page.mainFrame();
  const documentEpoch = await PraxisDocumentEpoch.current(page, frame);
  const documentIdentity = await PraxisDocumentIdentity.current(page, frame);
  return new PraxisTargetReference(
    page,
    frame,
    undefined,
    element,
    documentEpoch,
    documentIdentity,
  );
}
