import { createServer, type RequestListener, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import { navigateAndWaitNative } from "../src/native-browser-navigation.js";

const servers: Server[] = [];
let browser: Browser | undefined;

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_REQUIRED");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("native browser navigation script-origin fence", () => {
  it("allows navigation across declared document origins and rejects an unrelated origin", async () => {
    const originA = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<main>Application</main>");
    });
    const originB = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<main>API documentation</main>");
    });
    const originC = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<main>Unrelated</main>");
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const allowedOrigins = [originA, originB];

    await navigateAndWaitNative(page, originA, allowedOrigins, 5_000);
    await navigateAndWaitNative(page, originB, allowedOrigins, 5_000);
    await expect(navigateAndWaitNative(page, originC, allowedOrigins, 5_000))
      .rejects.toMatchObject({ code: "NATIVE_ORIGIN_NOT_ALLOWED" });
  });

  it("reproduces a loading-only page when an essential cross-origin hydration script is not trusted", async () => {
    const scriptOrigin = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("document.body.innerHTML='<main><label>Email<input placeholder=\\\"Email\\\"></label></main>';");
    });
    const documentOrigin = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<body>Loading...<script src="${scriptOrigin}/hydrate.js"></script></body>`);
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await navigateAndWaitNative(page, documentOrigin, [documentOrigin], 5_000);
    await page.waitForTimeout(100);
    expect(await page.locator("body").innerText()).toBe("Loading...");
    expect(await page.getByPlaceholder("Email").count()).toBe(0);
  });

  it("allows the same asynchronous semantic transition when the script origin is declared trusted", async () => {
    const scriptOrigin = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("setTimeout(() => { document.body.innerHTML='<main><label>Email<input placeholder=\\\"Email\\\"></label></main>'; }, 25);");
    });
    const documentOrigin = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<body>Loading...<script src="${scriptOrigin}/hydrate.js"></script></body>`);
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await navigateAndWaitNative(page, documentOrigin, [documentOrigin], 5_000, [scriptOrigin]);
    await page.getByPlaceholder("Email").waitFor({ state: "visible", timeout: 2_000 });
    expect(await page.getByPlaceholder("Email").count()).toBe(1);
  });
});
