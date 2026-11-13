import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { describe, expect, it } from "vitest";
import { createSessionDenials } from "../src/mcp-native/scope-denials.js";
// @ts-expect-error Private JavaScript transport, exercised as shipped.
import { originProxy } from "../src/mcp-native/proxy.mjs";

const live = process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
const listen = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
function viaProxy(proxyUrl: string, destination: string, method = "GET") {
  const proxy = new URL(proxyUrl);
  return new Promise<number>((resolve, reject) => {
    const req = request(
      { host: proxy.hostname, port: Number(proxy.port), method, path: destination },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    req.once("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    req.once("error", reject);
    req.end();
  });
}

live("native scope proxy diagnostics with real local traffic", () => {
  it("observes denied HTTP origins and opaque CONNECT endpoints without inferring HTTPS", async () => {
    const denials = createSessionDenials({ clean: (value) => value });
    const proxy = await originProxy(["http://allowed.example"], denials.record);
    try {
      expect(await viaProxy(proxy.url, "http://denied.example/private?token=never-display")).toBe(
        403,
      );
      expect(await viaProxy(proxy.url, "opaque.example:443", "CONNECT")).toBe(403);
      expect(denials.snapshot().endpoints).toEqual([
        { transport: "http_origin", endpoint: "http://denied.example", count: 1 },
        { transport: "connect_endpoint", endpoint: "opaque.example:443", count: 1 },
      ]);
      expect(JSON.stringify(denials.snapshot())).not.toMatch(
        /private|token|never-display|https:\/\//,
      );
    } finally {
      denials.dispose();
      await proxy.close();
    }
  });

  it("keeps a successful innocent page/action successful when its background dependency is denied", async () => {
    const app = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<title>Innocent page</title><button id="save" onclick="document.querySelector('#state').textContent='Saved';new Image().src='http://blocked-background.invalid/pixel?credential=never-display'">Save</button><p id="state">Ready</p>`,
      );
    });
    await listen(app);
    const origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const denials = createSessionDenials({ clean: (value) => value });
    const proxy = await originProxy([origin], denials.record);
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        proxy: { server: proxy.url },
        args: ["--proxy-bypass-list=<-loopback>"],
      });
      const page = await browser.newPage();
      expect((await page.goto(origin))?.status()).toBe(200);
      expect(await page.title()).toBe("Innocent page");
      const background = page.waitForResponse((response) =>
        response.url().includes("blocked-background.invalid"),
      );
      await page.click("#save");
      expect((await background).status()).toBe(403);
      expect(await page.textContent("#state")).toBe("Saved");
      const snapshot = denials.snapshot();
      expect(snapshot.scopeRestrictionObserved).toBe(true);
      expect(snapshot.endpoints).toContainEqual({
        transport: "http_origin",
        endpoint: "http://blocked-background.invalid",
        count: 1,
      });
      expect(snapshot.applicationConclusion).toBe("not_determined");
      expect(snapshot.actionDispatch).toBe("not_determined");
      expect(snapshot.causalAssociation).toBe("not_established");
      expect(JSON.stringify(snapshot)).not.toMatch(/pixel|credential|never-display/);
    } finally {
      await browser?.close();
      denials.dispose();
      await proxy.close();
      await close(app);
    }
  }, 20_000);
});
