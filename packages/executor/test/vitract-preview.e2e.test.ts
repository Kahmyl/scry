import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

const enabled = process.env.SCRY_VITRACT_PREVIEW_E2E === "true";

describe.skipIf(!enabled)("Vitract preview adaptive-authoring acceptance", () => {
  it("authenticates once and reaches partner orders without secret-bearing artifacts", async () => {
    const url = required("SCRY_VITRACT_PREVIEW_URL");
    const username = required("SCRY_VITRACT_PREVIEW_USERNAME");
    const password = required("SCRY_VITRACT_PREVIEW_PASSWORD");
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      let submissions = 0;
      page.on("request", (request) => {
        if (request.method() === "POST" && /login|sign-?in|auth/i.test(request.url())) {
          submissions += 1;
        }
      });
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const email = page.getByRole("textbox", { name: /email|username/i });
      const passwordInput = page.locator('input[type="password"]');
      await email.waitFor({ state: "visible", timeout: 20_000 });
      await passwordInput.waitFor({ state: "visible", timeout: 20_000 });
      await email.fill(username);
      await passwordInput.fill(password);
      await page.getByRole("button", { name: /sign in|log ?in/i }).click();
      const orders = page.getByRole("link", { name: /orders/i });
      await orders.waitFor({ state: "visible", timeout: 20_000 });
      expect(await orders.isVisible()).toBe(true);
      expect(submissions).toBe(1);
      expect(page.url()).not.toMatch(/login|sign-?in/i);
    } finally {
      await browser.close();
    }
  }, 45_000);
});

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when SCRY_VITRACT_PREVIEW_E2E=true`);
  return value;
}
