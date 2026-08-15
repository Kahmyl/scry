import { expect, it } from "vitest";

import {
  boundedBrowserClose,
  closePraxisBrowserResources,
  openPraxisBrowserSession,
} from "../src/lifecycle/browser-session.js";

it("owns browser, context, and initial page creation and teardown as one lifecycle", async () => {
  const session = await openPraxisBrowserSession({
    browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    context: { viewport: { width: 900, height: 600 }, acceptDownloads: false },
  });
  expect(session.browser.isConnected()).toBe(true);
  expect(session.context.pages()).toEqual([session.page]);
  expect(session.page.viewportSize()).toEqual({ width: 900, height: 600 });

  await closePraxisBrowserResources(session.context, session.browser);
  expect(session.page.isClosed()).toBe(true);
  expect(session.browser.isConnected()).toBe(false);
});

it("bounds a lifecycle close operation that never settles", async () => {
  await expect(boundedBrowserClose(new Promise(() => undefined), 20)).rejects.toThrow(
    "Browser shutdown timed out",
  );
});
