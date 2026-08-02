import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InteractionTargetIntent, PraxisOperation, PraxisRequest } from "@scry/contracts";
import { PraxisAdapter } from "../src/praxis-adapter.js";
import { PraxisMutationLease, selectPraxisStrategy } from "../src/praxis-runtime.js";
import { PraxisDocumentEpoch } from "../src/praxis-observation.js";
import { PraxisTransactionCoordinator } from "../src/praxis-transaction.js";
import { executePraxisConsumer } from "../src/praxis-consumer.js";

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

  it("owns the mutation lane before observation so concurrent transactions re-ground in order", async () => {
    await page.setContent("<section aria-label='A'><button>A</button></section><section aria-label='B'><button>B</button></section><output>0</output><script>for(const b of document.querySelectorAll('button'))b.onclick=()=>document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1)</script>");
    const scoped = (name: string): InteractionTargetIntent => ({ ...intent(name), scope: { kind: "region", name } });
    const context = (ordinal: number) => ({ channel: "action" as const, ordinal, allowedOrigins: ["https://example.test"], timeoutMs: 2_000 });
    const [first, second] = await Promise.all([
      executePraxisConsumer({ page, intent: scoped("A"), operation: { type: "activate" }, context: context(1), signal: new AbortController().signal }),
      executePraxisConsumer({ page, intent: scoped("B"), operation: { type: "activate" }, context: context(2), signal: new AbortController().signal }),
    ]);
    expect([first.status, second.status]).toEqual(["succeeded", "succeeded"]);
    expect(await page.locator("output").textContent()).toBe("2");
  });

  it("grounds, dispatches, and verifies a control in its owning frame document", async () => {
    await page.setContent(`<iframe srcdoc="<button onclick=&quot;parent.document.body.dataset.hit='yes'&quot;>Framed action</button>"></iframe>`);
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(request({ type: "activate" }, intent("Framed action")), new AbortController().signal);
    expect(result.status).toBe("succeeded");
    expect(await page.locator("body").getAttribute("data-hit")).toBe("yes");
    if (result.status === "succeeded") expect(result.resolution.target.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not report activation when frame detachment suppresses the click event", async () => {
    await page.mouse.move(0, 0);
    await page.setContent(`<iframe id="target" style="margin:200px" srcdoc="<button onpointerover=&quot;parent.document.querySelector('#target').remove()&quot; onclick=&quot;parent.document.body.dataset.hit='yes'&quot;>Detach action</button>"></iframe>`);
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(request({ type: "activate" }, intent("Detach action")), new AbortController().signal);
    expect(result).toMatchObject({ status: "inconclusive", code: "PRAXIS_DISPATCH_FAILED", mutationOutcome: "unknown", retry: "unsafe", safeActions: ["do_not_retry"] });
    expect(await page.locator("body").getAttribute("data-hit")).toBeNull();
  });

  it("dispatches once and verifies the exact intended text", async () => {
    await page.setContent("<input aria-label=Name>");
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page, async () => "Ada")).execute(request({ type: "enter_text", input: { reference: "name", classification: "public" } }, intent("Name", "textbox")), new AbortController().signal);
    expect(result.status).toBe("succeeded");
    expect(await page.locator("input").inputValue()).toBe("Ada");
  });

  it("refreshes once when an SPA replaces the control immediately beside dispatch", async () => {
    await page.setContent(`<button onclick="document.body.dataset.count=String(Number(document.body.dataset.count||0)+1)">Continue</button>`);
    class DispatchAdjacentReplacementAdapter extends PraxisAdapter { private replaced=false;override async dispatch(...args:Parameters<PraxisAdapter["dispatch"]>){if(!this.replaced){this.replaced=true;await page.locator("button").evaluate((old)=>old.replaceWith(old.cloneNode(true)));}return super.dispatch(...args);}}
    const result = await new PraxisTransactionCoordinator(new DispatchAdjacentReplacementAdapter(page)).execute(request({ type: "activate" }, intent("Continue")), new AbortController().signal);
    expect(result).toMatchObject({ status: "succeeded", mutationOutcome: "applied" });
    if (result.status === "succeeded") expect(result.timing.providerTimings).toHaveLength(2);
    expect(await page.locator("body").getAttribute("data-count")).toBe("1");
  });

  it("refuses repeated target instability without crossing the mutation boundary", async () => {
    await page.setContent(`<button onclick="document.body.dataset.count=String(Number(document.body.dataset.count||0)+1)">Continue</button><script>globalThis.replacer=setInterval(()=>{const old=document.querySelector('button');old?.replaceWith(old.cloneNode(true))},2)</script>`);
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(request({ type: "activate" }, intent("Continue")), new AbortController().signal);
    await page.evaluate(() => clearInterval((globalThis as typeof globalThis & { replacer:number }).replacer));
    expect(result).toMatchObject({ status: "failed", mutationOutcome: "not_started" });
    if (result.status !== "succeeded") { expect(["PRAXIS_TARGET_CHANGED_BEFORE_ACTION","PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL"]).toContain(result.code);expect(result.diagnostics.mutationBoundaryCrossed).toBe(false); }
    expect(await page.locator("body").getAttribute("data-count")).toBeNull();
  });

  it("does not focus or activate a reactive control before the mutation boundary", async () => {
    await page.setContent(`<button onfocus="document.body.dataset.focusPhase=document.body.dataset.phase" onclick="document.body.dataset.clickPhase=document.body.dataset.phase">Continue</button>`);
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page), async (event) => { await page.locator("body").evaluate((body, phase) => { body.dataset.phase=phase; }, event.phase); }).execute(request({ type: "activate" }, intent("Continue")), new AbortController().signal);
    expect(result.status).toBe("succeeded");
    expect(await page.locator("body").getAttribute("data-focus-phase")).toBe("dispatching");
    expect(await page.locator("body").getAttribute("data-click-phase")).toBe("dispatching");
  });

  it("re-observes once before dispatch when a render invalidates the grounded handle", async () => {
    await page.setContent("<button onclick='this.dataset.count=String(Number(this.dataset.count||0)+1)'>Save</button>");
    const adapter = new PraxisAdapter(page);
    const original = adapter.revalidate.bind(adapter);
    let invalidated = false;
    adapter.revalidate = async (target, request, signal) => { if (!invalidated) { invalidated = true; await page.locator("body").evaluate((body) => body.append(document.createElement("span"))); PraxisDocumentEpoch.bump(page); } return original(target, request, signal); };
    const result = await new PraxisTransactionCoordinator(adapter).execute(request({ type: "activate" }), new AbortController().signal);
    expect(result).toMatchObject({ status: "succeeded", mutationOutcome: "applied" });
    expect(await page.locator("button").getAttribute("data-count")).toBe("1");
  });

  it("derives an idempotent transaction identity for a consumer operation", async () => {
    await page.setContent("<output aria-label=Status>Ready</output>");
    const target = { ...intent("Status"), requiredCapabilities: ["readable_value" as const], preferredEvidence: { ...intent("Status").preferredEvidence, roles: ["value" as const] } };
    const ids: string[] = [];
    const context = { runId: "run-1", attemptId: "attempt-1", stepId: "step-1", channel: "probe" as const, ordinal: 0, allowedOrigins: ["https://example.test"], timeoutMs: 1_000, emit: (event: { type: string; transactionId: string }) => { if (event.type === "praxis.transaction_started") ids.push(event.transactionId); } };
    expect((await executePraxisConsumer({ page, intent: target, operation: { type: "inspect" }, context, signal: new AbortController().signal })).status).toBe("succeeded");
    expect((await executePraxisConsumer({ page, intent: target, operation: { type: "inspect" }, context, signal: new AbortController().signal })).status).toBe("succeeded");
    expect(new Set(ids).size).toBe(1);
  });
});
