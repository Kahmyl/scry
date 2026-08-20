import { semanticScopeKinds, type InteractionTargetIntent } from "@scry/contracts";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { inspectSemanticScope, resolveTarget } from "../src/grounding.js";

describe("protected scope mechanical conformance", () => {
  it("resolves every canonical semantic scope through Praxis", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      for (const kind of semanticScopeKinds) {
        await page.setContent(fixture(kind));
        const intent: InteractionTargetIntent = {
          concept: `${kind} protected action`,
          requiredCapabilities: ["focusable", "pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Generate"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            testIds: [],
          },
          scope: { kind, ...(kind === "page" ? {} : { name: "Protected area" }) },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "protected",
          confidence: { requiredFamilies: [] },
          matching: "exact",
        };
        await expect(resolveTarget(page, intent), kind).resolves.toMatchObject({
          adapter: "native_click",
        });
      }
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("does not reinterpret generic nested div text as a semantic group", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div>Credentials<div>Credentials<button>Add credential</button></div></div>
        <main aria-label="Credentials"><button aria-label="Add credential">Add credential</button></main>
      `);
      await expect(
        inspectSemanticScope(page, { kind: "group", name: "Credentials" }),
      ).resolves.toEqual({ matchCount: 0 });
      await expect(
        resolveTarget(page, {
          concept: "Add credential",
          requiredCapabilities: ["focusable", "pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Add credential"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            testIds: [],
          },
          scope: { kind: "region", name: "Credentials" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "protected",
          confidence: { requiredFamilies: [] },
          matching: "exact",
        }),
      ).resolves.toMatchObject({ adapter: "native_click" });
    } finally {
      await browser.close();
    }
  });

  it("does not let an ancestor landmark inherit a nested landmark heading", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <section>
          <section>
            <h2>Credentials</h2>
            <button>Add credential</button>
            <form><button>Add credential</button></form>
          </section>
        </section>
      `);
      await expect(
        inspectSemanticScope(page, { kind: "section", name: "Credentials" }),
      ).resolves.toEqual({ matchCount: 1 });
      await expect(
        resolveTarget(page, {
          concept: "Add credential",
          requiredCapabilities: ["focusable", "pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Add credential"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            testIds: [],
          },
          scope: { kind: "section", name: "Credentials", direct: true },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "protected",
          confidence: { requiredFamilies: [] },
          matching: "exact",
        }),
      ).resolves.toMatchObject({ adapter: "native_click" });
    } finally {
      await browser.close();
    }
  });
});

function fixture(kind: (typeof semanticScopeKinds)[number]) {
  const button = '<button aria-label="Generate">Generate</button>';
  switch (kind) {
    case "page":
      return button;
    case "dialog":
      return `<dialog open aria-label="Protected area">${button}</dialog>`;
    case "form":
      return `<form aria-label="Protected area">${button}</form>`;
    case "section":
      return `<section aria-label="Protected area">${button}</section>`;
    case "field_group":
      return `<fieldset aria-label="Protected area">${button}</fieldset>`;
    case "group":
      return `<div role="group" aria-label="Protected area">${button}</div>`;
    case "table":
      return `<table aria-label="Protected area"><tbody><tr><td>${button}</td></tr></tbody></table>`;
    case "row":
      return `<table><tbody><tr aria-label="Protected area"><td>${button}</td></tr></tbody></table>`;
    case "region":
      return `<aside aria-label="Protected area">${button}</aside>`;
    case "live_region":
      return `<div role="status" aria-label="Protected area">${button}</div>`;
    case "recently_changed":
      return `<div data-scry-recently-changed aria-label="Protected area">${button}</div>`;
  }
}
