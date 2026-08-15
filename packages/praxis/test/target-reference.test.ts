import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PraxisStaleTargetError } from "../src/observation.js";
import { observeTargetReference, PraxisTargetReference } from "../src/references/target-reference.js";
import {
  clickPinnedElement,
  clickReferencedTarget,
  PraxisClickDispatchError,
} from "../src/interaction/click.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

/**
 * Park the pointer at a neutral position before replacing content so the new
 * document never renders a target under an already-hovered pointer (which can
 * fire pointerover without any mouse movement).
 */
async function resetPage(content: string) {
  await page.mouse.move(0, 0);
  await page.setContent(content);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("Praxis target reference and pinned click", () => {
  it("pins the observed entity and dispatches a click against it", { timeout: 30_000 }, async () => {
    await resetPage(`
      <button id="target">Submit order</button>
      <script>
        globalThis.clicks = [];
        document.querySelector("#target").addEventListener("click", () => {
          globalThis.clicks.push("original");
        });
      </script>
    `);
    const reference = await observeTargetReference(page, page.locator("#target"));
    expect(reference).toBeInstanceOf(PraxisTargetReference);
    await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).resolves.toEqual({
      dispatched: true,
    });
    expect(await page.evaluate(() => (globalThis as unknown as { clicks: string[] }).clicks)).toEqual([
      "original",
    ]);
    await reference.dispose();
  });

  it("pins a same-origin iframe target and dispatches a click exactly once", { timeout: 30_000 }, async () => {
    await resetPage(`
      <iframe id="target-frame" srcdoc='
        <button id="target">Submit order</button>
        <script>
          window.parent.__iframeClicks = [];
          document.getElementById("target").addEventListener("click", () => {
            window.parent.__iframeClicks.push("iframe");
          });
        </script>
      '></iframe>
    `);
    const reference = await observeTargetReference(
      page,
      page.frameLocator("#target-frame").locator("#target"),
    );
    await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).resolves.toEqual({
      dispatched: true,
    });
    expect(await page.evaluate(() => (globalThis as unknown as { __iframeClicks?: string[] }).__iframeClicks)).toEqual([
      "iframe",
    ]);
    await reference.dispose();
  });

  it("refuses when a parent overlay appears before button dispatch", { timeout: 30_000 }, async () => {
    await resetPage(`
      <iframe id="target-frame" srcdoc='
        <button id="target">Submit order</button>
        <script>
          window.parent.__iframeClicks = [];
          document.getElementById("target").addEventListener("click", () => {
            window.parent.__iframeClicks.push("iframe");
          });
        </script>
      '></iframe>
      <script>
        window.__overlayEvents = [];
        const targetFrame = document.getElementById("target-frame");
        targetFrame.addEventListener("pointerover", () => {
          const cover = document.createElement("div");
          cover.id = "overlay-cover";
          cover.style.position = "fixed";
          cover.style.inset = "0";
          cover.style.zIndex = "1000";
          cover.style.background = "transparent";
          ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((name) => {
            cover.addEventListener(name, () => {
              window.__overlayEvents.push(name);
            });
          });
          document.body.appendChild(cover);
        });
        const style = document.createElement("style");
        style.textContent = "iframe { width: 280px; height: 160px; }";
        document.head.appendChild(style);
      </script>
    `);

    const reference = await observeTargetReference(
      page,
      page.frameLocator("#target-frame").locator("#target"),
    );
    await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).rejects.toThrow();
    expect(await page.evaluate(() => (globalThis as unknown as { __overlayEvents?: string[] }).__overlayEvents)).toEqual([]);
    expect(await page.evaluate(() => (globalThis as unknown as { __iframeClicks?: string[] }).__iframeClicks)).toEqual([]);
    await reference.dispose();
  });

  it("accepts a descendant hit under the pinned target", { timeout: 30_000 }, async () => {
    await resetPage(`
      <button id="target">
        <span id="label"><strong>Submit order</strong></span>
      </button>
      <script>
        globalThis.clicks = [];
        document.querySelector("#target").addEventListener("click", () => {
          globalThis.clicks.push("original");
        });
      </script>
    `);
    const reference = await observeTargetReference(page, page.locator("#target"));
    await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).resolves.toEqual({
      dispatched: true,
    });
    expect(await page.evaluate(() => (globalThis as unknown as { clicks: string[] }).clicks)).toEqual([
      "original",
    ]);
    await reference.dispose();
  });

  it("dispatches once for a target inside nested iframes", { timeout: 30_000 }, async () => {
    await resetPage(`<iframe id="outer" style="width:420px;height:240px"></iframe>`);
    const outerElement = await page.locator("#outer").elementHandle();
    const outer = await outerElement!.contentFrame();
    expect(outer).not.toBeNull();
    await outer!.setContent(`<iframe id="inner" style="width:240px;height:120px"></iframe>`);
    const innerElement = await outer!.locator("#inner").elementHandle();
    const inner = await innerElement!.contentFrame();
    expect(inner).not.toBeNull();
    await inner!.setContent(`
      <button id="target">Submit order</button>
      <script>
        window.top.__nestedIframeClicks = [];
        document.getElementById("target").addEventListener("click", () => {
          window.top.__nestedIframeClicks.push("iframe");
        });
      </script>
    `);
    expect(await inner!.locator("#target").count()).toBe(1);
    expect(await inner!.locator("#target").isVisible()).toBe(true);

    const reference = await observeTargetReference(
      page,
      page
        .frameLocator("#outer")
        .frameLocator("#inner")
        .locator("#target"),
    );
    await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).resolves.toEqual({
      dispatched: true,
    });
    expect(
      await page.evaluate(() => (globalThis as unknown as { __nestedIframeClicks: string[] }).__nestedIframeClicks),
    ).toEqual(["iframe"]);
    await reference.dispose();
  });

  it("dispatches once for a target inside a cross-origin iframe", { timeout: 30_000 }, async () => {
    let dispatches = 0;
    const targetServer = createServer((request, response) => {
      if (request.url === "/dispatch") {
        dispatches += 1;
        response.statusCode = 204;
        response.end();
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(`
        <button id="target">Submit order</button>
        <script>
          document.getElementById("target").addEventListener("click", () => {
            void fetch("/dispatch", { method: "POST" });
          });
        </script>
      `);
    });
    const targetOrigin = await listen(targetServer);
    const mainServer = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<iframe id="target-frame" src="${targetOrigin}"></iframe>`);
    });
    const mainOrigin = await listen(mainServer);

    try {
      await page.goto(mainOrigin);
      const locator = page.frameLocator("#target-frame").locator("#target");
      await locator.waitFor({ state: "visible" });
      const reference = await observeTargetReference(page, locator);
      await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).resolves.toEqual({
        dispatched: true,
      });
      await expect.poll(() => dispatches).toBe(1);
      await reference.dispose();
    } finally {
      await closeServer(mainServer);
      await closeServer(targetServer);
    }
  });

  it("refuses when the pinned target moves away after pointer positioning", { timeout: 30_000 }, async () => {
    await resetPage(`
      <button id="decoy" style="position:absolute;left:20px;top:20px;width:160px;height:60px">Decoy</button>
      <button id="target" style="position:absolute;left:20px;top:20px;width:160px;height:60px">Submit</button>
      <script>
        globalThis.buttonEvents = [];
        const target = document.getElementById("target");
        const decoy = document.getElementById("decoy");
        for (const node of [target, decoy]) {
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
            node.addEventListener(type, () => globalThis.buttonEvents.push(node.id + ":" + type));
        }
        target.addEventListener("pointerover", () => { target.style.left = "320px"; }, { once: true });
      </script>
    `);
    const reference = await observeTargetReference(page, page.locator("#target"));
    await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).rejects.toThrow();
    expect(await page.evaluate(() => (globalThis as unknown as { buttonEvents: string[] }).buttonEvents)).toEqual([]);
    await reference.dispose();
  });

  it("reports dispatch uncertainty when mouse-up fails after mouse-down input", { timeout: 30_000 }, async () => {
    await resetPage(`
      <button id="target">Submit</button>
      <script>
        globalThis.buttonEvents = [];
        const target = document.getElementById("target");
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
          target.addEventListener(type, () => globalThis.buttonEvents.push(type));
      </script>
    `);
    const reference = await observeTargetReference(page, page.locator("#target"));
    const mouse = page.mouse as unknown as { down: typeof page.mouse.down; up: typeof page.mouse.up };
    const press = page.mouse.down.bind(page.mouse);
    const release = page.mouse.up.bind(page.mouse);
    let downResolved = false;
    mouse.down = async (...args) => {
      await press(...args);
      downResolved = true;
    };
    mouse.up = async () => {
      throw new Error("synthetic mouse-up transport failure");
    };
    try {
      await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).rejects.toThrow(
        PraxisClickDispatchError,
      );
    } finally {
      mouse.down = press;
      mouse.up = release;
      await page.mouse.move(0, 0);
      await release();
    }
    expect(downResolved).toBe(true);
    await reference.dispose();
  });

  it("uses the requested element-relative click position", { timeout: 30_000 }, async () => {
    await resetPage(`
      <button id="target" style="width:200px;height:80px">Target</button>
      <script>
        globalThis.clickPoints = [];
        document.getElementById("target").addEventListener("click", (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          globalThis.clickPoints.push({ x: event.clientX - rect.left, y: event.clientY - rect.top });
        });
      </script>
    `);
    const reference = await observeTargetReference(page, page.locator("#target"));
    await expect(
      clickPinnedElement(page, reference.element(), {
        timeoutMs: 2_000,
        position: { x: 18, y: 24 },
        isCurrent: () => reference.assertCurrent(),
      }),
    ).resolves.toEqual({ dispatched: true });
    const [point] = await page.evaluate(
      () => (globalThis as unknown as { clickPoints: Array<{ x: number; y: number }> }).clickPoints,
    );
    expect(point!.x).toBeCloseTo(18, 0);
    expect(point!.y).toBeCloseTo(24, 0);
    await reference.dispose();
  });

  it("refuses when only the requested click position is occluded", { timeout: 30_000 }, async () => {
    await resetPage(`
      <button id="target" style="position:absolute;left:20px;top:20px;width:200px;height:80px">Target</button>
      <div id="cover" style="position:absolute;left:20px;top:20px;width:50px;height:50px;z-index:2"></div>
      <script>
        globalThis.buttonEvents = [];
        for (const node of [document.getElementById("target"), document.getElementById("cover")]) {
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
            node.addEventListener(type, () => globalThis.buttonEvents.push(node.id + ":" + type));
        }
      </script>
    `);
    expect(await page.evaluate(() => document.elementFromPoint(120, 60)?.id)).toBe("target");
    const reference = await observeTargetReference(page, page.locator("#target"));
    await expect(
      clickPinnedElement(page, reference.element(), {
        timeoutMs: 2_000,
        position: { x: 15, y: 15 },
        isCurrent: () => reference.assertCurrent(),
      }),
    ).rejects.toThrow(PraxisStaleTargetError);
    expect(await page.evaluate(() => (globalThis as unknown as { buttonEvents: string[] }).buttonEvents)).toEqual([]);
    await reference.dispose();
  });

  it("refuses before button input when a fixed ancestor overlay already exists", { timeout: 30_000 }, async () => {
    await resetPage(`
      <iframe id="target-frame" srcdoc='
        <button id="target">Submit order</button>
        <script>
          window.parent.__iframeClicks = [];
          document.getElementById("target").addEventListener("click", () => {
            window.parent.__iframeClicks.push("iframe");
          });
        </script>
      '></iframe>
      <style>
        iframe {
          position: relative;
          width: 280px;
          height: 160px;
        }
      </style>
      <div id="ancestor-overlay"></div>
      <script>
        window.__overlayEvents = [];
        const overlay = document.getElementById("ancestor-overlay");
        Object.assign(overlay.style, {
          position: "fixed",
          inset: "0",
          zIndex: "1000",
          background: "transparent",
        });
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((name) => {
          overlay.addEventListener(name, () => {
            window.__overlayEvents.push(name);
          });
        });
      </script>
    `);

    const reference = await observeTargetReference(
      page,
      page.frameLocator("#target-frame").locator("#target"),
    );
    await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).rejects.toThrow();
    const events = await page.evaluate(
      () => (globalThis as unknown as { __overlayEvents?: string[] }).__overlayEvents,
    );
    expect(events).toEqual([]);
    expect(await page.evaluate(() => (globalThis as unknown as { __iframeClicks?: string[] }).__iframeClicks)).toEqual(
      [],
    );
    await reference.dispose();
  });

  it("serializes only opaque mechanical identity", { timeout: 30_000 }, async () => {
    await resetPage(`<button id="target">Save</button>`);
    const reference = await observeTargetReference(page, page.locator("#target"));
    const serialized = JSON.stringify(reference);
    expect(serialized).toContain("documentIdentity");
    expect(serialized).not.toContain("#target");
    expect(serialized).not.toContain("Save");
    await reference.dispose();
  });

  it("permits unrelated document mutation", { timeout: 30_000 }, async () => {
    await resetPage(`
      <button id="target">Save</button>
      <script>
        globalThis.clicks = [];
        document.querySelector("#target").addEventListener("click", () => {
          globalThis.clicks.push("original");
        });
      </script>
    `);
    const reference = await observeTargetReference(page, page.locator("#target"));
    await page.locator("body").evaluate((body) => body.append(document.createElement("span")));
    await expect(clickReferencedTarget(reference, { timeoutMs: 2_000 })).resolves.toEqual({
      dispatched: true,
    });
    expect(await page.evaluate(() => (globalThis as unknown as { clicks: string[] }).clicks)).toEqual([
      "original",
    ]);
    await reference.dispose();
  });

  it("refuses when the observed entity is replaced during pointer interaction", { timeout: 30_000 }, async () => {
    await resetPage(`
      <button id="target">Submit order</button>
      <script>
        globalThis.clicks = [];
        const original = document.querySelector("#target");
        original.addEventListener("click", () => globalThis.clicks.push("original"));
        original.addEventListener("pointerover", () => {
          const replacement = document.createElement("button");
          replacement.id = "replacement";
          replacement.textContent = "Submit order";
          replacement.addEventListener("click", () => globalThis.clicks.push("replacement"));
          original.replaceWith(replacement);
        }, { once: true });
      </script>
    `);
    const reference = await observeTargetReference(page, page.locator("#target"));
    await expect(clickReferencedTarget(reference, { timeoutMs: 1_500 })).rejects.toThrow(
      PraxisStaleTargetError,
    );
    // Neither the stale original nor the replacement may receive the click.
    expect(await page.evaluate(() => (globalThis as unknown as { clicks: string[] }).clicks)).toEqual([]);
    await reference.dispose();
  });

  it("refuses after the document changes", { timeout: 30_000 }, async () => {
    await resetPage(`<button id="target">Save</button>`);
    const reference = await observeTargetReference(page, page.locator("#target"));
    await page.goto("data:text/html,<button>Replacement</button>");
    await expect(clickReferencedTarget(reference, { timeoutMs: 1_500 })).rejects.toThrow(
      "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
    );
    await reference.dispose();
  });

  it("refuses after the observed entity is detached without replacement", { timeout: 30_000 }, async () => {
    await resetPage(`<button id="target">Save</button>`);
    const reference = await observeTargetReference(page, page.locator("#target"));
    await page.locator("#target").evaluate((element) => element.remove());
    await expect(reference.assertCurrent()).rejects.toThrow(PraxisStaleTargetError);
    await expect(clickReferencedTarget(reference, { timeoutMs: 1_500 })).rejects.toThrow(
      PraxisStaleTargetError,
    );
    await reference.dispose();
  });
});
