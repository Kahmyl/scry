import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { operationOutcomeSchema, praxisObservationSchema } from "@scry/contracts";
import { describe, expect, it } from "vitest";

import {
  closePraxisBrowserResources,
  openPraxisBrowserSession,
} from "../src/lifecycle/browser-session.js";
import { createAuthoringBrowserSession } from "../src/lifecycle/authoring-browser-session.js";
import { createPraxisReadOnlyCdpSensor } from "../src/lifecycle/read-only-cdp-sensor.js";

async function fixtureServer() {
  const server = createServer((request, response) => {
    if (request.url === "/one") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        '<!doctype html><html><head><title>one</title></head><body><img src="/broken"><main>one</main></body></html>',
      );
      return;
    }

    if (request.url === "/two") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        "<!doctype html><html><head><title>two</title></head><body><main>two</main></body></html>",
      );
      return;
    }

    if (request.url === "/broken") {
      request.socket.destroy();
      return;
    }

    if (request.url === "/worker-shell") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        '<!doctype html><html><body><main>worker shell</main><script>new Worker("/dedicated-worker.js")</script></body></html>',
      );
      return;
    }

    if (request.url === "/dedicated-worker.js") {
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
      });
      response.end("fetch('/worker-originated-data')");
      return;
    }

    if (request.url === "/worker-originated-data") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("worker fetch");
      return;
    }

    if (request.url === "/loading-shell") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end("<!doctype html><html><body><main>Loading...</main></body></html>");
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("fixture server did not expose a TCP address");
  }

  return {
    server,
    origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
  };
}

async function closeServer(server: Server) {
  server.close();
  await once(server, "close");
}

