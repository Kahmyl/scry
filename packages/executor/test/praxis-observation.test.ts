import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CandidateEvidence } from "@scry/contracts";
import {
  PraxisDocumentEpoch, PraxisGroundingPolicyV1, PraxisObservationCache, PraxisTargetHandle,
  observationIdentity, runEvidenceProviders, type PraxisEvidenceProvider,
} from "../src/praxis-observation.js";

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" }); page = await browser.newPage(); });
afterAll(async () => { await browser?.close(); });

const evidence: CandidateEvidence[] = [
  { family: "textual", signal: "name", score: .9, correlationGroup: "identity" },
  { family: "accessibility", signal: "name", score: .8, correlationGroup: "accessible" },
  { family: "textual", signal: "duplicate", score: .4, correlationGroup: "identity" },
];

describe("Praxis observation and grounding foundation", () => {
  it("scores deterministically regardless of provider completion order", () => {
    expect(PraxisGroundingPolicyV1.score(evidence)).toEqual(PraxisGroundingPolicyV1.score([...evidence].reverse()));
  });

  it("does not run a provider whose privacy channel is forbidden", async () => {
    let observed = false;
    const provider: PraxisEvidenceProvider<object> = { id: "ocr", version: 1, families: ["visual"], cost: "high", privacy: "ocr", concurrent: true, maximumWork: 1, async observe() { observed = true; return evidence; }, sanitize: (value) => value };
    const [result] = await runEvidenceProviders([provider], {}, ["public_dom"], new AbortController().signal);
    expect(result?.timing.outcome).toBe("forbidden");
    expect(observed).toBe(false);
  });

  it("serializes only opaque handle identity and rejects a stale handle", async () => {
    await page.setContent("<button>Save</button>");
    const epoch = await PraxisDocumentEpoch.current(page);
    const handle = new PraxisTargetHandle(page, page.locator("button"), epoch);
    expect(JSON.stringify(handle)).not.toContain("locator");
    expect(JSON.stringify(handle)).not.toContain("button");
    await page.locator("body").evaluate((body) => body.append(document.createElement("span")));
    await page.waitForTimeout(0);
    await expect(handle.use((locator) => locator.click())).rejects.toThrow("PRAXIS_TARGET_CHANGED_BEFORE_ACTION");
  });

  it("invalidates cached observations when the document epoch changes", async () => {
    await page.setContent("<main></main>");
    const epoch = await PraxisDocumentEpoch.current(page);
    const key = PraxisObservationCache.key({ scope: { kind: "page" }, privacyState: "normal", providers: ["native"], epoch });
    const snapshot = { ...observationIdentity(page, { kind: "page" }, "normal", epoch), controls: [], providerTimings: [] } as const;
    PraxisObservationCache.set(page, key, snapshot);
    expect(PraxisObservationCache.get(page, key, epoch)).toEqual(snapshot);
    PraxisDocumentEpoch.bump(page);
    expect(PraxisObservationCache.get(page, key, epoch)).toBeUndefined();
  });
});
