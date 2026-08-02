import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InteractionTargetIntent, PraxisOperation, PraxisRequest } from "@scry/contracts";
import { LegacyPraxisAdapter } from "../src/praxis-legacy-adapter.js";
import { PraxisMutationLease, selectPraxisStrategy } from "../src/praxis-runtime.js";
import { PraxisDocumentEpoch } from "../src/praxis-observation.js";
import { PraxisTransactionCoordinator } from "../src/praxis-transaction.js";

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" }); page = await browser.newPage(); });
afterAll(async () => { await browser?.close(); });
const intent = (name: string, role: "button"|"textbox" = "button"): InteractionTargetIntent => ({ concept: name, requiredCapabilities: role === "textbox" ? ["focusable","accepts_text","editable"] : ["pointer_activatable"], preferredEvidence: { roles: [role], names: [name], labels: [], descriptions: [], placeholders: [], inputTypes: [] }, scope: { kind: "page" }, relations: [], prohibited: ["hidden","disabled"], risk: "ordinary", confidence: { requiredFamilies: [], minimum: .35, minimumMargin: 0, minimumFamilyCount: 1 } });
const request = (operation: PraxisOperation, target = intent("Save")): PraxisRequest => ({ schemaVersion: 1, transactionId: `tx-${Math.random()}`, operationId: operation.type, intent: target, operation, expectedEffect: { type: "none" }, risk: target.risk, policy: { allowedOrigins: ["https://example.test"], actionTimeoutMs: 1_000, totalTimeoutMs: 2_000 }, privacy: { state: "normal", allowedChannels: ["public_dom","accessibility"], suppressedChannels: [] }, context: { pageId: "page", origin: "https://example.test", documentEpoch: 0 } });

describe("Praxis strategy, dispatch, and verification", () => {
  it("selects typed least-invasive strategies", () => {
    expect(selectPraxisStrategy({ type: "activate" }, "native_click")).toBe("native_activate");
    expect(selectPraxisStrategy({ type: "enter_text", input: { reference: "x", classification: "public" } }, "content_editable")).toBe("content_editable");
    expect(selectPraxisStrategy({ type: "inspect" }, "native_click")).toBe("inspect");
  });

  it("serializes page mutation leases", async () => {
    const first = await PraxisMutationLease.acquire(page, new AbortController().signal);
    let secondAcquired = false;
    const waiting = PraxisMutationLease.acquire(page, new AbortController().signal).then((release) => { secondAcquired = true; release(); });
    await Promise.resolve(); expect(secondAcquired).toBe(false);
    first(); await waiting; expect(secondAcquired).toBe(true);
  });

  it("dispatches once and verifies the exact intended text", async () => {
    await page.setContent("<input aria-label=Name>");
    const result = await new PraxisTransactionCoordinator(new LegacyPraxisAdapter(page, async () => "Ada")).execute(request({ type: "enter_text", input: { reference: "name", classification: "public" } }, intent("Name", "textbox")), new AbortController().signal);
    expect(result.status).toBe("succeeded");
    expect(await page.locator("input").inputValue()).toBe("Ada");
  });

  it("does not dispatch through a handle invalidated before revalidation", async () => {
    await page.setContent("<button onclick='this.dataset.count=String(Number(this.dataset.count||0)+1)'>Save</button>");
    const adapter = new LegacyPraxisAdapter(page);
    const original = adapter.revalidate.bind(adapter);
    adapter.revalidate = async (target) => { await page.locator("body").evaluate((body) => body.append(document.createElement("span"))); PraxisDocumentEpoch.bump(page); await original(target); };
    const result = await new PraxisTransactionCoordinator(adapter).execute(request({ type: "activate" }), new AbortController().signal);
    expect(result).toMatchObject({ status: "failed", code: "PRAXIS_TARGET_CHANGED_BEFORE_ACTION", mutationOutcome: "not_applied", retry: "requires_reobservation" });
    expect(await page.locator("button").getAttribute("data-count")).toBeNull();
  });
});