describe("Praxis read-only CDP sensor", () => {
  it("reports bounded browser facts without becoming an action or payload surface", async () => {
    const fixture = await fixtureServer();

    const browser = await openPraxisBrowserSession({
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      context: {
        viewport: { width: 900, height: 600 },
        acceptDownloads: false,
      },
    });

    const sensor = await createPraxisReadOnlyCdpSensor(browser.context, browser.page);

    try {
      const initial = await sensor.snapshot();

      expect(initial.authority.loaderId).not.toBe("");

      await browser.page.goto(`${fixture.origin}/one`, {
        waitUntil: "load",
      });

      const first = await sensor.snapshot();

      await browser.page.goto(`${fixture.origin}/one#same-document`, {
        waitUntil: "load",
      });

      const sameDocument = await sensor.snapshot();

      expect(sameDocument.authority.loaderId).toBe(first.authority.loaderId);
      expect(sameDocument.authority.loaderChanged).toBe(false);

      await browser.page.goto(`${fixture.origin}/two`, {
        waitUntil: "load",
      });

      const second = await sensor.snapshot();

      expect(second.kind).toBe("chromium_read_only");

      expect(second.authority.frameId).toBe(first.authority.frameId);

      expect(second.authority.loaderId).not.toBe(first.authority.loaderId);

      expect(second.authority).toMatchObject({
        previousLoaderId: first.authority.loaderId,
        loaderChanged: true,
      });

      expect(second.authority.loaderTransitionsObserved).toBeGreaterThanOrEqual(1);

      expect(second.network.observedRequests).toBeGreaterThan(0);

      expect(second.network.observedFailures).toBeGreaterThanOrEqual(1);

      expect(second.network.recentRequests.length).toBeLessThanOrEqual(12);

      expect(second.network.recentFailures.length).toBeLessThanOrEqual(6);

      expect(second.network.recentFailures[0]?.reasonCode).toMatch(
        /^(?:NET::[A-Z0-9_]+|NETWORK_FAILURE)$/,
      );

      expect(second.layout).toEqual({
        clientWidth: 900,
        clientHeight: 600,
      });

      const serialized = JSON.stringify(second);

      for (const forbidden of [
        '"url"',
        '"headers"',
        '"cookies"',
        '"postData"',
        '"body"',
        '"response"',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await sensor.close().catch(() => undefined);

      await closePraxisBrowserResources(browser.context, browser.browser).catch(() => undefined);

      await closeServer(fixture.server);
    }
  }, 15_000);

  it("preserves missing loader authority for a worker-originated request", async () => {
    const fixture = await fixtureServer();
    const browser = await openPraxisBrowserSession({
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      context: {
        viewport: { width: 900, height: 600 },
        acceptDownloads: false,
      },
    });
    const sensor = await createPraxisReadOnlyCdpSensor(browser.context, browser.page);

    try {
      const workerFetch = browser.page.waitForResponse((response) =>
        response.url().endsWith("/worker-originated-data"),
      );
      await browser.page.goto(`${fixture.origin}/worker-shell`, { waitUntil: "load" });
      await workerFetch;

      const snapshot = await sensor.snapshot();
      const workerRequest = snapshot.network.recentRequests.find(
        (request) => request.loaderId === undefined,
      );

      expect(workerRequest).toMatchObject({ type: "Script" });
      expect(snapshot.authority.loaderId).not.toBe("");
      expect(
        operationOutcomeSchema.parse({
          operationId: "observe-current-document",
          functionalResult: "succeeded",
          mutationOutcome: "not_applied",
          privacyResult: "verified",
          evidenceResult: [],
          qualityFindings: [],
          durationMs: 1,
          semanticPageContext: {
            schemaVersion: 2,
            authority: {
              pageId: "page-authority",
              documentEpoch: 1,
              url: `${fixture.origin}/worker-shell`,
              title: "Worker shell",
              readiness: "stable",
            },
            completeness: { kind: "bounded", observed: 0, returned: 0, truncated: false },
            controls: [],
            browserSensor: snapshot,
          },
        }).semanticPageContext?.browserSensor,
      ).toEqual(snapshot);
    } finally {
      await sensor.close().catch(() => undefined);
      await closePraxisBrowserResources(browser.context, browser.browser).catch(() => undefined);
      await closeServer(fixture.server);
    }
  }, 15_000);

  it("returns a valid authoring observation for worker and loading-shell states", async () => {
    const fixture = await fixtureServer();
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
        allowedOrigins: [fixture.origin],
        trustedScriptOrigins: [],
        allowPrivateNetwork: true,
        allowDownloads: false,
        allowPopups: false,
        maxActions: 2,
        maxDurationMs: 30_000,
        maxNavigations: 4,
      },
      openBrowser: async () => opened,
      executeInteraction: async () => {
        throw new Error("INTERACTION_NOT_EXPECTED");
      },
    });

    try {
      await session.page.goto(`${fixture.origin}/two`, { waitUntil: "load" });
      praxisObservationSchema.parse(await session.observeDocument());

      const workerFetch = session.page.waitForResponse((response) =>
        response.url().endsWith("/worker-originated-data"),
      );
      await session.page.goto(`${fixture.origin}/worker-shell`, { waitUntil: "load" });
      await workerFetch;
      const workerObservation = praxisObservationSchema.parse(await session.observeDocument());
      const workerRequest =
        workerObservation.semanticPageContext.browserSensor?.network.recentRequests.find(
          (request) => request.loaderId === undefined,
        );

      expect(workerObservation.documentEpoch).toBe(2);
      expect(workerObservation.semanticPageContext.browserSensor?.authority.loaderId).not.toBe("");
      expect(workerRequest).toMatchObject({ type: "Script" });

      await session.page.goto(`${fixture.origin}/loading-shell`, { waitUntil: "load" });
      const loadingObservation = praxisObservationSchema.parse(await session.observeDocument());

      expect(loadingObservation.documentEpoch).toBe(3);
      expect(loadingObservation.semanticPageContext.controls).toEqual([]);
      expect(loadingObservation.semanticPageContext.browserSensor?.authority.loaderId).not.toBe("");
    } finally {
      await session.close().catch(() => undefined);
      await closeServer(fixture.server);
    }
  }, 20_000);
});
