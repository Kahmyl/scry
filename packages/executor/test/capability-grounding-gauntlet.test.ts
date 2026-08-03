import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { InteractionTargetIntent } from "@scry/contracts";

import {
  GroundingError,
  resolveTarget,
  resolveTargetLocator,
  verifyExpectedEffect,
} from "../src/grounding.js";
import { checkPraxisTarget as checkGroundedTarget, clickPraxisTarget as clickGroundedTarget, fillPraxisTarget as fillGroundedTarget, selectPraxisTarget as selectGroundedTarget } from "./support/praxis-actions.js";
import { acquireValue } from "../src/protected-extractor.js";

type Scenario = { name: string; run(page: Page): Promise<void> };

let browser: Browser;
let context: BrowserContext;
let server: Server;
let origin: string;

const evidence = (name: string, extra: Partial<InteractionTargetIntent["preferredEvidence"]> = {}): InteractionTargetIntent["preferredEvidence"] => ({
  roles: [], names: [name], labels: [name], descriptions: [], placeholders: [name], inputTypes: [], ...extra,
});
const target = (name: string, overrides: Partial<InteractionTargetIntent> = {}): InteractionTargetIntent => ({
  concept: name.toLowerCase().replace(/\W+/g, "_"), requiredCapabilities: ["pointer_activatable"], preferredEvidence: evidence(name),
  scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"], risk: "ordinary",
  confidence: { requiredFamilies: [], minimum: .35, minimumMargin: 0, minimumFamilyCount: 1 }, ...overrides,
});
const fillTarget = (name: string, overrides: Partial<InteractionTargetIntent> = {}) => target(name, {
  requiredCapabilities: ["focusable", "accepts_text", "editable"], preferredEvidence: evidence(name, { roles: ["textbox"] }),
  prohibited: ["hidden", "disabled", "readonly", "display_only_text"], ...overrides,
});
const readTarget = (name: string, overrides: Partial<InteractionTargetIntent> = {}) => target(name, {
  requiredCapabilities: ["readable_value"], preferredEvidence: evidence(name, { roles: ["value"] }), risk: "read_only", ...overrides,
});
const set = async (page: Page, html: string) => { await page.setContent(html); };
const expectCode = async (operation: Promise<unknown>, code: string) => { await expect(operation).rejects.toMatchObject({ code }); };
const fillCase = (name: string, html: string, intent: InteractionTargetIntent, selector: string, expected = "entered"): Scenario => ({
  name, run: async (page) => { await set(page, html); await fillGroundedTarget(page, intent, expected); expect(await page.locator(selector).inputValue().catch(() => page.locator(selector).textContent())).toBe(expected); },
});
const clickCase = (name: string, html: string, intent: InteractionTargetIntent, expected = "clicked"): Scenario => ({
  name, run: async (page) => { await set(page, html); await clickGroundedTarget(page, intent); expect(await page.locator("output").textContent()).toBe(expected); },
});

