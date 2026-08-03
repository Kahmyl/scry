import { createServer, type Server } from "node:http";

import type { InteractionTargetIntent } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { inspectBrowserRuntimeArtifacts, playwrightBrowserChannel, visualRedactionInitScript } from "../src/browser-runtime-artifacts.js";
import { capturePublicGeneratedValue } from "../src/public-value-capture.js";
import { acquireValue } from "../src/protected-extractor.js";
import { resolveTarget, verifyExpectedEffect } from "../src/grounding.js";
import { clickPraxisTarget as clickGroundedTarget, fillPraxisTarget as fillGroundedTarget } from "./support/praxis-actions.js";

type Scenario = { id: number; name: string; html: string; run(page: Page): Promise<void>; headers?: Record<string, string> };

let server: Server;
let browser: Browser;
let context: BrowserContext;
let origin = "";

const evidence = (name: string, extra: Partial<InteractionTargetIntent["preferredEvidence"]> = {}): InteractionTargetIntent["preferredEvidence"] => ({
  roles: [], names: [name], labels: [name], descriptions: [], placeholders: [name], inputTypes: [], ...extra,
});
const target = (name: string, overrides: Partial<InteractionTargetIntent> = {}): InteractionTargetIntent => ({
  concept: name.toLowerCase().replace(/\W+/g, "_"), requiredCapabilities: ["pointer_activatable"], preferredEvidence: evidence(name),
  scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"], risk: "ordinary",
  confidence: { requiredFamilies: [], minimum: .35, minimumMargin: 0, minimumFamilyCount: 1 }, ...overrides,
});
const readable = (name: string, overrides: Partial<InteractionTargetIntent> = {}) => target(name, {
  requiredCapabilities: ["readable_value"], preferredEvidence: evidence(name, { roles: ["value"] }), risk: "read_only", ...overrides,
});
const editable = (name: string, overrides: Partial<InteractionTargetIntent> = {}) => target(name, {
  requiredCapabilities: ["focusable", "accepts_text", "editable"], preferredEvidence: evidence(name, { roles: ["textbox"] }),
  prohibited: ["hidden", "disabled", "readonly", "display_only_text"], ...overrides,
});
const acquisition = (name: string, methods: Array<"dom_text" | "input_value" | "semantic_field_value" | "copy_control" | "scoped_text_selection" | "focused_keyboard_selection">, validation: { minimumLength: number; maximumLength: number; pattern?: string } = { minimumLength: 1, maximumLength: 100 }, overrides: Partial<InteractionTargetIntent> = {}) => ({
  target: readable(name, { risk: "protected", ...overrides }), classification: "unknown_secret" as const, permittedMethods: methods, validation,
});
const publicAcquisition = (name: string, methods: Array<"dom_text" | "input_value" | "semantic_field_value" | "scoped_text_selection">) => ({
  target: readable(name), classification: "public" as const, permittedMethods: methods, validation: { minimumLength: 1, maximumLength: 100 },
});
const noLeak = (value: unknown, secret: string) => expect(JSON.stringify(value)).not.toContain(secret);
const failureCode = async (promise: Promise<unknown>) => promise.then(() => "resolved", (error: { code?: string }) => error.code ?? "unknown");

