import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PraxisStaleTargetError } from "../src/observation.js";
import { observeTargetReference, PraxisTargetReference } from "../src/references/target-reference.js";
import { clickReferencedTarget } from "../src/interaction/click.js";

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