const scenarios: Scenario[] = [
  fillCase("01 proper label-for input", `<label for="email">Email</label><input id="email">`, fillTarget("Email"), "#email"),
  fillCase("02 aria-label input", `<input aria-label="Email">`, fillTarget("Email"), "input"),
  fillCase("03 aria-labelledby input", `<span id="email-label">Email</span><input aria-labelledby="email-label">`, fillTarget("Email"), "input"),
  fillCase("04 placeholder-only input", `<input placeholder="Email">`, fillTarget("Email", { preferredEvidence: evidence("Email", { roles: ["textbox"], placeholders: ["Email"] }) }), "input"),
  fillCase("05 nearby unassociated label", `<form><div>Email</div><input placeholder="Enter email"></form>`, fillTarget("Email", { preferredEvidence: evidence("Email", { roles: ["textbox"], placeholders: ["Enter email"], visual: { sources: ["geometry"], expectedText: "Email", protectedUse: false } }), scope: { kind: "form" } }), "input"),
  fillCase("06 nested native label", `<label>Email <span><input></span></label>`, fillTarget("Email"), "input"),
  fillCase("07 deeply wrapped input", `<form aria-label="Account"><div><section><label for="u">Username</label><div><span><input id="u"></span></div></section></div></form>`, fillTarget("Username", { scope: { kind: "form", name: "Account" } }), "input"),
  fillCase("08 content-editable textbox", `<div role="textbox" aria-label="Biography" contenteditable="true"></div>`, fillTarget("Biography"), `[role=textbox]`),
  fillCase("09 focusable custom editable control", `<div role="textbox" aria-label="Nickname" tabindex="0" contenteditable="true"></div>`, fillTarget("Nickname"), `[role=textbox]`),
  { name: "10 open Shadow DOM input", run: async (page) => { await set(page, `<div id="host"></div><script>host.attachShadow({mode:'open'}).innerHTML='<label>Email<input></label>'</script>`); const locator = await resolveTargetLocator(page, fillTarget("Email")); await locator.fill("shadow@example.test"); expect(await locator.inputValue()).toBe("shadow@example.test"); } },
  fillCase("11 hidden duplicate ignored", `<input aria-label="Email" style="display:none"><input aria-label="Email">`, fillTarget("Email"), `input:not([style])`),
  fillCase("12 disabled duplicate ignored", `<input aria-label="Email" disabled><input aria-label="Email">`, fillTarget("Email"), `input:not([disabled])`),
  fillCase("13 readonly duplicate ignored", `<input aria-label="Email" readonly><input aria-label="Email">`, fillTarget("Email"), `input:not([readonly])`),
  fillCase("14 duplicate forms resolved by scope", `<form aria-label="Search"><input aria-label="Query"></form><form aria-label="Support"><input aria-label="Query"></form>`, fillTarget("Query", { scope: { kind: "form", name: "Support" } }), `form[aria-label=Support] input`),
  fillCase("15 dialog field resolved by scope", `<input aria-label="Name"><dialog open aria-label="Create user"><input aria-label="Name"></dialog>`, fillTarget("Name", { scope: { kind: "dialog", name: "Create user" } }), `dialog input`),
  fillCase("16 field-group relationship", `<fieldset><legend>Billing</legend><label>Postcode<input></label></fieldset><fieldset><legend>Shipping</legend><label>Postcode<input></label></fieldset>`, fillTarget("Postcode", { scope: { kind: "field_group", name: "Shipping" } }), `fieldset:nth-of-type(2) input`),
  fillCase("17 visually reversed label and control", `<form><input placeholder="Account code"><div>Account code</div></form>`, fillTarget("Account code", { preferredEvidence: evidence("Account code", { roles: ["textbox"], placeholders: ["Account code"] }), scope: { kind: "form" } }), "input"),
  clickCase("18 native button", `<button onclick="out.textContent='clicked'">Save</button><output id="out"></output>`, target("Save", { preferredEvidence: evidence("Save", { roles: ["button"] }) })),
  clickCase("19 link used as button", `<a href="#done" aria-label="Continue" onclick="out.textContent='clicked'">Go</a><output id="out"></output>`, target("Continue", { preferredEvidence: evidence("Continue", { roles: ["link"] }) })),
  clickCase("20 ARIA button div", `<div role="button" tabindex="0" aria-label="Save" onclick="out.textContent='clicked'">S</div><output id="out"></output>`, target("Save", { preferredEvidence: evidence("Save", { roles: ["button"] }) })),
  clickCase("21 icon-only button", `<button aria-label="Copy" onclick="out.textContent='clicked'"><svg data-icon="copy"><title>Copy</title></svg></button><output id="out"></output>`, target("Copy", { preferredEvidence: evidence("Copy", { roles: ["button"], visual: { sources: ["icon"], icon: "copy", protectedUse: false } }) })),
  clickCase("22 nested button text", `<button onclick="out.textContent='clicked'"><span><strong>Continue</strong></span></button><output id="out"></output>`, target("Continue", { preferredEvidence: evidence("Continue", { roles: ["button"] }) })),
  clickCase("23 hidden duplicate button ignored", `<button style="display:none">Save</button><button onclick="out.textContent='clicked'">Save</button><output id="out"></output>`, target("Save", { preferredEvidence: evidence("Save", { roles: ["button"] }) })),
  { name: "24 rerendered control rejected before dispatch", run: async (page) => { await set(page, `<button>Save</button>`); const result = await resolveTarget(page, target("Save", { preferredEvidence: evidence("Save", { roles: ["button"] }) })); await page.locator("button").evaluate((button) => button.replaceWith(button.cloneNode(true))); await expectCode(result.revalidate(), "TARGET_CHANGED_BEFORE_ACTION"); } },
  { name: "25 native checkbox toggles", run: async (page) => { await set(page, `<label><input type="checkbox"> Accept terms</label>`); await checkGroundedTarget(page, target("Accept terms", { requiredCapabilities: ["toggleable"], preferredEvidence: evidence("Accept terms", { roles: ["checkbox"] }) }), true); expect(await page.locator("input").isChecked()).toBe(true); } },
  { name: "26 fake switch refuses native dispatch", run: async (page) => { await set(page, `<div role="switch" tabindex="0" aria-label="Notifications">Notifications</div>`); await expectCode(checkGroundedTarget(page, target("Notifications", { requiredCapabilities: ["toggleable"], preferredEvidence: evidence("Notifications", { roles: ["checkbox"] }) }), true), "PRAXIS_INTERACTION_DISPATCH_FAILED"); } },
  { name: "27 native select changes option", run: async (page) => { await set(page, `<label>Country<select><option value="ng">Nigeria</option><option value="gh">Ghana</option></select></label>`); await selectGroundedTarget(page, target("Country", { requiredCapabilities: ["selects_option"], preferredEvidence: evidence("Country", { roles: ["combobox"] }) }), "gh"); expect(await page.locator("select").inputValue()).toBe("gh"); } },
  fillCase("28 textarea entry", `<label>Notes<textarea></textarea></label>`, fillTarget("Notes"), "textarea"),
  fillCase("29 password native type evidence", `<input type="password" placeholder="Password">`, fillTarget("Password", { preferredEvidence: evidence("Password", { roles: ["textbox"], placeholders: ["Password"], inputTypes: ["password"] }), risk: "authentication" }), "input", "secret"),
  fillCase("30 Vitract-style unassociated password label", `<form><div>Password</div><div><input type="password" placeholder="Enter your password"></div></form>`, fillTarget("Password", { preferredEvidence: evidence("Password", { roles: ["textbox"], placeholders: ["Enter your password"], inputTypes: ["password"], visual: { sources: ["geometry"], expectedText: "Password", protectedUse: false } }), scope: { kind: "form" }, risk: "authentication", confidence: { requiredFamilies: [], minimum: .55, minimumMargin: .05, minimumFamilyCount: 3 } }), "input", "secret"),
  { name: "31 output value reading", run: async (page) => { await set(page, `<output aria-label="Status">Ready</output>`); expect(await (await resolveTargetLocator(page, readTarget("Status"))).textContent()).toBe("Ready"); } },
  { name: "32 code-block value reading", run: async (page) => { await set(page, `<code aria-label="API key">public-value</code>`); expect(await (await resolveTargetLocator(page, readTarget("API key"))).textContent()).toBe("public-value"); } },
  { name: "33 direct definition-list acquisition", run: async (page) => { await set(page, `<dl><dt>Client secret</dt><dd>direct-secret</dd></dl>`); const result = await acquireValue(page, { target: readTarget("Client secret", { relations: [{ kind: "following", name: "Client secret" }], risk: "protected" }), classification: "unknown_secret", permittedMethods: ["semantic_field_value"], validation: { minimumLength: 3, maximumLength: 100 } }, 500); expect(result.value).toBe("direct-secret"); } },
  { name: "34 wrapped definition-list acquisition", run: async (page) => { await set(page, `<dl><div><div><dt>Client secret</dt><button>Copy</button></div><dd>wrapped-secret</dd></div></dl>`); const result = await acquireValue(page, { target: readTarget("Client secret", { relations: [{ kind: "following", name: "Client secret" }], risk: "protected" }), classification: "unknown_secret", permittedMethods: ["semantic_field_value"], validation: { minimumLength: 3, maximumLength: 100 } }, 500); expect(result.value).toBe("wrapped-secret"); } },
  { name: "35 selectable plain-text acquisition", run: async (page) => { await set(page, `<div aria-label="Generated token">plain-selectable-token</div>`); const result = await acquireValue(page, { target: readTarget("Generated token", { risk: "protected" }), classification: "unknown_secret", permittedMethods: ["scoped_text_selection"], validation: { minimumLength: 10, maximumLength: 100 } }, 500); expect(result.value).toBe("plain-selectable-token"); } },
  { name: "36 input-value acquisition", run: async (page) => { await set(page, `<input aria-label="Client ID" value="client-123">`); const result = await acquireValue(page, { target: readTarget("Client ID"), classification: "public", permittedMethods: ["input_value"], validation: { minimumLength: 3, maximumLength: 100 } }, 500); expect(result.value).toBe("client-123"); } },
  { name: "37 textarea-value acquisition", run: async (page) => { await set(page, `<textarea aria-label="Recovery code">recovery-123</textarea>`); const result = await acquireValue(page, { target: readTarget("Recovery code", { risk: "protected" }), classification: "unknown_secret", permittedMethods: ["input_value"], validation: { minimumLength: 3, maximumLength: 100 } }, 500); expect(result.value).toBe("recovery-123"); } },
  { name: "38 verified Copy control acquisition", run: async (page) => { await set(page, `<div role="group"><output aria-label="Secret">copy-secret</output><button aria-label="Copy secret" onclick="navigator.clipboard.writeText('copy-secret')">Copy secret</button></div>`); const result = await acquireValue(page, { target: readTarget("Secret", { risk: "protected" }), classification: "unknown_secret", permittedMethods: ["copy_control"], validation: { minimumLength: 3, maximumLength: 100, pattern: "^copy-secret$" } }, 1_000); expect(result.value).toBe("copy-secret"); } },
  { name: "39 focused keyboard selection acquisition", run: async (page) => { await set(page, `<input aria-label="One-time code" value="keyboard-secret">`); const result = await acquireValue(page, { target: readTarget("One-time code", { risk: "protected" }), classification: "unknown_secret", permittedMethods: ["focused_keyboard_selection"], validation: { minimumLength: 3, maximumLength: 100 } }, 500); expect(result.value).toBe("keyboard-secret"); } },
  { name: "40 absent Copy control fails without mutation", run: async (page) => { await set(page, `<div role="group"><output aria-label="Secret">uncopied-secret</output></div>`); const result = await acquireValue(page, { target: readTarget("Secret", { risk: "protected" }), classification: "unknown_secret", permittedMethods: ["copy_control"], validation: { minimumLength: 3, maximumLength: 100 } }, 150); expect(result.value).toBeUndefined(); expect(result.diagnostics[0]?.lastFailureCode).toBe("COPY_CONTROL_UNRESOLVED"); } },
  { name: "41 wrong Copy value rejected by validation", run: async (page) => { await set(page, `<div role="group"><output aria-label="Secret">correct-secret</output><button aria-label="Copy secret" onclick="navigator.clipboard.writeText('wrong-value')">Copy secret</button></div>`); const result = await acquireValue(page, { target: readTarget("Secret", { risk: "protected" }), classification: "unknown_secret", permittedMethods: ["copy_control"], validation: { minimumLength: 3, maximumLength: 100, pattern: "^correct-secret$" } }, 200); expect(result.value).toBeUndefined(); expect(result.diagnostics[0]?.lastFailureCode).toBe("VALUE_VALIDATION_FAILED"); } },
  { name: "42 duplicate compatible labels remain ambiguous", run: async (page) => { await set(page, `<button>Continue</button><button>Continue</button>`); await expectCode(resolveTarget(page, target("Continue", { preferredEvidence: evidence("Continue", { roles: ["button"] }), confidence: { requiredFamilies: [], minimum: .35, minimumMargin: .05, minimumFamilyCount: 1 } })), "TARGET_AMBIGUOUS"); } },
  { name: "43 invalid named scope is typed", run: async (page) => { await set(page, `<form aria-label="Actual"><button>Save</button></form>`); await expectCode(resolveTarget(page, target("Save", { scope: { kind: "form", name: "Missing" } })), "TARGET_SCOPE_INVALID"); } },
  { name: "44 empty page has empty inventory", run: async (page) => { await set(page, ``); await expectCode(resolveTarget(page, target("Save")), "CONTROL_INVENTORY_EMPTY"); } },
  { name: "45 display-only label cannot accept text", run: async (page) => { await set(page, `<div>Password</div>`); await expectCode(resolveTarget(page, fillTarget("Password")), "NO_CAPABILITY_COMPATIBLE_CONTROL"); } },
  { name: "46 close scores refuse first-match selection", run: async (page) => { await set(page, `<button aria-label="Save draft">Save</button><button aria-label="Save final">Save</button>`); await expectCode(resolveTarget(page, target("Save", { preferredEvidence: evidence("Save", { roles: ["button"] }), confidence: { requiredFamilies: [], minimum: .35, minimumMargin: .2, minimumFamilyCount: 1 } })), "TARGET_AMBIGUOUS"); } },
  { name: "47 delayed replacement invalidates resolved target", run: async (page) => { await set(page, `<input aria-label="Email">`); const result = await resolveTarget(page, fillTarget("Email")); await page.locator("input").evaluate((input) => setTimeout(() => input.replaceWith(input.cloneNode(true)), 0)); await page.waitForTimeout(20); await expectCode(result.revalidate(), "TARGET_CHANGED_BEFORE_ACTION"); } },
  { name: "48 declared local effect succeeds", run: async (page) => { await set(page, `<button onclick="document.querySelector('output').textContent='Ready'">Run</button><output aria-label="Status"></output>`); await clickGroundedTarget(page, target("Run", { preferredEvidence: evidence("Run", { roles: ["button"] }) })); await expect(verifyExpectedEffect(page, { type: "value_change", target: readTarget("Status"), expected: "Ready" }, page.url(), 500)).resolves.toBeUndefined(); } },
  { name: "49 missing declared effect fails", run: async (page) => { await set(page, `<button>Run</button><output aria-label="Status"></output>`); await expect(verifyExpectedEffect(page, { type: "value_change", target: readTarget("Status"), expected: "Ready" }, page.url(), 150)).rejects.toMatchObject({ code: "EXPECTED_EFFECT_NOT_OBSERVED" }); } },
  { name: "50 low-risk canvas coordinate action", run: async (page) => { await set(page, `<canvas width="200" height="80" role="button" aria-label="Add"></canvas><output></output><script>document.querySelector('canvas').onclick=()=>document.querySelector('output').textContent='canvas-clicked'</script>`); const intent = target("Add", { requiredCapabilities: ["coordinate_action", "pointer_activatable"], preferredEvidence: evidence("Add", { roles: ["button"], visual: { sources: ["icon", "canvas"], icon: "add", protectedUse: false } }), confidence: { requiredFamilies: ["visual"], minimum: .35, minimumMargin: 0, minimumFamilyCount: 2 } }); const result = await clickGroundedTarget(page, intent); expect(result.adapter).toBe("canvas_coordinate"); expect(await page.locator("output").textContent()).toBe("canvas-clicked"); } },
  { name: "51 destructive canvas coordinate action refused", run: async (page) => { await set(page, `<canvas width="200" height="80" role="button" aria-label="Delete"></canvas>`); const intent = target("Delete", { requiredCapabilities: ["coordinate_action", "pointer_activatable"], preferredEvidence: evidence("Delete", { roles: ["button"], visual: { sources: ["icon", "canvas"], icon: "delete", protectedUse: false } }), risk: "destructive" }); await expectCode(resolveTarget(page, intent), "NO_CAPABILITY_COMPATIBLE_CONTROL"); } },
  { name: "52 observer failure is distinct from no candidates", run: async (page) => { await set(page, `<button>Save</button>`); await page.close(); await expectCode(resolveTarget(page, target("Save")), "OBSERVATION_FAILED"); } },
];

describe("52-scenario capability-grounding browser gauntlet", () => {
  beforeAll(async () => {
    server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Grounding Gauntlet</title>"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("gauntlet server unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
    context = await browser.newContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  });
  afterAll(async () => { await context?.close(); await browser?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

  it.each(scenarios)("$name", async ({ run }) => {
    const page = await context.newPage();
    try { await page.goto(origin); await run(page); }
    finally { if (!page.isClosed()) await page.close(); }
  }, 30_000);
});

if (scenarios.length !== 52) throw new Error(`Grounding Gauntlet must contain exactly 52 scenarios; found ${scenarios.length}`);
