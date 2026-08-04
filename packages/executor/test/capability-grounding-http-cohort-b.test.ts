import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  currentPlanSchema,
  executionPolicySchema,
  type InteractionTargetIntent,
  type ReadinessCondition,
} from "@scry/contracts";

import { executePlan } from "../src/executor.js";
import {
  registerGroundingHistoryProvider,
  resolveTarget,
  resolveTargetLocator,
  verifyExpectedEffect,
} from "@scry/praxis";
import {
  clickPraxisTarget as clickGroundedTarget,
  fillPraxisTarget as fillGroundedTarget,
} from "./support/praxis-actions.js";

let browser: Browser;
let context: BrowserContext;
let origin = "";
let server: ReturnType<typeof createServer>;
const outputDirectories: string[] = [];

const preferred = (
  name: string,
  extra: Partial<InteractionTargetIntent["preferredEvidence"]> = {},
): InteractionTargetIntent["preferredEvidence"] => ({
  roles: [],
  names: [name],
  labels: [name],
  descriptions: [],
  placeholders: [],
  inputTypes: [],
  ...extra,
});
const target = (
  name: string,
  overrides: Partial<InteractionTargetIntent> = {},
): InteractionTargetIntent => ({
  concept: name.toLowerCase().replace(/\W+/g, "_"),
  requiredCapabilities: ["pointer_activatable"],
  preferredEvidence: preferred(name),
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "ordinary",
  confidence: { requiredFamilies: [], minimum: 0.35, minimumMargin: 0, minimumFamilyCount: 1 },
  ...overrides,
});
const fillTarget = (name: string, overrides: Partial<InteractionTargetIntent> = {}) =>
  target(name, {
    requiredCapabilities: ["focusable", "accepts_text", "editable"],
    preferredEvidence: preferred(name, { roles: ["textbox"] }),
    prohibited: ["hidden", "disabled", "readonly", "display_only_text"],
    ...overrides,
  });
const readTarget = (name: string, overrides: Partial<InteractionTargetIntent> = {}) =>
  target(name, {
    requiredCapabilities: ["readable_value"],
    preferredEvidence: preferred(name, { roles: ["value"] }),
    risk: "read_only",
    ...overrides,
  });
const buttonTarget = (name: string, overrides: Partial<InteractionTargetIntent> = {}) =>
  target(name, { preferredEvidence: preferred(name, { roles: ["button"] }), ...overrides });
const pageFor = async (id: number) => {
  const page = await context.newPage();
  await page.goto(`${origin}/scenario/${id}`);
  return page;
};
const code = async (operation: Promise<unknown>, expected: string) =>
  expect(operation).rejects.toMatchObject({ code: expected });

