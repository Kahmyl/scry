import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  closePraxisBrowserResources,
  openPraxisBrowserSession,
} from "../src/lifecycle/browser-session.js";
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
      await browser.page.goto(`${fixture.origin}/one`, {
        waitUntil: "load",
      });

      const first = await sensor.snapshot();

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
});
