import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clickReferencedTarget,
  fillReferencedTarget,
  observeTargetReference,
  PraxisStaleTargetError,
} from "@scry/praxis";

import {
  referenceReplacementFixture,
  referenceReplacementFillFixture,
  verifyStaleReferenceDidNotDispatch,
  verifyFillReferenceDidNotDispatch,
  withFixture,
} from "../src/index.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
});

afterAll(async () => {
  await browser?.close();
});

describe("Praxis pinned reference against the reference-replacement fixture", () => {
  it(
    "real browser: Praxis observes the original, refuses dispatch after replacement, and the oracle passes",
    { timeout: 30_000 },
    async () => {
      await withFixture(referenceReplacementFixture, undefined, async (session) => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(session.value.scenarioUrl);

          // Praxis pins the entity that was actually observed.
          const reference = await observeTargetReference(page, page.locator("#target"));

          // The fixture replaces the target on pointerover, mid-interaction.
          // Praxis must refuse rather than dispatch against either entity.
          let refusal: unknown;
          try {
            await clickReferencedTarget(reference, { timeoutMs: 2_000 });
          } catch (error) {
            refusal = error;
          }
          expect(refusal).toBeInstanceOf(PraxisStaleTargetError);

          await expect
            .poll(async () => (await session.readGroundTruth()).mutationCount, { timeout: 5_000 })
            .toBeGreaterThanOrEqual(1);

          const truth = await session.readGroundTruth();
          const observation = verifyStaleReferenceDidNotDispatch(truth);

          expect(truth.originalDispatches).toBe(0);
          expect(truth.replacementDispatches).toBe(0);
          expect(observation.status).toBe("pass");
        } finally {
          await context.close();
        }
      });
    },
  );

  it(
    "negative control: semantic re-resolution clicks the replacement and the same oracle fails",
    { timeout: 30_000 },
    async () => {
      await withFixture(referenceReplacementFixture, undefined, async (session) => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(session.value.scenarioUrl);

          // The original is observed exactly as in the safe path.
          const reference = await observeTargetReference(page, page.locator("#target"));
          expect(reference.pageId).toBeTruthy();

          // Deliberately unsafe comparator: re-resolve by accessible name
          // after pointer interaction replaces the observed entity, then
          // click whatever currently matches.
          const semantic = page.getByRole("button", { name: "Submit order" });
          await semantic.hover();
          await semantic.click({ timeout: 5_000 });

          await expect
            .poll(async () => (await session.readGroundTruth()).mutationCount, { timeout: 5_000 })
            .toBeGreaterThanOrEqual(1);
          await expect
            .poll(async () => (await session.readGroundTruth()).replacementDispatches, {
              timeout: 5_000,
            })
            .toBeGreaterThanOrEqual(1);

          const truth = await session.readGroundTruth();
          const observation = verifyStaleReferenceDidNotDispatch(truth);

          expect(observation.status).toBe("fail");
          expect(observation.reasonCode).toBe("STALE_REFERENCE_DISPATCH_OBSERVED");
        } finally {
          await context.close();
        }
      });
    },
  );

  it(
    "safe Praxis pinned fill path refuses stale fill after replacement and does not fill semantic replacement",
    { timeout: 30_000 },
    async () => {
      await withFixture(referenceReplacementFillFixture, undefined, async (session) => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(session.value.scenarioUrl);

          const reference = await observeTargetReference(page, page.getByPlaceholder("Email"));

          await page.evaluate(() => {
            (window as unknown as { __replaceInputTarget?: () => void }).__replaceInputTarget?.();
          });

          let refusal: unknown;
          try {
            await fillReferencedTarget(reference, "replacement-value", { timeoutMs: 1_500 });
          } catch (error) {
            refusal = error;
          }
          expect(refusal).toBeInstanceOf(PraxisStaleTargetError);

          await expect
            .poll(async () => (await session.readGroundTruth()).mutationCount, { timeout: 5_000 })
            .toBeGreaterThanOrEqual(1);

          const truth = await session.readGroundTruth();
          const observation = verifyFillReferenceDidNotDispatch(truth);
          expect(truth.originalDispatches).toBe(0);
          expect(truth.replacementDispatches).toBe(0);
          expect(observation.status).toBe("pass");
        } finally {
          await context.close();
        }
      });
    },
  );

  it(
    "negative control: semantic re-fill fills the replacement and the oracle fails",
    { timeout: 30_000 },
    async () => {
      await withFixture(referenceReplacementFillFixture, undefined, async (session) => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(session.value.scenarioUrl);

          await page.evaluate(() => {
            (window as unknown as { __replaceInputTarget?: () => void }).__replaceInputTarget?.();
          });
          await page.getByPlaceholder("Email").fill("replacement-value");

          await expect
            .poll(async () => (await session.readGroundTruth()).mutationCount, { timeout: 5_000 })
            .toBeGreaterThanOrEqual(1);

          const truth = await session.readGroundTruth();
          await expect
            .poll(async () => (await session.readGroundTruth()).replacementDispatches, {
              timeout: 5_000,
            })
            .toBeGreaterThanOrEqual(1);

          const finalTruth = await session.readGroundTruth();
          const observation = verifyFillReferenceDidNotDispatch(finalTruth);
          expect(observation.status).toBe("fail");
          expect(observation.reasonCode).toBe("STALE_REFERENCE_DISPATCH_OBSERVED");
        } finally {
          await context.close();
        }
      });
    },
  );
});
