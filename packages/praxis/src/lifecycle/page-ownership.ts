import type { BrowserContext, Page } from "playwright";

export function createPraxisExpectedPageOwnership(
  context: BrowserContext,
  currentPage: () => Page,
) {
  type Capture = {
    pages: Page[];
    adopted?: Page;
    rejectedDocumentUrl?: string;
    first: Promise<void>;
    signalFirst: () => void;
  };
  let active: Capture | undefined;
  context.on("page", (candidate) => {
    if (candidate === currentPage()) return;
    if (!active) {
      void candidate.close().catch(() => undefined);
      return;
    }
    active.pages.push(candidate);
    active.signalFirst();
  });
  return {
    rejectDocument(url: string) {
      if (!active) return;
      active.rejectedDocumentUrl ??= url;
      active.signalFirst();
    },
    arm(timeoutMs: number) {
      if (active) throw new Error("EXPECTED_NEW_PAGE_CAPTURE_ALREADY_ACTIVE");
      let signalFirst!: () => void;
      const capture: Capture = {
        pages: [],
        first: new Promise<void>((resolve) => {
          signalFirst = resolve;
        }),
        signalFirst: () => signalFirst(),
      };
      active = capture;
      return {
        async resolve() {
          await Promise.race([
            capture.first,
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
          ]);
          if (capture.pages.length) await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            candidates: [...capture.pages],
            rejectedDocumentUrl: capture.rejectedDocumentUrl,
          };
        },
        adopt(page: Page) {
          capture.adopted = page;
        },
        async dispose() {
          if (active === capture) active = undefined;
          await Promise.all(
            capture.pages
              .filter((candidate) => candidate !== capture.adopted)
              .map((candidate) => candidate.close().catch(() => undefined)),
          );
        },
      };
    },
  };
}

export async function settlePraxisPopup(page: Page, timeoutMs: number): Promise<void> {
  await page
    .waitForURL((url) => url.href !== "about:blank", { timeout: timeoutMs })
    .catch(() => {
      throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
    });
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {
    throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
  });
}

export async function closePraxisPage(page: Page): Promise<void> {
  await page.close().catch(() => undefined);
}
