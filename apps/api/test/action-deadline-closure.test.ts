import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeInteractionCompatibility } from "@scry/executor";
import { registerPraxisVeilAuthority } from "@scry/praxis";
import { compileVeilPolicy, VeilAuthority } from "@scry/veil";
import type { Browser, BrowserContext, Page } from "playwright";

import { NativeBrowserDriver } from "../src/runtime/native-browser-driver/index.js";

const driver = new NativeBrowserDriver();
let browser: Browser;

beforeAll(async () => {
  const opened = await driver.openBrowser();
  browser = opened.browser;
  await opened.context.close();
});
afterAll(async () => browser?.close());

const nativeTarget = {
  concept: "login email",
  requiredCapabilities: ["focusable" as const, "accepts_text" as const, "editable" as const],
  preferredEvidence: { roles: ["textbox" as const], names: [], labels: [], descriptions: [], placeholders: ["Enter your email"], inputTypes: ["text"] },
  scope: { kind: "page" as const }, relations: [], prohibited: ["hidden" as const, "disabled" as const],
  risk: "ordinary" as const, confidence: { requiredFamilies: [] },
};
const praxisTarget = {
  concept: "activate",
  requiredCapabilities: ["focusable" as const, "pointer_activatable" as const],
  preferredEvidence: { roles: ["text" as const], names: ["Activate"], labels: [], descriptions: [], placeholders: [], inputTypes: [] },
  scope: { kind: "page" as const }, relations: [], prohibited: ["hidden" as const, "disabled" as const],
  risk: "ordinary" as const, confidence: { requiredFamilies: [] },
};
const scopedPraxisTarget = {
  ...praxisTarget,
  concept: "List Orders activate",
  scope: { kind: "section" as const, name: "List Orders" },
};

async function closureCase(input: {
  name: string;
  timeoutMs: number;
  fixture: "native" | "praxis" | "ambiguous";
  insertAtMs: number;
}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = input.fixture === "native"
    ? '<input type="text" placeholder="Enter your email">'
    : input.fixture === "ambiguous"
      ? "<button>Activate</button><button>Activate</button>"
      : "<button>Activate</button>";
  await page.setContent("<main></main>");
  if (input.insertAtMs === 0) await page.locator("main").evaluate((root, value) => root.innerHTML = value, html);
  else await page.evaluate(({ delay, value }) => setTimeout(() => {
    document.querySelector("main")!.innerHTML = value;
  }, delay), { delay: input.insertAtMs, value: html });
  const unregister = registerPraxisVeilAuthority(page, {
    authority: new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://example.test"] })),
    userId: "closure-test", environmentId: "local", browserContextId: input.name,
  });
  const praxisResults: string[] = [];
  const dispatches: number[] = [];
  const started = performance.now();
  try {
    const outcome = await executeInteractionCompatibility({
      sessionId: input.name, operationId: "action", ordinal: 1, page,
      action: input.fixture === "native"
        ? { type: "fill", value: "safe-local-value", timeoutMs: input.timeoutMs, target: nativeTarget }
        : { type: "click", timeoutMs: input.timeoutMs, target: praxisTarget, expectedEffect: { type: "none" } },
      policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
        allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 15_000,
        maxNavigations: 1 },
      options: {
        outputDirectory: "/tmp/action-deadline-closure-test",
        onPraxisResult: async (result) => { praxisResults.push(result.status === "succeeded" ? "succeeded" : result.code); },
        onMutationDispatch: async () => { dispatches.push(performance.now() - started); },
      },
    });
    return { outcome, praxisResults, dispatches, elapsedMs: performance.now() - started };
  } finally {
    unregister();
    await context.close();
  }
}