const fixtures: Record<number, string> = {
  35: `<label>Notes<textarea></textarea></label>`,
  36: `<form aria-label="Search"><label>Country<select><option>NG</option></select></label></form><form aria-label="Checkout"><label>Country<select><option>Ghana</option></select></label></form>`,
  37: `<label>Name<input value="outside"></label><dialog open aria-label="Create user"><label>Name<input value="inside"></label></dialog>`,
  38: `<fieldset><legend>Billing</legend><label>Postcode<input value="bill"></label></fieldset><fieldset><legend>Shipping</legend><label>Postcode<input value="ship"></label></fieldset>`,
  39: `<table aria-label="Accounts"><tr aria-label="Ada"><td>Ada</td><td><button onclick="out.textContent='ada'">Open</button></td></tr><tr aria-label="Ben"><td>Ben</td><td><button onclick="out.textContent='ben'">Open</button></td></tr></table><output id="out"></output>`,
  40: `<main><section aria-label="Primary"><button onclick="out.textContent='primary'">Save</button></section><section aria-label="Secondary"><div><section aria-label="Nested"><button onclick="out.textContent='nested'">Save</button></section></div></section><output id="out"></output></main>`,
  41: `<button>Continue</button><button>Continue</button>`,
  42: `<button aria-label="Save draft">Save</button><button aria-label="Save final">Save</button>`,
  43: `<form aria-label="Actual"><button>Save</button></form>`,
  44: `<p>Nothing actionable here</p>`,
  45: `<div>Password</div>`,
  46: `<button id="replace">Save</button>`,
  47: `<button>Unrelated</button><script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<button aria-label="Ready">Ready</button>'),150)</script>`,
  48: `<button>Unrelated</button>`,
  49: `<button id="save">Save</button>`,
  50: `<button>Save</button>`,
  51: `<a href="/destination">Continue</a>`,
  52: `<button onclick="modal.hidden=false">Open dialog</button><div id="modal" role="dialog" aria-label="Confirmation" hidden><output aria-label="Confirmation result">Confirmed</output></div>`,
  53: `<button>Open dialog</button><div role="dialog" aria-label="Confirmation" hidden><output aria-label="Confirmation result">Confirmed</output></div>`,
  54: `<button onclick="document.querySelector('#status').textContent='Ready'">Run</button><output id="status" aria-label="Status"></output>`,
  55: `<button aria-label="Details" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); panel.hidden=false">Details</button><section id="panel" aria-label="Details panel" hidden><output aria-label="Details result">Expanded</output></section>`,
  56: `<button onclick="document.body.insertAdjacentHTML('beforeend','<section role=region aria-label=Result><output aria-label=Result>Created</output></section>')">Create</button>`,
  57: `<button onclick="fetch('/api/ready')">Load</button>`,
  58: `<button onclick="fetch('/api/fail')">Load</button>`,
  59: `<main>settling</main><script>let n=0;const i=setInterval(()=>{document.querySelector('main').textContent='tick '+n;if(++n===4)clearInterval(i)},70)</script>`,
  60: `<main>never stable</main><script>setInterval(()=>document.querySelector('main').textContent=String(Date.now()),40)</script>`,
  61: `<main>ready</main><script>setInterval(()=>fetch('/analytics'),60)</script>`,
  62: `<main>busy</main><script>setInterval(()=>fetch('/required-slow'),60)</script>`,
  63: `<form id="login"><input aria-label="Email"><button type="button" onclick="login.remove(); history.pushState({},'', '/portal'); document.body.insertAdjacentHTML('beforeend','<section role=region aria-label=Portal><output aria-label=Portal>Dashboard</output></section>')">Login</button></form>`,
  64: `<form id="login"><input aria-label="Email"><button type="button" onclick="history.pushState({},'', '/portal')">Login</button></form>`,
  65: `<form id="login"><button type="button" onclick="setTimeout(()=>{document.cookie='session=ready'; document.querySelector('#login').remove(); history.pushState({},'', '/portal'); document.body.insertAdjacentHTML('beforeend','<section role=region aria-label=Portal><output aria-label=Portal>Dashboard</output></section>')},250)">Login</button></form>`,
  66: `<form><button type="button" onclick="location.href='/auth-hop'">Login</button></form>`,
  67: `<form id="login"><input aria-label="Email"><button type="button" onclick="error.hidden=false">Login</button><p id="error" role="alert" hidden>Invalid credentials</p></form>`,
};

