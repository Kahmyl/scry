import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { InteractionTargetIntent } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { builtInAdapterRegistry } from "./support/gauntlet-adapters.js";
import { resolveTarget, resolveTargetLocator } from "../src/grounding.js";
import { checkPraxisTarget as checkGroundedTarget, clickPraxisTarget as clickGroundedTarget, fillPraxisTarget as fillGroundedTarget, selectPraxisTarget as selectGroundedTarget } from "./support/praxis-actions.js";

type Scenario = {
  id: number;
  name: string;
  body: string;
  run(page: Page): Promise<void>;
};

const identity = (
  name: string,
  extra: Partial<InteractionTargetIntent["preferredEvidence"]> = {},
): InteractionTargetIntent["preferredEvidence"] => ({
  roles: [],
  names: [name],
  labels: [name],
  descriptions: [],
  placeholders: [name],
  inputTypes: [],
  ...extra,
});

const target = (name: string, overrides: Partial<InteractionTargetIntent> = {}): InteractionTargetIntent => ({
  concept: name.toLowerCase().replace(/\W+/g, "_"),
  requiredCapabilities: ["pointer_activatable"],
  preferredEvidence: identity(name),
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "ordinary",
  confidence: { requiredFamilies: [], minimum: 0.35, minimumMargin: 0, minimumFamilyCount: 1 },
  ...overrides,
});

const fillTarget = (name: string, overrides: Partial<InteractionTargetIntent> = {}) => target(name, {
  requiredCapabilities: ["focusable", "accepts_text", "editable"],
  preferredEvidence: identity(name, { roles: ["textbox"] }),
  prohibited: ["hidden", "disabled", "readonly", "display_only_text"],
  ...overrides,
});

const clickTarget = (name: string, overrides: Partial<InteractionTargetIntent> = {}) => target(name, {
  preferredEvidence: identity(name, { roles: ["button"] }),
  ...overrides,
});

const expectCode = async (work: Promise<unknown>, code: string) => {
  await expect(work).rejects.toMatchObject({ code });
};

const fillScenario = (
  id: number,
  name: string,
  body: string,
  intent: InteractionTargetIntent,
  exactSelector: string,
  value = `cohort-a-${id}`,
): Scenario => ({
  id,
  name,
  body,
  run: async (page) => {
    const result = await fillGroundedTarget(page, intent, value);
    expect(result.diagnostic.selectedFingerprint).toBeDefined();
    expect(result.adapter).toMatch(/fill|editable|keyboard/);
    expect(await page.locator(exactSelector).inputValue().catch(() => page.locator(exactSelector).textContent())).toBe(value);
  },
});

const clickScenario = (
  id: number,
  name: string,
  body: string,
  intent: InteractionTargetIntent,
  expected = `clicked-${id}`,
): Scenario => ({
  id,
  name,
  body,
  run: async (page) => {
    const result = await clickGroundedTarget(page, intent);
    expect(result.diagnostic.selectedFingerprint).toBeDefined();
    expect(await page.locator("#effect").textContent()).toBe(expected);
  },
});