describe("authoritative action deadline closure", () => {
  it("runs the exact six production-path closure scenarios", async () => {
    const native = await closureCase({ name: "native-present", timeoutMs: 3_000, fixture: "native", insertAtMs: 0 });
    expect(native.outcome.functionalResult).toBe("succeeded");
    expect(native.praxisResults.at(-1)).toBe("succeeded");
    expect(native.dispatches).toHaveLength(1);
    expect(native.dispatches[0]).toBeLessThan(3_000);

    const immediate = await closureCase({ name: "praxis-immediate", timeoutMs: 3_000, fixture: "praxis", insertAtMs: 0 });
    expect(immediate.outcome.functionalResult).toBe("succeeded");
    expect(immediate.praxisResults).toEqual(["succeeded"]);
    expect(immediate.dispatches[0]).toBeLessThan(3_000);

    const shortLate = await closureCase({ name: "praxis-short-late", timeoutMs: 3_000, fixture: "praxis", insertAtMs: 2_500 });
    expect(shortLate.praxisResults.filter((result) => result === "PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL").length).toBeGreaterThan(1);
    if (shortLate.outcome.functionalResult === "succeeded") {
      expect(shortLate.dispatches).toHaveLength(1);
      expect(shortLate.dispatches[0]).toBeLessThan(3_000);
    } else expect(shortLate.dispatches).toEqual([]);
    expect(shortLate.elapsedMs).toBeGreaterThan(2_400);

    const longLate = await closureCase({ name: "praxis-long-late", timeoutMs: 10_000, fixture: "praxis", insertAtMs: 7_000 });
    expect(longLate.outcome.functionalResult).toBe("succeeded");
    expect(longLate.praxisResults.filter((result) => result === "PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL").length).toBeGreaterThan(1);
    expect(longLate.praxisResults.at(-1)).toBe("succeeded");
    expect(longLate.dispatches).toHaveLength(1);
    expect(longLate.dispatches[0]).toBeLessThan(10_000);

    const ambiguous = await closureCase({ name: "praxis-ambiguous", timeoutMs: 10_000, fixture: "ambiguous", insertAtMs: 0 });
    expect(ambiguous.outcome.reasonCode).toBe("PRAXIS_TARGET_AMBIGUOUS");
    expect(ambiguous.praxisResults).toEqual(["PRAXIS_TARGET_AMBIGUOUS"]);
    expect(ambiguous.dispatches).toEqual([]);

    const afterDeadline = await closureCase({ name: "praxis-after-deadline", timeoutMs: 3_000, fixture: "praxis", insertAtMs: 3_500 });
    expect(afterDeadline.outcome.functionalResult).toBe("failed");
    expect(afterDeadline.dispatches).toEqual([]);
    expect(afterDeadline.elapsedMs).toBeGreaterThanOrEqual(2_900);
    expect(afterDeadline.elapsedMs).toBeLessThan(3_500);
  }, 35_000);

  it("retries a missing semantic scope but keeps duplicate scopes terminal", async () => {
    const run = async (name: string, html: string, insertAtMs: number) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent("<main></main>");
      if (insertAtMs === 0) await page.locator("main").evaluate((root, value) => root.innerHTML = value, html);
      else await page.evaluate(({ delay, value }) => setTimeout(() => {
        document.querySelector("main")!.innerHTML = value;
      }, delay), { delay: insertAtMs, value: html });
      const unregister = registerPraxisVeilAuthority(page, {
        authority: new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://example.test"] })),
        userId: "closure-test", environmentId: "local", browserContextId: name,
      });
      const praxisResults: string[] = [];
      const dispatches: number[] = [];
      try {
        const outcome = await executeInteractionCompatibility({
          sessionId: name, operationId: "action", ordinal: 1, page,
          action: { type: "click", timeoutMs: 3_000, target: scopedPraxisTarget, expectedEffect: { type: "none" } },
          policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
            allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 15_000,
            maxNavigations: 1 },
          options: {
            outputDirectory: "/tmp/action-deadline-closure-test",
            onPraxisResult: async (result) => {
              praxisResults.push(result.status === "succeeded" ? "succeeded" : result.code);
            },
            onMutationDispatch: async () => { dispatches.push(performance.now()); },
          },
        });
        return { outcome, praxisResults, dispatches };
      } finally {
        unregister();
        await context.close();
      }
    };

    const late = await run("late-scope", "<section><h2>List Orders</h2><button>Activate</button></section>", 900);
    expect(late.outcome.functionalResult).toBe("succeeded");
    expect(late.praxisResults).toContain("PRAXIS_TARGET_SCOPE_NOT_FOUND");
    expect(late.praxisResults.at(-1)).toBe("succeeded");
    expect(late.dispatches).toHaveLength(1);

    const ambiguous = await run("ambiguous-scope", `
      <section><h2>List Orders</h2><button>Activate</button></section>
      <section><h2>List Orders</h2><button>Activate</button></section>
    `, 0);
    expect(ambiguous.outcome.reasonCode).toBe("PRAXIS_TARGET_SCOPE_INVALID");
    expect(ambiguous.praxisResults).toEqual(["PRAXIS_TARGET_SCOPE_INVALID"]);
    expect(ambiguous.dispatches).toEqual([]);
  }, 15_000);
});
