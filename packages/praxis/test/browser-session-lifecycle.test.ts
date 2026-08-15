import { expect, it, vi } from "vitest";

import {
  boundedBrowserClose,
  closePraxisBrowserResources,
  destroyPraxisIsolatedSession,
  openPraxisBrowserSession,
  openPraxisBrowserServerSession,
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

it("owns browser-server connection and records graceful ownership release", async () => {
  const session = await openPraxisBrowserServerSession(
    { viewport: { width: 700, height: 500 } },
    { kind: "runtime_browser", ownerId: "lifecycle-test" },
  );
  expect(session.ownership).toMatchObject({
    ownerKind: "runtime_browser",
    ownerId: "lifecycle-test",
  });
  expect(session.ownership.events.map((event) => event.milestone)).toEqual([
    "created",
    "ownership_acquired",
  ]);
  await session.context.close();
  await session.browser.close();
  expect(session.ownership.events.map((event) => event.milestone)).toEqual(
    expect.arrayContaining([
      "close_requested",
      "graceful_close_started",
      "graceful_close_completed",
      "process_exit_observed",
      "ownership_released",
    ]),
  );
});

it("force-terminates an isolated session when graceful context destruction stalls", async () => {
  const forceClose = vi.fn(async () => undefined);
  const browserClose = vi.fn(async () => undefined);
  const outcome = await destroyPraxisIsolatedSession({
    context: { close: () => new Promise(() => undefined) } as never,
    browser: { close: browserClose } as never,
    forceClose,
  }, 20);
  expect(outcome).toBe("force_terminated");
  expect(forceClose).toHaveBeenCalledOnce();
  expect(browserClose).not.toHaveBeenCalled();
});
