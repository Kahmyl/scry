import { afterEach, describe, expect, it } from "vitest";
import { readPraxisPublicValueResultSchema } from "@scry/contracts";
import { chromium, type Browser } from "playwright";

import { observePublicValueCandidates, readPraxisPublicValue } from "../src/public-value.js";

let browser: Browser | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

async function pageWith(content: string) {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(content);
  return page;
}

describe("Praxis bounded public value reads", () => {
  it("reads the exact ordinary code value selected by its opaque reference", async () => {
    const page = await pageWith(`
      <main>
        <section>
          <h2>Create reservation</h2>
          <code>/api/v1/partner/reservations</code>
        </section>
        <section>
          <h2>Retrieve reservation</h2>
          <code>/api/v1/partner/reservations/{reservationId}</code>
        </section>
      </main>
    `);

    const observation = await observePublicValueCandidates(page);

    expect(observation.values).toHaveLength(2);
    expect(observation.values.map((value) => value.reference)).not.toEqual([
      observation.values[1]?.reference,
      observation.values[0]?.reference,
    ]);
    expect(JSON.stringify(observation)).not.toContain(
      "/api/v1/partner/reservations/{reservationId}",
    );

    const retrieve = observation.values.find((value) => value.context === "Retrieve reservation");

    expect(retrieve).toMatchObject({
      classification: "public",
      kind: "code",
    });

    const read = await readPraxisPublicValue(page, {
      reference: retrieve!.reference,
    });

    const contractResult = readPraxisPublicValueResultSchema.parse(read);

    expect(contractResult.provenance.referenceVersion).toBe(1);
    expect(read).toMatchObject({
      classification: "public",
      text: "/api/v1/partner/reservations/{reservationId}",
      element: {
        kind: "code",
        context: "Retrieve reservation",
      },
      truncated: false,
    });

    expect(read.provenance.documentIdentity).toBeTruthy();
    expect(read.provenance.documentEpoch).toBeGreaterThanOrEqual(0);
  });

  it("refuses a protected sibling without returning its plaintext", async () => {
    const secret = "sk_live_never_return_this_value_123456";

    const page = await pageWith(`
      <main>
        <code>/api/v1/public</code>
        <code data-scry-redacted="true">${secret}</code>
      </main>
    `);

    const observation = await observePublicValueCandidates(page);

    const protectedValue = observation.values.find((value) => value.classification === "protected");

    expect(protectedValue).toBeTruthy();
    expect(JSON.stringify(observation)).not.toContain(secret);

    await expect(
      readPraxisPublicValue(page, {
        reference: protectedValue!.reference,
      }),
    ).rejects.toMatchObject({
      code: "PUBLIC_VALUE_CLASSIFICATION_REFUSED",
    });
  });

  it("refuses an original reference after the observed entity is replaced", async () => {
    const page = await pageWith(`
      <main>
        <code>/api/v1/original</code>
      </main>
    `);

    const observation = await observePublicValueCandidates(page);
    const reference = observation.values[0]!.reference;

    await page.locator("code").evaluate((element) => {
      const replacement = document.createElement("code");
      replacement.textContent = "/api/v1/replacement";
      element.replaceWith(replacement);
    });

    await expect(readPraxisPublicValue(page, { reference })).rejects.toMatchObject({
      code: "PUBLIC_VALUE_REFERENCE_STALE",
    });
  });

  it("bounds and paginates a long admitted public value", async () => {
    const value = `public documentation ${"segment ".repeat(1000)}`;
    const page = await pageWith(`<pre>${value}</pre>`);

    const observation = await observePublicValueCandidates(page);
    const reference = observation.values[0]!.reference;

    const first = await readPraxisPublicValue(page, {
      reference,
      maxBytes: 256,
    });

    expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(256);
    expect(first.truncated).toBe(true);

    const nextOffset = first.nextOffset;
    expect(nextOffset).toBeGreaterThan(0);

    if (nextOffset === undefined) {
      throw new Error("expected bounded public value continuation offset");
    }

    const second = await readPraxisPublicValue(page, {
      reference,
      offset: nextOffset,
      maxBytes: 256,
    });

    expect(second.offset).toBe(nextOffset);
    expect(Buffer.byteLength(second.text, "utf8")).toBeLessThanOrEqual(256);
  });
});
