import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { observeSemanticPageContext } from "../src/page-context.js";

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

describe("bounded semantic page context", () => {
  it("represents several stable facts in one privacy-safe authoritative observation", async () => {
    await page.setContent(`
      <title>Developer</title>
      <main>
        <h1>Developer</h1>
        <section aria-label="Environment">
          <button role="tab" aria-selected="true">Test mode</button>
          <button role="tab" aria-selected="false">Live mode</button>
        </section>
        <section aria-label="Applications">
          <h2>Existing application</h2>
          <button>Manage credentials</button>
          <a href="/docs">Developer documentation</a>
          <label>API secret <input type="password" value="must-not-leak" /></label>
        </section>
      </main>
    `);

    const before = performance.now();
    const context = await observeSemanticPageContext(page);
    const elapsedMs = performance.now() - before;
    const serialized = JSON.stringify(context);

    expect(context.authority).toMatchObject({ title: "Developer", readiness: "stable" });
    expect(context.completeness).toMatchObject({ kind: "bounded", truncated: false });
    expect(context.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "heading", name: "Developer" }),
        expect.objectContaining({ role: "tab", name: "Test mode", selected: true }),
        expect.objectContaining({ role: "tab", name: "Live mode", selected: false }),
        expect.objectContaining({ role: "button", name: "Manage credentials" }),
        expect.objectContaining({ role: "link", name: "Developer documentation" }),
      ]),
    );
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized.length).toBeLessThan(16_384);
    expect(elapsedMs).toBeLessThan(3_000);

    const oldEpoch = context.authority.documentEpoch;
    await page.getByRole("tab", { name: "Live mode" }).evaluate((element) => {
      element.setAttribute("aria-selected", "true");
    });
    const changed = await observeSemanticPageContext(page);
    expect(changed.authority.documentEpoch).toBeGreaterThan(oldEpoch);
    expect(changed.controls).toContainEqual(
      expect.objectContaining({ role: "tab", name: "Live mode", selected: true }),
    );
  });

  it("reports bounded incompleteness instead of claiming a complete large surface", async () => {
    await page.setContent(
      `<main>${Array.from({ length: 80 }, (_, index) => `<button>Action ${index}</button>`).join(
        "",
      )}</main>`,
    );
    const context = await observeSemanticPageContext(page);
    expect(context.controls).toHaveLength(48);
    expect(context.completeness).toMatchObject({ observed: 80, returned: 48, truncated: true });
  });
});