const scenarios: Scenario[] = [
  { id: 68, name: "public plain text capture", html: `<output aria-label="Client ID">client-public-68</output>`, run: async p => expect((await capturePublicGeneratedValue(p, publicAcquisition("Client ID", ["dom_text"]), 500)).value).toBe("client-public-68") },
  { id: 69, name: "public input value capture", html: `<input aria-label="Client ID" value="client-public-69">`, run: async p => expect((await capturePublicGeneratedValue(p, publicAcquisition("Client ID", ["input_value"]), 500)).value).toBe("client-public-69") },
  { id: 70, name: "public textarea capture", html: `<textarea aria-label="Public key">public-key-70</textarea>`, run: async p => expect((await capturePublicGeneratedValue(p, publicAcquisition("Public key", ["input_value"]), 500)).value).toBe("public-key-70") },
  { id: 71, name: "public code block capture", html: `<code aria-label="Request ID">request-71</code>`, run: async p => expect((await capturePublicGeneratedValue(p, publicAcquisition("Request ID", ["dom_text"]), 500)).value).toBe("request-71") },
  { id: 72, name: "definition value capture", html: `<dl><dt>Application ID</dt><dd aria-label="Application ID">application-72</dd></dl>`, run: async p => expect((await capturePublicGeneratedValue(p, publicAcquisition("Application ID", ["semantic_field_value"]), 500)).value).toBe("application-72") },
  { id: 73, name: "verified copy control", html: `<div role="group"><output aria-label="Secret">secret-copy-73</output><button aria-label="Copy secret" onclick="navigator.clipboard.writeText('secret-copy-73')">Copy</button></div>`, run: async p => { const secret="secret-copy-73"; const r=await acquireValue(p,acquisition("Secret",["copy_control"],{minimumLength:1,maximumLength:100,pattern:"^secret-copy-73$"}),500); expect(r.value).toBe(secret); noLeak(r.diagnostics,secret); } },
  { id: 74, name: "wrong copied value rejected", html: `<div role="group"><output aria-label="Secret">secret-right-74</output><button aria-label="Copy secret" onclick="navigator.clipboard.writeText('secret-wrong-74')">Copy</button></div>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["copy_control"],{minimumLength:1,maximumLength:100,pattern:"^secret-right-74$"}),180); expect(r.value).toBeUndefined(); expect(r.diagnostics[0]?.lastFailureCode).toBe("VALUE_VALIDATION_FAILED"); noLeak(r.diagnostics,"secret-wrong-74"); } },
  { id: 75, name: "missing copy control is typed", html: `<div role="group"><output aria-label="Secret">secret-75</output></div>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["copy_control"]),150); expect(r.value).toBeUndefined(); expect(r.diagnostics[0]?.lastFailureCode).toBe("COPY_CONTROL_UNRESOLVED"); noLeak(r.diagnostics,"secret-75"); } },
  { id: 76, name: "highlight plain text acquisition", html: `<div aria-label="One-time token">secret-select-76</div>`, run: async p => { const secret="secret-select-76"; const r=await acquireValue(p,acquisition("One-time token",["scoped_text_selection"]),500); expect(r.value).toBe(secret); noLeak(r.diagnostics,secret); expect(await p.evaluate(()=>getSelection()?.toString())).toBe(""); } },
  { id: 77, name: "keyboard selected input acquisition", html: `<input aria-label="Recovery code" value="secret-keyboard-77">`, run: async p => { const secret="secret-keyboard-77"; const r=await acquireValue(p,acquisition("Recovery code",["focused_keyboard_selection"]),500); expect(r.value).toBe(secret); noLeak(r.diagnostics,secret); } },
  { id: 78, name: "acquisition trims outer whitespace", html: `<output aria-label="Secret">  secret-trim-78  </output>`, run: async p => expect((await acquireValue(p,acquisition("Secret",["dom_text"]),500)).value).toBe("secret-trim-78") },
  { id: 79, name: "minimum length validation", html: `<output aria-label="Secret">x</output>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["dom_text"],{minimumLength:4,maximumLength:100}),150); expect(r.value).toBeUndefined(); expect(r.diagnostics[0]?.lastFailureCode).toBe("VALUE_VALIDATION_FAILED"); } },
  { id: 80, name: "maximum length validation", html: `<output aria-label="Secret">secret-too-long-80</output>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["dom_text"],{minimumLength:1,maximumLength:5}),150); expect(r.value).toBeUndefined(); noLeak(r.diagnostics,"secret-too-long-80"); } },
  { id: 81, name: "pattern validation", html: `<output aria-label="Secret">invalid-secret-81</output>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["dom_text"],{minimumLength:1,maximumLength:100,pattern:"^vtr_[a-z0-9]+$"}),150); expect(r.value).toBeUndefined(); noLeak(r.diagnostics,"invalid-secret-81"); } },
  { id: 82, name: "approved method fallback", html: `<div role="group"><output aria-label="Secret">secret-fallback-82</output></div>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["copy_control","semantic_field_value"]),500); expect(r.value).toBe("secret-fallback-82"); expect(r.diagnostics[0]?.lastFailureCode).toBe("COPY_CONTROL_UNRESOLVED"); noLeak(r.diagnostics,"secret-fallback-82"); } },
  { id: 83, name: "unapproved methods are not attempted", html: `<output aria-label="Secret">secret-method-83</output>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["copy_control"]),150); expect(r.value).toBeUndefined(); expect(r.diagnostics).toHaveLength(1); noLeak(r.diagnostics,"secret-method-83"); } },
  { id: 84, name: "secret absent from acquisition diagnostics", html: `<output aria-label="Secret">secret-diagnostic-84</output>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["semantic_field_value"]),500); expect(r.value).toBe("secret-diagnostic-84"); noLeak(r.diagnostics,"secret-diagnostic-84"); } },
  { id: 85, name: "clipboard cleared after acquisition", html: `<div role="group"><output aria-label="Secret">secret-clipboard-85</output><button aria-label="Copy secret" onclick="navigator.clipboard.writeText('secret-clipboard-85')">Copy</button></div>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["copy_control"]),500); expect(r.value).toBe("secret-clipboard-85"); expect(await p.evaluate(()=>navigator.clipboard.readText())).toBe(""); } },
  { id: 86, name: "selection cleared after acquisition", html: `<div aria-label="Secret">secret-selection-86</div>`, run: async p => { await acquireValue(p,acquisition("Secret",["scoped_text_selection"]),500); expect(await p.evaluate(()=>getSelection()?.rangeCount)).toBe(0); } },
  { id: 87, name: "hidden protected value rejected", html: `<output aria-label="Secret" style="display:none">secret-hidden-87</output>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["dom_text"]),150); expect(r.value).toBeUndefined(); noLeak(r.diagnostics,"secret-hidden-87"); } },
  { id: 88, name: "duplicate protected values are ambiguous", html: `<output aria-label="Secret">secret-a-88</output><output aria-label="Secret">secret-b-88</output>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["dom_text"]),150); expect(r.value).toBeUndefined(); expect(r.diagnostics[0]?.lastFailureCode).toBe("TARGET_AMBIGUOUS"); noLeak(r.diagnostics,"secret-a-88"); noLeak(r.diagnostics,"secret-b-88"); } },
  { id: 89, name: "dialog scope selects protected value", html: `<output aria-label="Secret">stale-secret-89</output><dialog open aria-label="Generated credential"><output aria-label="Secret">secret-dialog-89</output></dialog>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["dom_text"],undefined,{scope:{kind:"dialog",name:"Generated credential"}}),500); expect(r.value).toBe("secret-dialog-89"); noLeak(r.diagnostics,"secret-dialog-89"); } },
  { id: 90, name: "delayed protected value settles", html: `<output aria-label="Secret"></output><script>setTimeout(()=>document.querySelector('output').textContent='secret-delay-90',100)</script>`, run: async p => { const r=await acquireValue(p,acquisition("Secret",["dom_text"]),800); expect(r.value).toBe("secret-delay-90"); noLeak(r.diagnostics,"secret-delay-90"); } },
  { id: 91, name: "iframe document is grounded through its owning frame", html: `<iframe src="/child-91"></iframe>`, run: async p => { const result=await resolveTarget(p,target("Inside iframe")); expect(await result.locator.textContent()).toBe("Inside iframe"); expect(result.frame).not.toBe(p.mainFrame()); } },
  { id: 92, name: "strict CSP permits browser observation", headers: { "content-security-policy": "default-src 'self'; script-src 'none'; style-src 'none'" }, html: `<button aria-label="Continue">Continue</button>`, run: async p => expect((await resolveTarget(p,target("Continue",{preferredEvidence:evidence("Continue",{roles:["button"]})}))).locator).toBeDefined() },
  { id: 93, name: "low risk canvas coordinate action", html: `<canvas width="200" height="80" role="button" aria-label="Add"></canvas><output></output><script>document.querySelector('canvas').onclick=()=>document.querySelector('output').textContent='added'</script>`, run: async p => { const r=await clickGroundedTarget(p,target("Add",{requiredCapabilities:["coordinate_action","pointer_activatable"],preferredEvidence:evidence("Add",{roles:["button"],visual:{sources:["icon","canvas"],icon:"add",protectedUse:false}}),confidence:{requiredFamilies:["visual"],minimum:.35,minimumMargin:0,minimumFamilyCount:2}})); expect(r.adapter).toBe("canvas_coordinate"); expect(await p.locator("output").textContent()).toBe("added"); } },
  { id: 94, name: "destructive canvas action refused", html: `<canvas width="200" height="80" role="button" aria-label="Delete"></canvas>`, run: async p => expect(await failureCode(resolveTarget(p,target("Delete",{requiredCapabilities:["coordinate_action","pointer_activatable"],preferredEvidence:evidence("Delete",{roles:["button"],visual:{sources:["canvas"],icon:"delete",protectedUse:false}}),risk:"destructive"})))).toBe("NO_CAPABILITY_COMPATIBLE_CONTROL") },
  { id: 95, name: "runtime artifacts are healthy", html: `<main>runtime</main>`, run: async () => expect(inspectBrowserRuntimeArtifacts({privacyInjection:visualRedactionInitScript})).toMatchObject({healthy:true,diagnostics:[]}) },
  { id: 96, name: "runtime artifact forbids helper", html: `<main>runtime</main>`, run: async () => expect(inspectBrowserRuntimeArtifacts({broken:"(()=>__name(function x(){},'x'))()"})).toMatchObject({healthy:false,diagnostics:[expect.objectContaining({code:"BROWSER_RUNTIME_FREE_VARIABLE"})]}) },
  { id: 97, name: "observer closure is typed", html: `<button>Save</button>`, run: async p => { await p.close(); expect(await failureCode(resolveTarget(p,target("Save")))).toBe("OBSERVATION_FAILED"); } },
  { id: 98, name: "declared effect observed", html: `<button onclick="document.querySelector('output').textContent='Ready'">Run</button><output aria-label="Status"></output>`, run: async p => { const before=p.url(); await clickGroundedTarget(p,target("Run",{preferredEvidence:evidence("Run",{roles:["button"]})})); await expect(verifyExpectedEffect(p,{type:"value_change",target:readable("Status"),expected:"Ready"},before,500)).resolves.toBeUndefined(); } },
  { id: 99, name: "missing declared effect typed", html: `<button>Run</button><output aria-label="Status"></output>`, run: async p => expect(await failureCode(verifyExpectedEffect(p,{type:"value_change",target:readable("Status"),expected:"Ready"},p.url(),120))).toBe("EXPECTED_EFFECT_NOT_OBSERVED") },
  { id: 100, name: "full login and acquisition journey", html: `<form aria-label="Sign in"><div>Email</div><input placeholder="Email"><div>Password</div><input type="password" placeholder="Password"><button type="button" onclick="document.querySelector('form').hidden=true;document.querySelector('main').hidden=false">Login</button></form><main hidden><output aria-label="Client ID">client-100</output><output aria-label="Secret">secret-full-100</output></main>`, run: async p => { const email=await fillGroundedTarget(p,editable("Email",{scope:{kind:"form",name:"Sign in"},preferredEvidence:evidence("Email",{roles:["textbox"],placeholders:["Email"]})}),"test@example.invalid"); const password=await fillGroundedTarget(p,editable("Password",{scope:{kind:"form",name:"Sign in"},preferredEvidence:evidence("Password",{roles:["textbox"],placeholders:["Password"],inputTypes:["password"]}),risk:"authentication"}),"known-secret-input-100"); await clickGroundedTarget(p,target("Login",{scope:{kind:"form",name:"Sign in"},preferredEvidence:evidence("Login",{roles:["button"]})})); expect((await capturePublicGeneratedValue(p,publicAcquisition("Client ID",["dom_text"]),500)).value).toBe("client-100"); const secret=await acquireValue(p,acquisition("Secret",["semantic_field_value"]),500); expect(secret.value).toBe("secret-full-100"); noLeak({email,password,diagnostics:secret.diagnostics},"known-secret-input-100"); noLeak({email,password,diagnostics:secret.diagnostics},"secret-full-100"); } },
];

