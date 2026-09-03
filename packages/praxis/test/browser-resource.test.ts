import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import {
  MAX_RESOURCE_REFERENCES,
  PraxisPublicResourceError,
  inspectPraxisBrowserResources,
  installPraxisBrowserResourcePerception,
  readPraxisPublicResource,
} from "../src/browser-resource.js";

let browsers: Browser[] = [];
afterEach(async () => {
  await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
  browsers = [];
});

async function pageForSyntheticResponses() {
  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: "test page" }),
  );
  await page.goto("https://example.test/page");
  return { page, stop: installPraxisBrowserResourcePerception(page) };
}

function emitTrackedResponse(
  page: import("playwright").Page,
  input: {
    contentType?: string;
    status?: number;
    url?: string;
    headers?: Record<string, string>;
    body?: Buffer;
    bodyError?: boolean;
  },
) {
  const emitter = page as unknown as { emit(event: string, payload: unknown): void };
  const request = {
    method: () => "GET",
    frame: () => page.mainFrame(),
  };
  emitter.emit("request", request);
  emitter.emit("response", {
    request: () => request,
    headers: () => ({ "content-type": input.contentType ?? "application/json", ...input.headers }),
    status: () => input.status ?? 200,
    url: () => input.url ?? "https://example.test/resource.json",
    body: () =>
      input.bodyError ? Promise.reject(new Error("BODY_UNAVAILABLE")) : Promise.resolve(input.body),
  });
}

async function pageWithResources(resources: Array<{ path: string; body: string; type?: string }>) {
  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const page = await browser.newPage();
  let requestCount = 0;
  await page.route("**/*", async (route) => {
    requestCount += 1;
    const url = new URL(route.request().url());
    const resource = resources.find((candidate) => candidate.path === url.pathname);
    if (resource)
      return route.fulfill({
        contentType: resource.type ?? "application/json",
        body: resource.body,
      });
    if (url.pathname === "/page")
      return route.fulfill({
        contentType: "text/html",
        body: `<script>Promise.all(${JSON.stringify(resources.map((resource) => resource.path))}.map((path) => fetch(path))).then(() => document.body.dataset.loaded = 'yes')</script>`,
      });
    return route.fulfill({ status: 404 });
  });
  const stop = installPraxisBrowserResourcePerception(page);
  await page.goto("https://example.test/page");
  await page.locator("body[data-loaded=yes]").waitFor();
  return { page, stop, requestCount: () => requestCount };
}

