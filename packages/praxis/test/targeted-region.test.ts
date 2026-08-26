import { inspectPraxisRegionResultSchema, type InspectPraxisRegionResult } from "@scry/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import {
  inspectPraxisRegion,
  observeSemanticPageContext,
  PraxisRegionInspectionError,
} from "../src/page-context.js";
import { MAX_REGION_PUBLIC_VALUE_REFERENCES, readPraxisPublicValue } from "../src/public-value.js";
import { createAuthoringBrowserSession } from "../src/lifecycle/authoring-browser-session.js";

let browsers: Browser[] = [];

afterEach(async () => {
  await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
  browsers = [];
});

async function pageWith(content: string) {
  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setContent(content);
  return page;
}

function exactControl(
  observation: Awaited<ReturnType<typeof observeSemanticPageContext>>,
  name: string,
) {
  const control = observation.controls.find((candidate) => candidate.name === name);
  if (!control) throw new Error(`missing control: ${name}`);
  return control.reference;
}

async function releasedValues(page: import("playwright").Page, result: InspectPraxisRegionResult) {
  return Promise.all(
    result.readableValues
      .filter((value) => value.classification === "public")
      .map((value) => readPraxisPublicValue(page, { reference: value.reference })),
  );
}

describe("targeted Praxis semantic-region perception", () => {
  it("addresses exact public values beyond the bounded global document candidates", async () => {
    const globalValues = Array.from(
      { length: 120 },
      (_, index) => `<pre>unrelated-global-value-${index}</pre>`,
    ).join("");
    const endpoint = "POST /api/v1/partner-api/orders";
    const page = await pageWith(`
      <main>
        <section aria-label="Global reference material">${globalValues}</section>
        <section aria-label="Create Order">
          <h2>Create Order</h2>
          <button type="button">Create Order</button>
          <code aria-label="${endpoint}">${endpoint}</code>
          <code>Idempotency-Key</code>
          <code>x-vitract-client-id</code>
          <code>x-vitract-client-secret</code>
          <pre>client clientId practitioner practitionerId</pre>
        </section>
      </main>
    `);

    const observation = await observeSemanticPageContext(page);
    expect(observation.readableValueCompleteness).toEqual({
      kind: "bounded",
      observed: 125,
      returned: 24,
      truncated: true,
    });
    expect(observation.readableValues.every((value) => value.context !== "Create Order")).toBe(
      true,
    );
    const retainedGlobalReference = observation.readableValues[0]!.reference;

    const reference = exactControl(observation, "Create Order");
    const inspection = inspectPraxisRegionResultSchema.parse(
      await inspectPraxisRegion(page, reference),
    );

    expect(inspection.contextControlReference).toBe(reference);
    expect(inspection.region).toEqual({ kind: "section" });
    expect(inspection.authority).toMatchObject({
      referenceVersion: 1,
      pageId: observation.authority.pageId,
      documentEpoch: observation.authority.documentEpoch,
    });
    expect(inspection.readableValueCompleteness).toEqual({
      kind: "bounded",
      observed: 5,
      returned: 5,
      truncated: false,
    });
    expect(JSON.stringify(inspection)).not.toContain(endpoint);
    await expect(
      readPraxisPublicValue(page, { reference: retainedGlobalReference }),
    ).resolves.toMatchObject({ text: "unrelated-global-value-0" });

    const texts = (await releasedValues(page, inspection)).map((value) => value.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        endpoint,
        "Idempotency-Key",
        "x-vitract-client-id",
        "x-vitract-client-secret",
        "client clientId practitioner practitionerId",
      ]),
    );
  });

  it("refuses unknown, removed, replaced, and prior-document control authority", async () => {
    const page = await pageWith(`
      <main><section><button id="target">Create Order</button><code>POST /orders</code></section></main>
    `);
    const observation = await observeSemanticPageContext(page);
    const reference = exactControl(observation, "Create Order");

    await expect(
      inspectPraxisRegion(page, "context-control-00000000000000000000000000000000"),
    ).rejects.toMatchObject({ code: "REGION_CONTEXT_CONTROL_REFERENCE_UNKNOWN" });

    await page.locator("#target").evaluate((element) => element.remove());
    await expect(inspectPraxisRegion(page, reference)).rejects.toMatchObject({
      code: "REGION_CONTEXT_CONTROL_REFERENCE_STALE",
    });

    await page.setContent(`
      <main><section><button id="target">Create Order</button><code>POST /orders</code></section></main>
    `);
    const replacementObservation = await observeSemanticPageContext(page);
    const replacementReference = exactControl(replacementObservation, "Create Order");
    await page.locator("#target").evaluate((element) => {
      const replacement = document.createElement("button");
      replacement.id = "replacement";
      replacement.textContent = "Create Order";
      element.replaceWith(replacement);
    });
    await expect(inspectPraxisRegion(page, replacementReference)).rejects.toMatchObject({
      code: "REGION_CONTEXT_CONTROL_REFERENCE_AMBIGUOUS",
    });

    await page.goto(
      "data:text/html,<main><section><button>Create%20Order</button><code>POST%20/orders</code></section></main>",
    );
    await expect(inspectPraxisRegion(page, replacementReference)).rejects.toMatchObject({
      code: "REGION_CONTEXT_CONTROL_REFERENCE_AMBIGUOUS",
    });
  });

  it("allows an exact region-like control to serve as its own authority", async () => {
    const page = await pageWith(`
      <main><div role="region" aria-label="Orders reference"><code>GET /orders/{id}</code></div></main>
    `);
    const observation = await observeSemanticPageContext(page);
    const inspection = await inspectPraxisRegion(
      page,
      exactControl(observation, "Orders reference"),
    );

    expect(inspection.region).toEqual({ kind: "region" });
    expect(inspection.readableValues).toHaveLength(1);
    await expect(
      readPraxisPublicValue(page, { reference: inspection.readableValues[0]!.reference }),
    ).resolves.toMatchObject({ text: "GET /orders/{id}" });
  });

  it("excludes redacted, protected, hidden, inert, and aria-hidden descendants", async () => {
    const protectedText = "sk_live_never_surface_region_value_123456";
    const page = await pageWith(`
      <main>
        <section aria-label="Safe region">
          <button>Inspect safe region</button>
          <code>POST /public/orders</code>
          <code data-scry-redacted="true">${protectedText}</code>
          <input type="password" data-scry-public-value value="password-never-read" />
          <pre hidden>hidden-never-read</pre>
          <div inert><code>inert-never-read</code></div>
          <div aria-hidden="true"><output>aria-hidden-never-read</output></div>
        </section>
        <section data-scry-redacted="true">
          <button>Protected region control</button>
          <code>${protectedText}</code>
        </section>
        <form aria-label="Protected form">
          <input type="password" />
          <button type="button">Protected form control</button>
          <code>GET /must-not-inspect-from-protected-form</code>
        </form>
      </main>
    `);
    const observation = await observeSemanticPageContext(page);
    const inspection = await inspectPraxisRegion(
      page,
      exactControl(observation, "Inspect safe region"),
    );

    expect(inspection.readableValues).toHaveLength(1);
    expect(JSON.stringify(inspection)).not.toContain(protectedText);
    expect(JSON.stringify(inspection)).not.toContain("password-never-read");
    const values = await releasedValues(page, inspection);
    expect(values.map((value) => value.text)).toEqual(["POST /public/orders"]);

    const protectedRegionControl = observation.controls.find(
      (control) => control.role === "button" && control.name === "identity suppressed",
    );
    expect(protectedRegionControl).toBeTruthy();
    const refusal = inspectPraxisRegion(page, protectedRegionControl!.reference);
    await expect(refusal).rejects.toBeInstanceOf(PraxisRegionInspectionError);
    await expect(
      inspectPraxisRegion(page, protectedRegionControl!.reference),
    ).rejects.toMatchObject({ code: "REGION_PROTECTED_BOUNDARY_REFUSED" });
    await expect(
      inspectPraxisRegion(page, exactControl(observation, "Protected form control")),
    ).rejects.toMatchObject({ code: "REGION_PROTECTED_BOUNDARY_REFUSED" });
  });

  it("bounds local candidates and leaves long exact text to paginated public-value reads", async () => {
    const longValue = `public-body ${"field ".repeat(1_000)}`;
    const values = Array.from({ length: 150 }, (_, index) => `<code>field-${index}</code>`).join(
      "",
    );
    const page = await pageWith(`
      <main><section><button>Inspect bounded region</button>${values}<pre>${longValue}</pre></section></main>
    `);
    const observation = await observeSemanticPageContext(page);
    const inspection = await inspectPraxisRegion(
      page,
      exactControl(observation, "Inspect bounded region"),
    );

    expect(inspection.readableValueCompleteness).toEqual({
      kind: "bounded",
      observed: 151,
      returned: MAX_REGION_PUBLIC_VALUE_REFERENCES,
      truncated: true,
    });
    expect(inspection.readableValues).toHaveLength(MAX_REGION_PUBLIC_VALUE_REFERENCES);

    await page.setContent(`
      <main><section><button>Inspect long value</button><pre>${longValue}</pre></section></main>
    `);
    const longObservation = await observeSemanticPageContext(page);
    const longInspection = await inspectPraxisRegion(
      page,
      exactControl(longObservation, "Inspect long value"),
    );
    expect(JSON.stringify(longInspection)).not.toContain(longValue);
    const first = await readPraxisPublicValue(page, {
      reference: longInspection.readableValues[0]!.reference,
      maxBytes: 256,
    });
    expect(first.returnedBytes).toBeLessThanOrEqual(256);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBeGreaterThan(0);
  });

  it("uses the owned browser session while active or suspended and refuses lost authority", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = await createAuthoringBrowserSession({
      sessionId: "11111111-1111-4111-8111-111111111111",
      environmentId: "22222222-2222-4222-8222-222222222222",
      veilAdmissionKey: "targeted-region-test-veil-admission-key",
      browserChannel: "chromium",
      policy: {
        allowedOrigins: ["https://example.test"],
        trustedScriptOrigins: [],
        allowPrivateNetwork: false,
        allowDownloads: false,
        allowPopups: false,
        maxActions: 2,
        maxDurationMs: 30_000,
        maxNavigations: 1,
      },
      openBrowser: async () => ({ browser, context, page }),
      executeInteraction: async () => {
        throw new Error("INTERACTION_NOT_EXPECTED");
      },
    });

    await page.setContent(
      "<main><section><button>Inspect session region</button><code>GET /health</code></section></main>",
    );
    const observation = await session.observeDocument();
    const input = {
      contextControlReference: exactControl(
        observation.semanticPageContext,
        "Inspect session region",
      ),
    };
    await expect(session.inspectRegion(input)).resolves.toMatchObject({
      contextControlReference: input.contextControlReference,
    });

    session.suspend();
    await expect(session.inspectRegion(input)).resolves.toMatchObject({
      contextControlReference: input.contextControlReference,
    });

    await browser.close();
    await expect.poll(() => session.state()).toBe("crashed");
    await expect(session.inspectRegion(input)).rejects.toMatchObject({
      code: "PRAXIS_BROWSER_AUTHORITY_LOST",
    });
    await session.close();
  });
});