const scenarios: Scenario[] = [
  fillScenario(1, "native label-for", `<label for="email">Email</label><input id="email">`, fillTarget("Email"), "#email"),
  fillScenario(2, "ARIA label", `<input id="email" aria-label="Email">`, fillTarget("Email"), "#email"),
  fillScenario(3, "ARIA labelled-by", `<span id="email-label">Email</span><input id="email" aria-labelledby="email-label">`, fillTarget("Email"), "#email"),
  fillScenario(4, "placeholder-only weak markup", `<input id="email" placeholder="Email">`, fillTarget("Email", { preferredEvidence: identity("Email", { roles: ["textbox"], placeholders: ["Email"] }) }), "#email"),
  fillScenario(5, "unassociated visual label with geometry anchor", `<form><div class="field-label">Email address</div><input id="email" placeholder="name@example.test"></form>`, fillTarget("Email address", {
    preferredEvidence: identity("Email address", { roles: ["textbox"], placeholders: ["name@example.test"], visual: { sources: ["geometry"], expectedText: "Email address", protectedUse: false } }),
    scope: { kind: "form" }, confidence: { requiredFamilies: ["visual"], minimum: 0.45, minimumMargin: 0, minimumFamilyCount: 3 },
  }), "#email"),
  fillScenario(6, "OCR anchor expands to nearby password control", `<form><div class="ocr-label">Password</div><input id="password" type="password" placeholder="Enter your password"></form>`, fillTarget("Password", {
    preferredEvidence: identity("Password", { roles: ["textbox"], placeholders: ["Enter your password"], inputTypes: ["password"], visual: { sources: ["ocr"], expectedText: "Password", protectedUse: false } }),
    scope: { kind: "form" }, risk: "authentication", confidence: { requiredFamilies: ["visual", "native_control"], minimum: 0.55, minimumMargin: 0.05, minimumFamilyCount: 3 },
  }), "#password", "known-secret"),
  fillScenario(7, "nested native label", `<label>Account name <span><input id="account"></span></label>`, fillTarget("Account name"), "#account"),
  fillScenario(8, "content-editable custom textbox", `<div id="bio" role="textbox" aria-label="Biography" contenteditable="true"></div>`, fillTarget("Biography"), "#bio"),
  {
    id: 9,
    name: "open Shadow DOM control",
    body: `<div id="host"></div><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<label>Email<input id="shadow-email"></label>'</script>`,
    run: async (page) => {
      const locator = await resolveTargetLocator(page, fillTarget("Email"));
      await locator.fill("shadow@example.test");
      expect(await locator.getAttribute("id")).toBe("shadow-email");
      expect(await locator.inputValue()).toBe("shadow@example.test");
    },
  },
  fillScenario(10, "hidden duplicate rejected", `<input aria-label="Email" style="display:none"><input id="visible" aria-label="Email">`, fillTarget("Email"), "#visible"),
  fillScenario(11, "disabled duplicate rejected", `<input aria-label="Email" disabled><input id="enabled" aria-label="Email">`, fillTarget("Email"), "#enabled"),
  fillScenario(12, "readonly duplicate rejected", `<input aria-label="Email" readonly><input id="editable" aria-label="Email">`, fillTarget("Email"), "#editable"),
  fillScenario(13, "duplicate forms resolved by named scope", `<form aria-label="Search"><input aria-label="Query"></form><form aria-label="Support"><input id="support-query" aria-label="Query"></form>`, fillTarget("Query", { scope: { kind: "form", name: "Support" } }), "#support-query"),
  fillScenario(14, "dialog scope selects modal field", `<input aria-label="Name"><dialog open aria-label="Create user"><input id="modal-name" aria-label="Name"></dialog>`, fillTarget("Name", { scope: { kind: "dialog", name: "Create user" } }), "#modal-name"),
  fillScenario(15, "field-group scope selects shipping field", `<fieldset><legend>Billing</legend><label>Postcode<input></label></fieldset><fieldset><legend>Shipping</legend><label>Postcode<input id="shipping"></label></fieldset>`, fillTarget("Postcode", { scope: { kind: "field_group", name: "Shipping" } }), "#shipping"),
  fillScenario(16, "reversed visual label order", `<form><input id="code" placeholder="Account code"><div>Account code</div></form>`, fillTarget("Account code", { preferredEvidence: identity("Account code", { roles: ["textbox"], placeholders: ["Account code"], visual: { sources: ["geometry"], expectedText: "Account code", protectedUse: false } }), scope: { kind: "form" } }), "#code"),
  clickScenario(17, "native button", `<button onclick="effect.textContent='clicked-17'">Save</button><output id="effect"></output>`, clickTarget("Save")),
  clickScenario(18, "link implemented as control", `<a href="#continued" aria-label="Continue" onclick="effect.textContent='clicked-18'">Go</a><output id="effect"></output>`, target("Continue", { preferredEvidence: identity("Continue", { roles: ["link"] }) })),
  clickScenario(19, "ARIA button custom control", `<div role="button" tabindex="0" aria-label="Save" onclick="effect.textContent='clicked-19'">S</div><output id="effect"></output>`, clickTarget("Save")),
  clickScenario(20, "icon-only button", `<button aria-label="Copy" onclick="effect.textContent='clicked-20'"><svg data-icon="copy"><title>Copy</title></svg></button><output id="effect"></output>`, clickTarget("Copy", { preferredEvidence: identity("Copy", { roles: ["button"], visual: { sources: ["icon"], icon: "copy", protectedUse: false } }) })),
  clickScenario(21, "deeply nested button text", `<button onclick="effect.textContent='clicked-21'"><span><strong>Continue</strong></span></button><output id="effect"></output>`, clickTarget("Continue")),
  {
    id: 22,
    name: "native checkbox capability",
    body: `<label><input id="terms" type="checkbox"> Accept terms</label>`,
    run: async (page) => {
      await checkGroundedTarget(page, target("Accept terms", { requiredCapabilities: ["toggleable"], preferredEvidence: identity("Accept terms", { roles: ["checkbox"] }) }), true);
      expect(await page.locator("#terms").isChecked()).toBe(true);
    },
  },
  {
    id: 23,
    name: "fake switch dispatch is typed refusal",
    body: `<div role="switch" tabindex="0" aria-label="Notifications">Notifications</div>`,
    run: async (page) => expectCode(checkGroundedTarget(page, target("Notifications", { requiredCapabilities: ["toggleable"], preferredEvidence: identity("Notifications", { roles: ["checkbox"] }) }), true), "PRAXIS_INTERACTION_DISPATCH_FAILED"),
  },
  {
    id: 24,
    name: "native select capability",
    body: `<label>Country<select id="country"><option value="ng">Nigeria</option><option value="gh">Ghana</option></select></label>`,
    run: async (page) => {
      await selectGroundedTarget(page, target("Country", { requiredCapabilities: ["selects_option"], preferredEvidence: identity("Country", { roles: ["combobox"] }) }), "gh");
      expect(await page.locator("#country").inputValue()).toBe("gh");
    },
  },
  fillScenario(25, "textarea text entry", `<label>Notes<textarea id="notes"></textarea></label>`, fillTarget("Notes"), "#notes"),
  fillScenario(26, "native password evidence", `<input id="password" type="password" placeholder="Password">`, fillTarget("Password", { preferredEvidence: identity("Password", { roles: ["textbox"], placeholders: ["Password"], inputTypes: ["password"] }), risk: "authentication" }), "#password", "known-secret"),
  {
    id: 27,
    name: "duplicate compatible controls are ambiguous",
    body: `<button>Continue</button><button>Continue</button>`,
    run: async (page) => expectCode(resolveTarget(page, clickTarget("Continue", { confidence: { requiredFamilies: [], minimum: 0.35, minimumMargin: 0.05, minimumFamilyCount: 1 } })), "TARGET_AMBIGUOUS"),
  },
  {
    id: 28,
    name: "missing named scope is typed refusal",
    body: `<form aria-label="Actual"><button>Save</button></form>`,
    run: async (page) => expectCode(resolveTarget(page, clickTarget("Save", { scope: { kind: "form", name: "Missing" } })), "TARGET_SCOPE_INVALID"),
  },
  {
    id: 29,
    name: "display-only password label cannot receive text",
    body: `<div>Password</div>`,
    run: async (page) => expectCode(resolveTarget(page, fillTarget("Password")), "NO_CAPABILITY_COMPATIBLE_CONTROL"),
  },
  {
    id: 30,
    name: "rerendered target is rejected before dispatch",
    body: `<button id="save">Save</button>`,
    run: async (page) => {
      const result = await resolveTarget(page, clickTarget("Save"));
      await page.locator("#save").evaluate((button) => button.replaceWith(button.cloneNode(true)));
      await expectCode(result.revalidate(), "TARGET_CHANGED_BEFORE_ACTION");
    },
  },
  {
    id: 31,
    name: "ordinary canvas coordinate action",
    body: `<canvas id="canvas" width="240" height="90" role="button" aria-label="Add"></canvas><output id="effect"></output><script>canvas.onclick=()=>effect.textContent='canvas-clicked'</script>`,
    run: async (page) => {
      const result = await clickGroundedTarget(page, target("Add", { requiredCapabilities: ["coordinate_action", "pointer_activatable"], preferredEvidence: identity("Add", { roles: ["button"], visual: { sources: ["icon", "canvas"], icon: "add", protectedUse: false } }), confidence: { requiredFamilies: ["visual"], minimum: 0.35, minimumMargin: 0, minimumFamilyCount: 2 } }));
      expect(result.adapter).toBe("canvas_coordinate");
      expect(await page.locator("#effect").textContent()).toBe("canvas-clicked");
    },
  },
  {
    id: 32,
    name: "destructive canvas action is refused",
    body: `<canvas width="240" height="90" role="button" aria-label="Delete"></canvas>`,
    run: async (page) => expectCode(resolveTarget(page, target("Delete", { requiredCapabilities: ["coordinate_action", "pointer_activatable"], preferredEvidence: identity("Delete", { roles: ["button"], visual: { sources: ["icon", "canvas"], icon: "delete", protectedUse: false } }), risk: "destructive" })), "NO_CAPABILITY_COMPATIBLE_CONTROL"),
  },
  {
    id: 33,
    name: "network adapter consumes a real browser response",
    body: `<button id="issue" onclick="fetch('/api/token').then(r=>r.json()).then(v=>effect.textContent=v.status)">Issue</button><output id="effect"></output>`,
    run: async (page) => {
      const responses: Array<{ origin: string; method: string; path: string; body: unknown }> = [];
      page.on("response", async (response) => {
        if (new URL(response.url()).pathname === "/api/token") responses.push({ origin, method: response.request().method(), path: "/api/token", body: await response.json() });
      });
      await page.locator("#issue").click();
      await expect.poll(() => responses.length).toBe(1);
      const registered: string[] = [];
      const result = await builtInAdapterRegistry.execute("gauntlet.network", { page, allowedOrigins: [origin], protectedInterval: true, registerSecret: (value) => registered.push(value), networkResponses: responses }, { origin, method: "GET", path: "/api/token", jsonPointer: "/token" });
      expect(result).toMatchObject({ code: "ADAPTER_COMPLETED", value: "cohort-a-network-secret" });
      expect(registered).toEqual(["cohort-a-network-secret"]);
      expect(await page.locator("#effect").textContent()).toBe("issued");
    },
  },
  {
    id: 34,
    name: "safe-exit adapter performs real navigation",
    body: `<main>Protected ceremony</main>`,
    run: async (page) => {
      const result = await builtInAdapterRegistry.execute("gauntlet.safe-exit", { page, allowedOrigins: [origin], protectedInterval: true, registerSecret: () => undefined }, { kind: "navigate", url: `${origin}/safe` });
      expect(result.code).toBe("ADAPTER_COMPLETED");
      expect(page.url()).toBe(`${origin}/safe`);
      expect(await page.locator("h1").textContent()).toBe("Safe boundary restored");
    },
  },
];