function handler(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
  if (url.pathname === "/api/ready") return send(response, "application/json", `{"ready":true}`);
  if (url.pathname === "/api/fail") {
    response.statusCode = 503;
    return send(response, "application/json", `{"ready":false}`);
  }
  if (url.pathname === "/analytics")
    return setTimeout(() => send(response, "text/plain", "ok"), 25);
  if (url.pathname === "/required-slow")
    return setTimeout(() => send(response, "text/plain", "slow"), 450);
  if (url.pathname === "/destination")
    return send(response, "text/html", page(`<main>Destination</main>`));
  if (url.pathname === "/auth-hop") {
    response.statusCode = 302;
    response.setHeader("location", "/portal-final");
    return response.end();
  }
  if (url.pathname === "/portal-final")
    return send(
      response,
      "text/html",
      page(
        `<section role="region" aria-label="Portal"><output aria-label="Portal">Dashboard</output></section>`,
      ),
    );
  const match = /^\/scenario\/(\d+)$/.exec(url.pathname);
  const fixture = match ? fixtures[Number(match[1])] : undefined;
  if (!fixture) {
    response.statusCode = 404;
    return send(response, "text/plain", "missing");
  }
  send(response, "text/html", page(fixture));
}
function page(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px Arial;padding:24px}button,input,textarea,select{margin:8px;padding:8px}dialog{display:block;position:static}</style></head><body>${body}</body></html>`;
}
function send(response: ServerResponse, type: string, body: string) {
  response.setHeader("content-type", type);
  response.end(body);
}

async function runReadiness(
  id: number,
  conditions: ReadinessCondition[],
  timeoutMs = 2_000,
  actionTarget?: string,
) {
  const directory = await mkdtemp(path.join(tmpdir(), `scry-http-b-${id}-`));
  outputDirectories.push(directory);
  const steps: Record<string, unknown>[] = [
    {
      id: "open",
      title: "Open",
      action: { type: "navigate", url: `${origin}/scenario/${id}` },
      evidence: [],
      onFailure: "stop",
      captureIntent: "final",
    },
  ];
  if (actionTarget)
    steps.push({
      id: "act",
      title: "Act",
      action: {
        type: "click",
        target: buttonTarget(actionTarget),
        expectedEffect: { type: "none" },
      },
      after: { mode: "all", timeoutMs, conditions },
      evidence: [],
      assertions: [],
      onFailure: "stop",
      captureIntent: "final",
    });
  else (steps[0] as any).after = { mode: "all", timeoutMs, conditions };
  const plan = currentPlanSchema.parse({
    name: `HTTP cohort B ${id}`,
    objective: `Scenario ${id}`,
    allowedOrigins: [origin],
    budgets: { maxActions: 4, maxDurationMs: 10_000, maxNavigations: 4 },
    checkpoints: [],
    steps,
  });
  return executePlan({
    plan,
    policy: executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true }),
    outputDirectory: directory,
    browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
}

describe("33-scenario production-shaped HTTP grounding cohort B", () => {
  beforeAll(async () => {
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("cohort server unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    context = await browser.newContext();
  });
  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(
      outputDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("035 fills a textarea", async () => {
    const p = await pageFor(35);
    try {
      await fillGroundedTarget(p, fillTarget("Notes"), "line one\nline two");
      expect(await p.locator("textarea").inputValue()).toBe("line one\nline two");
    } finally {
      await p.close();
    }
  });
  it("036 scopes a combobox to the correct form", async () => {
    const p = await pageFor(36);
    try {
      const locator = await resolveTargetLocator(
        p,
        target("Country", {
          requiredCapabilities: ["selects_option"],
          preferredEvidence: preferred("Country", { roles: ["combobox"] }),
          scope: { kind: "form", name: "Checkout" },
        }),
      );
      expect(await locator.locator("option").textContent()).toBe("Ghana");
    } finally {
      await p.close();
    }
  });
  it("037 scopes a duplicate field to an open dialog", async () => {
    const p = await pageFor(37);
    try {
      expect(
        await (
          await resolveTargetLocator(
            p,
            fillTarget("Name", { scope: { kind: "dialog", name: "Create user" } }),
          )
        ).inputValue(),
      ).toBe("inside");
    } finally {
      await p.close();
    }
  });
  it("038 scopes a field to its named field group", async () => {
    const p = await pageFor(38);
    try {
      expect(
        await (
          await resolveTargetLocator(
            p,
            fillTarget("Postcode", { scope: { kind: "field_group", name: "Shipping" } }),
          )
        ).inputValue(),
      ).toBe("ship");
    } finally {
      await p.close();
    }
  });
  it("039 scopes an action to a table row", async () => {
    const p = await pageFor(39);
    try {
      await clickGroundedTarget(
        p,
        buttonTarget("Open", {
          scope: { kind: "row", name: "Ben", within: { kind: "table", name: "Accounts" } },
        }),
      );
      expect(await p.locator("output").textContent()).toBe("ben");
    } finally {
      await p.close();
    }
  });
  it("040 scopes nested duplicate controls to the requested region", async () => {
    const p = await pageFor(40);
    try {
      await clickGroundedTarget(
        p,
        buttonTarget("Save", { scope: { kind: "region", name: "Nested" } }),
      );
      expect(await p.locator("output").textContent()).toBe("nested");
    } finally {
      await p.close();
    }
  });
  it("041 refuses identical candidates as ambiguous", async () => {
    const p = await pageFor(41);
    try {
      await code(
        resolveTarget(
          p,
          buttonTarget("Continue", {
            confidence: {
              requiredFamilies: [],
              minimum: 0.35,
              minimumMargin: 0.05,
              minimumFamilyCount: 1,
            },
          }),
        ),
        "TARGET_AMBIGUOUS",
      );
    } finally {
      await p.close();
    }
  });
  it("042 refuses close scores below the required margin", async () => {
    const p = await pageFor(42);
    try {
      await code(
        resolveTarget(
          p,
          buttonTarget("Save", {
            confidence: {
              requiredFamilies: [],
              minimum: 0.35,
              minimumMargin: 0.2,
              minimumFamilyCount: 1,
            },
          }),
        ),
        "TARGET_AMBIGUOUS",
      );
    } finally {
      await p.close();
    }
  });
  it("043 reports an invalid named scope", async () => {
    const p = await pageFor(43);
    try {
      await code(
        resolveTarget(p, buttonTarget("Save", { scope: { kind: "form", name: "Missing" } })),
        "TARGET_SCOPE_INVALID",
      );
    } finally {
      await p.close();
    }
  });
  it("044 distinguishes an empty actionable inventory", async () => {
    const p = await pageFor(44);
    try {
      await code(resolveTarget(p, buttonTarget("Save")), "NO_CAPABILITY_COMPATIBLE_CONTROL");
    } finally {
      await p.close();
    }
  });
  it("045 rejects display-only text for text entry", async () => {
    const p = await pageFor(45);
    try {
      await code(resolveTarget(p, fillTarget("Password")), "NO_CAPABILITY_COMPATIBLE_CONTROL");
    } finally {
      await p.close();
    }
  });
  it("046 rejects a target replaced after resolution", async () => {
    const p = await pageFor(46);
    try {
      const resolved = await resolveTarget(p, buttonTarget("Save"));
      await p.locator("button").evaluate((item) => item.replaceWith(item.cloneNode(true)));
      await code(resolved.revalidate(), "TARGET_CHANGED_BEFORE_ACTION");
    } finally {
      await p.close();
    }
  });
  it("047 resolves a target after delayed rendering", async () => {
    const p = await pageFor(47);
    try {
      await p.getByRole("button", { name: "Ready" }).waitFor();
      expect(
        await (await resolveTargetLocator(p, buttonTarget("Ready"))).getAttribute("aria-label"),
      ).toBe("Ready");
    } finally {
      await p.close();
    }
  });
  it("048 reports insufficient evidence when the requested target never appears", async () => {
    const p = await pageFor(48);
    try {
      await code(resolveTarget(p, buttonTarget("Ready")), "INSUFFICIENT_EVIDENCE");
    } finally {
      await p.close();
    }
  });
  it("049 re-resolves a semantically stable target after SPA replacement", async () => {
    const p = await pageFor(49);
    try {
      const first = await resolveTarget(p, buttonTarget("Save"));
      await p
        .locator("button")
        .evaluate((item) => setTimeout(() => item.replaceWith(item.cloneNode(true)), 50));
      await p.waitForTimeout(80);
      await code(first.revalidate(), "TARGET_CHANGED_BEFORE_ACTION");
      expect(await (await resolveTargetLocator(p, buttonTarget("Save"))).textContent()).toBe(
        "Save",
      );
    } finally {
      await p.close();
    }
  });
  it("050 requires calibration for incompatible historical drift", async () => {
    const p = await pageFor(50);
    try {
      const first = await resolveTarget(p, buttonTarget("Save"));
      registerGroundingHistoryProvider(p, async () => ({
        ...first.diagnostic.selectedFingerprint!,
        digest: "f".repeat(64),
        capabilityDigest: "e".repeat(64),
      }));
      await code(resolveTarget(p, buttonTarget("Save")), "GROUNDING_DRIFT_REQUIRES_CALIBRATION");
    } finally {
      await p.close();
    }
  });
  it("051 verifies a navigation effect", async () => {
    const p = await pageFor(51);
    try {
      const before = p.url();
      await clickGroundedTarget(
        p,
        target("Continue", { preferredEvidence: preferred("Continue", { roles: ["link"] }) }),
      );
      await expect(
        verifyExpectedEffect(
          p,
          { type: "navigation", url: "/destination", match: "path" },
          before,
          1_000,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await p.close();
    }
  });
  it("052 verifies a visibility effect", async () => {
    const p = await pageFor(52);
    try {
      await clickGroundedTarget(p, buttonTarget("Open dialog"));
      await expect(
        verifyExpectedEffect(
          p,
          {
            type: "visibility_change",
            target: readTarget("Confirmation result", {
              scope: { kind: "dialog", name: "Confirmation" },
            }),
            visible: true,
          },
          p.url(),
          1_000,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await p.close();
    }
  });
  it("053 reports a missing declared effect", async () => {
    const p = await pageFor(53);
    try {
      await clickGroundedTarget(p, buttonTarget("Open dialog"));
      await code(
        verifyExpectedEffect(
          p,
          {
            type: "visibility_change",
            target: readTarget("Confirmation result", {
              scope: { kind: "dialog", name: "Confirmation" },
            }),
            visible: true,
          },
          p.url(),
          250,
        ),
        "EXPECTED_EFFECT_NOT_OBSERVED",
      );
    } finally {
      await p.close();
    }
  });
  it("054 verifies a value-change effect", async () => {
    const p = await pageFor(54);
    try {
      await clickGroundedTarget(p, buttonTarget("Run"));
      await expect(
        verifyExpectedEffect(
          p,
          { type: "value_change", target: readTarget("Status"), expected: "Ready" },
          p.url(),
          1_000,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await p.close();
    }
  });
  it("055 verifies an expanded state through its resulting region", async () => {
    const p = await pageFor(55);
    try {
      await clickGroundedTarget(p, buttonTarget("Details"));
      expect(await p.locator("button").getAttribute("aria-expanded")).toBe("true");
      await expect(
        verifyExpectedEffect(
          p,
          {
            type: "new_region",
            target: readTarget("Details result", {
              scope: { kind: "region", name: "Details panel" },
            }),
          },
          p.url(),
          1_000,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await p.close();
    }
  });
  it("056 verifies a newly created region", async () => {
    const p = await pageFor(56);
    try {
      await clickGroundedTarget(p, buttonTarget("Create"));
      await expect(
        verifyExpectedEffect(
          p,
          {
            type: "new_region",
            target: readTarget("Result", { scope: { kind: "region", name: "Result" } }),
          },
          p.url(),
          1_000,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await p.close();
    }
  });
  it("057 observes a successful request readiness signal", async () => {
    const report = await runReadiness(
      57,
      [
        {
          type: "request",
          urlPattern: "/api/ready",
          method: "GET",
          status: { min: 200, max: 299 },
        },
      ],
      2_000,
      "Load",
    );
    expect(report.state).toBe("passed");
    expect(report.steps[1]?.readiness).toMatchObject({ status: "passed" });
  });
  it("058 gives failed readiness provenance for a wrong response status", async () => {
    const report = await runReadiness(
      58,
      [{ type: "request", urlPattern: "/api/fail", method: "GET", status: { min: 200, max: 299 } }],
      500,
      "Load",
    );
    expect(report.state).toBe("failed");
    expect(report.steps[1]?.readiness).toMatchObject({ status: "failed" });
    expect(report.outcomeClassification).toBe("readiness_timeout");
  });
  it("059 waits for DOM settlement", async () => {
    const report = await runReadiness(59, [{ type: "domStable", quietWindowMs: 150 }], 2_000);
    expect(report.state).toBe("passed");
    expect(report.steps[0]?.readiness).toMatchObject({ status: "passed" });
  });
  it("060 reports readiness failure when the DOM never settles", async () => {
    const report = await runReadiness(60, [{ type: "domStable", quietWindowMs: 200 }], 500);
    expect(report.state).toBe("failed");
    expect(report.steps[0]?.readiness).toMatchObject({ status: "failed" });
  });
  it("061 ignores declared analytics while waiting for network quiet", async () => {
    const report = await runReadiness(
      61,
      [{ type: "networkQuiet", quietWindowMs: 150, ignoreUrlPatterns: ["/analytics"] }],
      1_500,
    );
    expect(report.state).toBe("passed");
  });
  it("062 fails network quiet while required requests remain active", async () => {
    const report = await runReadiness(
      62,
      [{ type: "networkQuiet", quietWindowMs: 200, ignoreUrlPatterns: [] }],
      600,
    );
    expect(report.state).toBe("failed");
    expect(report.steps[0]?.readiness).toMatchObject({ status: "failed" });
  });
  it("063 establishes durable authentication from independent signals", async () => {
    const report = await runReadiness(
      63,
      [
        { type: "url", expected: "/portal", match: "path" },
        {
          type: "visible",
          target: readTarget("Portal", { scope: { kind: "region", name: "Portal" } }),
        },
        { type: "domStable", quietWindowMs: 150 },
      ],
      2_000,
      "Login",
    );
    expect(report.state).toBe("passed");
  });
  it("064 refuses authentication readiness when only the URL changes", async () => {
    const report = await runReadiness(
      64,
      [
        { type: "url", expected: "/portal", match: "path" },
        {
          type: "visible",
          target: readTarget("Portal", { scope: { kind: "region", name: "Portal" } }),
        },
      ],
      600,
      "Login",
    );
    expect(report.state).toBe("failed");
    expect(report.steps[1]?.readiness).toMatchObject({ status: "failed" });
  });
  it("065 waits for delayed authenticated state rather than a fixed sleep", async () => {
    const report = await runReadiness(
      65,
      [
        { type: "url", expected: "/portal", match: "path" },
        {
          type: "visible",
          target: readTarget("Portal", { scope: { kind: "region", name: "Portal" } }),
        },
        { type: "domStable", quietWindowMs: 150 },
      ],
      2_000,
      "Login",
    );
    expect(
      report.state,
      JSON.stringify({
        outcome: report.outcomeClassification,
        steps: report.steps.map((step) => ({ action: step.action, readiness: step.readiness })),
      }),
    ).toBe("passed");
  });
  it("066 follows intermediate redirects to the final portal", async () => {
    const report = await runReadiness(
      66,
      [
        { type: "url", expected: "/portal-final", match: "path" },
        {
          type: "visible",
          target: readTarget("Portal", { scope: { kind: "region", name: "Portal" } }),
        },
      ],
      2_000,
      "Login",
    );
    expect(report.state).toBe("passed");
  });
  it("067 classifies rejected credentials as an application-visible failure", async () => {
    const report = await runReadiness(
      67,
      [{ type: "visible", target: readTarget("Invalid credentials") }],
      1_000,
      "Login",
    );
    expect(report.state).toBe("passed");
    expect(report.steps[1]?.readiness).toMatchObject({ status: "passed" });
    expect(report.steps[1]?.action.status).toBe("passed");
  });
});
