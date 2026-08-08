import { SecretRedactor } from "@scry/policy";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sanitizedDomStructure } from "../src/evidence-runtime.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

describe("DOM evidence sanitation", () => {
  it("retains bounded control semantics without retaining values or secrets", async () => {
    const secret = "registered-secret-value";
    await page.setContent(`
      <main data-account="private-account">
        <h1>Partner Portal</h1>
        <p>Private account narrative</p>
        <a href="/developer" aria-label="Developer ${secret}">Developer</a>
        <button aria-expanded="false" data-token="private-token">Test Mode ${secret}</button>
        <label>Email <input name="email" value="${secret}" placeholder="Enter your email"></label>
      </main>
    `);

    const redactor = new SecretRedactor();
    redactor.add(secret);
    const structure = await sanitizedDomStructure(page, redactor);

    expect(structure).toContain("Partner Portal");
    expect(structure).toContain("Developer [REDACTED]");
    expect(structure).toContain("Test Mode [REDACTED]");
    expect(structure).toContain('aria-expanded="false"');
    expect(structure).toContain('placeholder="Enter your email"');
    expect(structure).toContain('type="text"');
    expect(structure).not.toContain(secret);
    expect(structure).not.toContain("Private account narrative");
    expect(structure).not.toContain("private-account");
    expect(structure).not.toContain("private-token");
    expect(structure).not.toContain('value="');
    expect(structure).not.toContain('href="');
    expect(structure).not.toContain('name="');
  });
});
