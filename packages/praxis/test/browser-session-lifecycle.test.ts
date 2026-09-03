import { expect, it, vi } from "vitest";

import {
  boundedBrowserClose,
  closePraxisBrowserResources,
  destroyPraxisIsolatedSession,
  openPraxisBrowserSession,
  openPraxisBrowserServerSession,
} from "../src/lifecycle/browser-session.js";
import {
  createAuthoringBrowserSession,
  PraxisBrowserAuthorityLostError,
} from "../src/lifecycle/authoring-browser-session.js";
import {
  isBrowserAuthorityLoss as isBrowserAuthorityLossFromPolicy,
  isBrowserInfrastructureFailure as isBrowserInfrastructureFailureFromPolicy,
} from "../src/lifecycle/execution-browser-policy.js";

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
  const outcome = await destroyPraxisIsolatedSession(
    {
      context: { close: () => new Promise(() => undefined) } as never,
      browser: { close: browserClose } as never,
      forceClose,
    },
    20,
  );
  expect(outcome).toBe("force_terminated");
  expect(forceClose).toHaveBeenCalledOnce();
  expect(browserClose).not.toHaveBeenCalled();
});

it("classifies a Playwright target crash as browser authority loss", () => {
  const playwrightCrash = new Error("page.evaluate: Target crashed");
  const canonical = new PraxisBrowserAuthorityLostError(playwrightCrash);

  expect(isBrowserInfrastructureFailureFromPolicy(playwrightCrash)).toBe(true);
  expect(isBrowserAuthorityLossFromPolicy(playwrightCrash)).toBe(true);
  expect(isBrowserAuthorityLossFromPolicy(canonical)).toBe(true);
  expect(JSON.stringify(canonical)).not.toContain("Target crashed");
});

it("canonicalizes a real renderer crash and revokes document authority", async () => {
  const opened = await openPraxisBrowserSession({
    browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    context: { viewport: { width: 900, height: 600 }, acceptDownloads: false },
  });
  const session = await createAuthoringBrowserSession({
    sessionId: "11111111-1111-4111-8111-111111111111",
    environmentId: "22222222-2222-4222-8222-222222222222",
    veilAdmissionKey: "test-veil-admission-key",
    browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    policy: {
      allowedOrigins: ["https://example.test"],
      trustedScriptOrigins: [],
      allowPrivateNetwork: false,
      allowDownloads: false,
      allowPopups: false,
      maxActions: 2,
      maxDurationMs: 30_000,
      maxNavigations: 1,
    },
    openBrowser: async () => opened,
    executeInteraction: async () => {
      throw new Error("INTERACTION_NOT_EXPECTED");
    },
  });
  const cdp = await session.context.newCDPSession(session.page);

  const crashed = new Promise<void>((resolve) => session.page.once("crash", () => resolve()));
  void cdp.send("Page.crash").catch(() => undefined);
  await crashed;
  await expect(session.observeDocument()).rejects.toMatchObject({
    code: "PRAXIS_BROWSER_AUTHORITY_LOST",
  });
  expect(session.state()).toBe("crashed");

  await session.close();
}, 30_000);
