import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InteractionTargetIntent } from "@scry/contracts";
import { resolveTarget } from "../src/grounding.js";
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

  it("preserves distinct actionable identity for multiple protected controls without values", async () => {
    await page.setContent(`
      <form aria-label="Change password">
        <label>Current password <input type="password" autocomplete="current-password" value="old-secret" /></label>
        <label>New password <input type="password" autocomplete="new-password" value="new-secret" /></label>
        <label>Confirm password <input type="password" autocomplete="new-password" value="new-secret" /></label>
      </form>
    `);

    const context = await observeSemanticPageContext(page);
    const protectedControls = context.controls.filter((control) => control.role === "textbox");
    const serialized = JSON.stringify(context);

    expect(protectedControls).toHaveLength(3);
    expect(new Set(protectedControls.map((control) => control.reference)).size).toBe(3);
    expect(serialized).not.toContain("old-secret");
    expect(serialized).not.toContain("new-secret");
  });

  it.each([
    ["email and password", '<label>Email <input type="email"></label><label>Password <input type="password"></label>', ["Password"]],
    ["ordinary textboxes and password", '<input aria-label="First"><input aria-label="Second"><label>Password <input type="password"></label>', ["Password"]],
    ["repeated labels in separate forms", '<form aria-label="Primary"><label>Secret <input type="password"></label></form><form aria-label="Secondary"><label>Secret <input type="password"></label></form>', ["Secret", "Secret"]],
    ["purpose without a label", '<input type="password" autocomplete="current-password">', ["identity suppressed"]],
    ["OTP and PIN", '<label>Code <input data-scry-redacted="true" autocomplete="one-time-code"></label><label>PIN <input data-scry-redacted="true" inputmode="numeric"></label>', ["identity suppressed", "identity suppressed"]],
  ])("keeps privacy-safe protected identity for %s", async (_name, markup, expectedNames) => {
    await page.setContent(`<main>${markup}</main>`);
    const context = await observeSemanticPageContext(page);
    const protectedControls = context.controls.filter((control) => control.valueProtected);
    expect(protectedControls.map((control) => control.name)).toEqual(expectedNames);
    expect(new Set(protectedControls.map((control) => control.reference)).size).toBe(expectedNames.length);
  });

  it("excludes a hidden protected decoy and fails stale and cross-page references closed", async () => {
    await page.setContent(`
      <input type="password" aria-label="Decoy" style="display:none">
      <label>Visible password <input type="password"></label>
    `);
    const context = await observeSemanticPageContext(page);
    const protectedControls = context.controls.filter((control) => control.valueProtected);
    expect(protectedControls).toHaveLength(1);
    expect(protectedControls[0]!.name).toBe("Visible password");
    const intent = referenceIntent(protectedControls[0]!.reference);
    expect((await resolveTarget(page, intent)).locator).toBeDefined();

    const otherPage = await browser.newPage();
    await otherPage.setContent('<label>Visible password <input type="password"></label>');
    await expect(withDeadline(resolveTarget(otherPage, intent), "cross-page")).rejects.toThrow(
      "TARGET_CHANGED_BEFORE_ACTION",
    );
    await otherPage.close();

    await page.setContent('<label>Replacement <input type="password"></label>');
    await expect(withDeadline(resolveTarget(page, intent), "stale-page")).rejects.toThrow(
      "TARGET_CHANGED_BEFORE_ACTION",
    );
  }, 15_000);

  it("does not turn a protected text-entry reference into a generic activation capability", async () => {
    await page.setContent('<label>Password <input type="password"></label>');
    const context = await observeSemanticPageContext(page);
    const reference = context.controls.find((control) => control.valueProtected)!.reference;
    const intent = referenceIntent(reference);
    intent.requiredCapabilities = ["pointer_activatable"];
    await expect(resolveTarget(page, intent)).rejects.toThrow("NO_CAPABILITY_COMPATIBLE_CONTROL");
  });

  it("revalidates a referenced sibling across unrelated DOM mutation and rejects target drift", async () => {
    await page.setContent(`
      <label>Email <input aria-label="Email"></label>
      <label>Password <input id="password" type="password" aria-label="Password"></label>
    `);
    const context = await observeSemanticPageContext(page);
    const reference = context.controls.find((control) => control.valueProtected)!.reference;
    const intent = referenceIntent(reference);

    await page.getByLabel("Email").fill("safe@example.test");
    await expect(resolveTarget(page, intent)).resolves.toMatchObject({ adapter: "native_fill" });

    await page.locator("#password").evaluate((element) => { element.setAttribute("disabled", ""); });
    await expect(resolveTarget(page, intent)).rejects.toThrow("TARGET_CHANGED_BEFORE_ACTION");

    await page.setContent('<label>Password <input id="password" type="password" aria-label="Password"></label>');
    await expect(resolveTarget(page, intent)).rejects.toThrow("TARGET_CHANGED_BEFORE_ACTION");
  });

  it("accepts the published activation capability for an ordinary button reference", async () => {
    await page.setContent('<button type="submit">Login</button>');
    const context = await observeSemanticPageContext(page);
    const reference = context.controls.find((control) => control.name === "Login")!.reference;
    const intent = referenceIntent(reference);
    intent.concept = "login submission";
    intent.requiredCapabilities = ["focusable", "pointer_activatable"];
    intent.risk = "authentication";
    await expect(resolveTarget(page, intent)).resolves.toMatchObject({ adapter: "native_click" });
  });
});

function referenceIntent(reference: string): InteractionTargetIntent {
  return {
    concept: "protected input",
    authoritativeReference: reference,
    requiredCapabilities: ["focusable", "accepts_text", "editable"],
    preferredEvidence: {
      roles: [], names: [], labels: [], descriptions: [], placeholders: [], inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "authentication",
    confidence: { requiredFamilies: [] },
    matching: "exact",
  };
}

function withDeadline<T>(promise: Promise<T>, label: string) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`fixture-timeout:${label}`)), 1_000)),
  ]);
}