describe("production HTTP capability cohort C (068-100)", () => {
  beforeAll(async () => {
    server=createServer((request,response)=>{ const url=new URL(request.url??"/","http://fixture"); if(url.pathname==="/child-91"){response.setHeader("content-type","text/html");response.end(`<!doctype html><button>Inside iframe</button>`);return;} const scenario=scenarios.find(item=>item.id===Number(url.pathname.slice(1))); if(!scenario){response.writeHead(404).end();return;} for(const [name,value] of Object.entries(scenario.headers??{}))response.setHeader(name,value); response.setHeader("content-type","text/html; charset=utf-8"); response.end(`<!doctype html><meta charset="utf-8"><title>${scenario.id}</title>${scenario.html}`); });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address(); if(!address||typeof address==="string")throw new Error("fixture server unavailable"); origin=`http://127.0.0.1:${address.port}`;
    const channel=playwrightBrowserChannel(process.env.SCRY_BROWSER_CHANNEL);
    browser=await chromium.launch(channel?{headless:true,channel}:{headless:true});
    context=await browser.newContext(); await context.grantPermissions(["clipboard-read","clipboard-write"],{origin});
  });
  afterAll(async()=>{await context?.close();await browser?.close();await new Promise<void>(resolve=>server?.close(()=>resolve()));});
  it.each(scenarios)("$id $name",async scenario=>{const page=await context.newPage();try{await page.goto(`${origin}/${scenario.id}`,{waitUntil:"domcontentloaded"});await scenario.run(page);}finally{if(!page.isClosed())await page.close();}},15_000);
});

if(scenarios.length!==33)throw new Error(`Cohort C must contain exactly 33 scenarios; found ${scenarios.length}`);
