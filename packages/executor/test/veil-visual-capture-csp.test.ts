import { createServer, type Server } from "node:http";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { observeAndMaskPraxisVisualRegions } from "@scry/praxis";

let browser: Browser;
let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'none'; img-src data:; frame-src 'none'",
    );
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`
      <!doctype html>
      <html>
        <body>
          <label for="secret">Account secret</label>
          <input id="secret" value="canary-value">
          <div>Unclassified text</div>
        </body>
      </html>
    `);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") throw new Error("CSP_TEST_SERVER_UNAVAILABLE");

  origin = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
});

afterAll(async () => {
  await browser?.close();

  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

describe("Praxis visual masking under page CSP", () => {
  it("masks captured regions without bypassing style-src CSP", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(origin, {
      waitUntil: "domcontentloaded",
    });

    const observation = await observeAndMaskPraxisVisualRegions(page);

    expect(observation.regions.length).toBeGreaterThan(0);
    expect(observation.regions.every((region) => region.masked)).toBe(true);

    const state = await page.locator("#secret").evaluate((element) => {
      const style = getComputedStyle(element);

      return {
        mask: element.getAttribute("data-scry-veil-capture-mask"),
        filter: style.filter,
        visibility: style.visibility,
        inlineFilter: (element as HTMLElement).style.filter,
      };
    });

    expect(state.mask).toBe("true");
    expect(state.filter).not.toBe("none");
    expect(state.visibility).not.toBe("hidden");
    expect(state.inlineFilter).toContain("brightness");

    await context.close();
  });
});