describe("bounded Praxis browser-resource perception", () => {
  it("ranks main-frame JSON ahead of XML pressure without exposing body text", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    let requestCount = 0;
    await page.route("**/*", async (route) => {
      requestCount += 1;
      const path = new URL(route.request().url()).pathname;
      if (path === "/page")
        return route.fulfill({
          contentType: "text/html",
          body: `<script>Promise.all([fetch('/contract.json'), ${Array.from(
            { length: 8 },
            (_, index) => `fetch('/logo-${index}.svg')`,
          ).join(",")}]).then(() => document.body.dataset.loaded = 'yes')</script>`,
        });
      if (path === "/contract.json")
        return route.fulfill({
          contentType: "application/json",
          body: '{"contract":"public"}',
        });
      if (/^\/logo-\d+\.svg$/.test(path))
        return route.fulfill({ contentType: "image/svg+xml", body: "<svg/>" });
      return route.fulfill({ status: 404 });
    });
    const stop = installPraxisBrowserResourcePerception(page);
    try {
      await page.goto("https://example.test/page");
      await page.locator("body[data-loaded=yes]").waitFor();
      const before = requestCount;
      const inspection = await inspectPraxisBrowserResources(page);
      expect(inspection.resources).toHaveLength(MAX_RESOURCE_REFERENCES);
      expect(inspection.resources.map((resource) => resource.kind)).toEqual([
        "json",
        ...Array(7).fill("xml"),
      ]);
      expect(inspection.resources[0]).toMatchObject({ kind: "json" });
      expect(JSON.stringify(inspection)).not.toContain("public");
      expect(requestCount).toBe(before);
    } finally {
      stop();
    }
  });

  it("excludes child-frame JSON while preserving main-frame-only eligibility", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/page")
        return route.fulfill({ contentType: "text/html", body: '<iframe src="/child"></iframe>' });
      if (path === "/child")
        return route.fulfill({
          contentType: "text/html",
          body: "<script>fetch('/iframe.json').then(() => document.body.dataset.loaded = 'yes')</script>",
        });
      if (path === "/iframe.json")
        return route.fulfill({ contentType: "application/json", body: '{"iframe":true}' });
      return route.fulfill({ status: 404 });
    });
    const stop = installPraxisBrowserResourcePerception(page);
    try {
      await page.goto("https://example.test/page");
      const child = page.frames().find((frame) => frame.url().endsWith("/child"));
      await child?.locator("body[data-loaded=yes]").waitFor();
      const inspection = await inspectPraxisBrowserResources(page);
      expect(inspection.resources).toEqual([]);
    } finally {
      stop();
    }
  });

  it("refuses post-eligibility inspection failures without exposing resource text", async () => {
    const { page, stop } = await pageForSyntheticResponses();
    try {
      emitTrackedResponse(page, { status: 500 });
      emitTrackedResponse(page, { url: "https://other.test/resource.json" });
      emitTrackedResponse(page, {
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        body: Buffer.from("{}"),
      });
      emitTrackedResponse(page, { body: Buffer.alloc(2 * 1024 * 1024 + 1) });
      emitTrackedResponse(page, { bodyError: true });
      emitTrackedResponse(page, { body: Buffer.from([0xff]) });
      emitTrackedResponse(page, {
        body: Buffer.from('{"client_secret":"sk_live_never_release_123456"}'),
      });
      const inspection = await inspectPraxisBrowserResources(page);
      expect(inspection.resources).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("excludes a prior-document response whose generation binding was cleared", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    let oldRequest: import("playwright").Request | undefined;
    let resolveOldRequest: (() => void) | undefined;
    const oldRequestStarted = new Promise<void>((resolve) => {
      resolveOldRequest = resolve;
    });
    await page.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/first") return route.fulfill({ contentType: "text/html", body: "first" });
      if (path === "/old.json") {
        oldRequest = route.request();
        resolveOldRequest?.();
        return;
      }
      if (path === "/second") return route.fulfill({ contentType: "text/html", body: "second" });
      return route.fulfill({ status: 404 });
    });
    const stop = installPraxisBrowserResourcePerception(page);
    try {
      await page.goto("https://example.test/first");
      void page.evaluate(() => fetch("/old.json").catch(() => undefined)).catch(() => undefined);
      await oldRequestStarted;
      await page.goto("https://example.test/second", { waitUntil: "commit" });
      (page as unknown as { emit(event: string, payload: unknown): void }).emit("response", {
        request: () => oldRequest,
        headers: () => ({ "content-type": "application/json" }),
      });
      const inspection = await inspectPraxisBrowserResources(page);
      expect(inspection.resources).toEqual([]);
    } finally {
      stop();
    }
  });

  it("bounds pending main-frame requests without fabricating references", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    const pending: Array<import("playwright").Route> = [];
    await page.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/page")
        return route.fulfill({
          contentType: "text/html",
          body: `<script>Promise.all(${JSON.stringify(
            Array.from({ length: 65 }, (_, index) => `/resource-${index}.json`),
          )}.map((path) => fetch(path))).then(() => document.body.dataset.loaded = 'yes')</script>`,
        });
      if (/^\/resource-\d+\.json$/.test(path)) {
        pending.push(route);
        if (pending.length === 65)
          await Promise.all(
            pending.map((delayed) =>
              delayed.fulfill({ contentType: "application/json", body: '{"public":true}' }),
            ),
          );
        return;
      }
      return route.fulfill({ status: 404 });
    });
    const stop = installPraxisBrowserResourcePerception(page);
    try {
      await page.goto("https://example.test/page");
      await page.locator("body[data-loaded=yes]").waitFor();
      const inspection = await inspectPraxisBrowserResources(page);
      expect(inspection.completeness).toMatchObject({
        observed: 64,
        returned: MAX_RESOURCE_REFERENCES,
        truncated: true,
      });
      expect(inspection.resources).toHaveLength(MAX_RESOURCE_REFERENCES);
    } finally {
      stop();
    }
  });

  it.each(["json-first", "json-last"] as const)(
    "retains and exposes JSON despite more than sixteen XML responses when %s",
    async (ordering) => {
      const json = {
        path: "/contract.json",
        body: JSON.stringify({ contract: "useful-json-contract" }),
      };
      const xml = Array.from({ length: 20 }, (_, index) => ({
        path: `/asset-${index}.xml`,
        body: `<asset>${index}</asset>`,
        type: "application/xml",
      }));
      const { page, stop, requestCount } = await pageWithResources(
        ordering === "json-first" ? [json, ...xml] : [...xml, json],
      );
      try {
        const before = requestCount();
        const inspection = await inspectPraxisBrowserResources(page);
        expect(inspection.completeness).toMatchObject({
          observed: 21,
          returned: MAX_RESOURCE_REFERENCES,
          truncated: true,
        });
        expect(inspection.resources[0]).toMatchObject({ kind: "json" });
        expect(JSON.stringify(inspection)).not.toContain("useful-json-contract");
        const read = await readPraxisPublicResource(page, {
          reference: inspection.resources[0]!.reference,
        });
        expect(read.text).toContain("useful-json-contract");
        expect(requestCount()).toBe(before);
      } finally {
        stop();
      }
    },
  );

  it("releases only an exact Veil-admitted same-origin JSON resource", async () => {
    const endpoint = "POST /orders";
    const { page, stop } = await pageWithResources([
      {
        path: "/contract.json",
        body: JSON.stringify({ paths: { "/orders": { post: endpoint } } }),
      },
      {
        path: "/placeholder.json",
        body: '{"example":"https://docs.example.test/reference#access_token=<EXAMPLE_ACCESS_TOKEN>"}',
      },
      {
        path: "/secret.json",
        body: '{"example":"https://docs.example.test/reference#access_token=refused-example-value"}',
      },
      { path: "/logo.png", body: "not-an-image", type: "image/png" },
    ]);
    try {
      const inspection = await inspectPraxisBrowserResources(page);
      expect(JSON.stringify(inspection)).not.toContain(endpoint);
      expect(JSON.stringify(inspection)).not.toContain("client_secret");
      expect(inspection.resources).toHaveLength(2);
      expect(inspection.resources[0]).toMatchObject({ kind: "json" });
      const read = await readPraxisPublicResource(page, {
        reference: inspection.resources[0]!.reference,
      });
      expect(read.text).toContain(endpoint);
      const placeholder = await readPraxisPublicResource(page, {
        reference: inspection.resources[1]!.reference,
      });
      expect(placeholder.text).toContain("<EXAMPLE_ACCESS_TOKEN>");
      await expect(
        readPraxisPublicResource(page, {
          reference: "context-resource-00000000000000000000000000000000",
        }),
      ).rejects.toBeInstanceOf(PraxisPublicResourceError);
    } finally {
      stop();
    }
  });

  it("bounds candidates and references and stales an exact resource after navigation", async () => {
    const { page, stop } = await pageWithResources(
      Array.from({ length: 20 }, (_, index) => ({
        path: `/resource-${index}.json`,
        body: JSON.stringify({ index }),
      })),
    );
    try {
      const inspection = await inspectPraxisBrowserResources(page);
      expect(inspection.resources).toHaveLength(MAX_RESOURCE_REFERENCES);
      expect(inspection.completeness).toMatchObject({
        observed: 20,
        returned: MAX_RESOURCE_REFERENCES,
        truncated: true,
      });
      const reference = inspection.resources[0]!.reference;
      await page.goto("https://example.test/page");
      await expect(readPraxisPublicResource(page, { reference })).rejects.toMatchObject({
        code: "PUBLIC_RESOURCE_REFERENCE_UNKNOWN",
      });
    } finally {
      stop();
    }
  });
});