let browser: Browser;
let context: BrowserContext;
let server: Server;
let origin: string;

describe("cohort A: 34 real-HTTP capability-grounding scenarios", () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      if (url.pathname === "/api/token") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ token: "cohort-a-network-secret", status: "issued" }));
        return;
      }
      if (url.pathname === "/safe") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(document("<h1>Safe boundary restored</h1>"));
        return;
      }
      const match = /^\/scenario\/(\d+)$/.exec(url.pathname);
      const scenario = match ? scenarios.find(({ id }) => id === Number(match[1])) : undefined;
      if (!scenario) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(document(scenario.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  });

  for (const scenario of scenarios) {
    it(`${String(scenario.id).padStart(3, "0")} ${scenario.name}`, async () => {
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/scenario/${scenario.id}`, { waitUntil: "networkidle" });
        expect(page.url()).toBe(`${origin}/scenario/${scenario.id}`);
        await scenario.run(page);
      } finally {
        if (!page.isClosed()) await page.close();
      }
    }, scenario.id === 6 ? 30_000 : 10_000);
  }
});

function document(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cohort A</title><style>
    body{font-family:Arial,sans-serif;margin:32px;color:#111;background:#fff} form,fieldset,dialog{padding:20px;margin:12px;border:1px solid #aaa}
    input,textarea,select,button,a,[role=button],[role=textbox],canvas{display:block;min-width:180px;min-height:32px;margin:8px;padding:8px}
    .field-label,.ocr-label{font-size:28px;font-weight:700;margin:8px 8px 2px} output{display:block;margin:8px}
  </style></head><body>${body}</body></html>`;
}
