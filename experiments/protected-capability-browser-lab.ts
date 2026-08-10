import { performance } from "node:perf_hooks";

import playwright from "../packages/executor/node_modules/playwright/index.js";
import type { InteractionTargetIntent } from "../packages/contracts/src/index.js";
import { resolveTarget } from "../packages/praxis/src/grounding.js";

type Capability = InteractionTargetIntent["requiredCapabilities"][number];
type Scenario = {
  name: string;
  html: string;
  role?: InteractionTargetIntent["preferredEvidence"]["roles"][number];
  scope?: InteractionTargetIntent["scope"];
  action: Capability[];
  verification?: Capability[];
  expected: "executable" | "boundary";
};

const scenarios: Scenario[] = [
  { name: "native text input", html: `<label>Name<input></label>`, role: "textbox", action: ["focusable", "accepts_text", "editable"], verification: ["readable_value"], expected: "executable" },
  { name: "password input", html: `<label>Password<input type=password></label>`, role: "textbox", action: ["focusable", "accepts_text", "editable"], verification: ["readable_value"], expected: "executable" },
  { name: "textarea", html: `<label>Notes<textarea></textarea></label>`, role: "textbox", action: ["focusable", "accepts_text", "editable"], verification: ["readable_value"], expected: "executable" },
  { name: "content editable", html: `<div role=textbox aria-label=Biography contenteditable=true></div>`, role: "textbox", action: ["focusable", "accepts_text", "editable"], verification: ["readable_value"], expected: "executable" },
  { name: "readonly input", html: `<label>Account<input readonly value=existing></label>`, role: "textbox", action: ["focusable", "accepts_text", "editable"], verification: ["readable_value"], expected: "boundary" },
  { name: "hidden duplicate ignored", html: `<input aria-label=Email hidden><input aria-label=Email>`, role: "textbox", action: ["focusable", "accepts_text", "editable"], verification: ["readable_value"], expected: "executable" },
  { name: "dialog scoped field", html: `<input aria-label=Name><dialog open aria-label='Credential ceremony'><input aria-label=Name></dialog>`, role: "textbox", scope: { kind: "dialog", name: "Credential ceremony" }, action: ["focusable", "accepts_text", "editable"], verification: ["readable_value"], expected: "executable" },
  { name: "split duplicate capabilities", html: `<input aria-label=Credential><input aria-label=Credential readonly value=existing>`, role: "textbox", action: ["focusable", "accepts_text", "editable"], verification: ["readable_value"], expected: "boundary" },
  { name: "native select", html: `<label>Environment<select><option>Test</option></select></label>`, role: "combobox", action: ["focusable", "selects_option"], verification: ["readable_value"], expected: "executable" },
  { name: "custom combobox", html: `<div role=combobox tabindex=0 aria-label=Environment>Test</div>`, role: "combobox", action: ["focusable", "selects_option"], verification: ["readable_value"], expected: "executable" },
  { name: "native checkbox state", html: `<label>Remember<input type=checkbox></label>`, role: "checkbox", action: ["focusable", "toggleable"], verification: ["readable_value"], expected: "boundary" },
  { name: "ARIA checkbox state", html: `<div role=checkbox tabindex=0 aria-label=Remember aria-checked=false>Remember</div>`, role: "checkbox", action: ["focusable", "toggleable"], verification: ["readable_value"], expected: "executable" },
  { name: "button activation", html: `<button>Generate</button>`, role: "button", action: ["focusable", "pointer_activatable"], expected: "executable" },
  { name: "link activation", html: `<a href=#done>Open</a>`, role: "link", action: ["focusable", "pointer_activatable"], expected: "executable" },
  { name: "table row activation", html: `<table><tr role=link tabindex=0><td>Application</td><td>Test</td></tr></table>`, role: "link", action: ["focusable", "pointer_activatable"], expected: "executable" },
  { name: "duplicate activation", html: `<button>Generate</button><button>Generate</button>`, role: "button", action: ["focusable", "pointer_activatable"], expected: "boundary" },
];

const browser = await playwright.chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
const context = await browser.newContext();
const results = [];
try {
  for (const scenario of scenarios) {
    const page = await context.newPage();
    const started = performance.now();
    try {
      await page.setContent(scenario.html);
      const action = await probe(page, intent(scenario, scenario.action));
      const verification = scenario.verification
        ? await probe(page, intent(scenario, scenario.verification))
        : { resolved: true, reasonCode: "NOT_REQUIRED", fingerprint: undefined };
      const merged = scenario.verification
        ? await probe(page, intent(scenario, union(scenario.action, scenario.verification)))
        : action;
      const sameIdentity = !action.fingerprint || !verification.fingerprint || action.fingerprint === verification.fingerprint;
      const negotiated = action.resolved && verification.resolved && sameIdentity ? "executable" : "boundary";
      results.push({
        name: scenario.name,
        expected: scenario.expected,
        negotiated,
        action: { resolved: action.resolved, reasonCode: action.reasonCode },
        verification: { resolved: verification.resolved, reasonCode: verification.reasonCode },
        merged: { resolved: merged.resolved, reasonCode: merged.reasonCode },
        identityStable: sameIdentity,
        durationMs: performance.now() - started,
      });
    } finally {
      await page.close();
    }
  }
} finally {
  await context.close();
  await browser.close();
}

const mismatches = results.filter((result) => result.expected !== result.negotiated);
const serialized = JSON.stringify(results);
if (/(selector|xpath|runtimeId|fingerprint|browserHandle|outerHTML|innerHTML|plaintext|credentialValue)/i.test(serialized))
  throw new Error("BROWSER_LAB_FORBIDDEN_IMPLEMENTATION_DETAIL");
process.stdout.write(`${JSON.stringify({
  outcome: mismatches.length ? "BROWSER_CAPABILITY_LAB_MISMATCH" : "BROWSER_CAPABILITY_LAB_COMPLETE",
  scenarios: results.length,
  matchedExpectations: results.length - mismatches.length,
  mismatches: mismatches.map((result) => result.name),
  results,
  latencyMs: latency(results.map((result) => result.durationMs)),
}, null, 2)}\n`);
if (mismatches.length) process.exitCode = 1;

function intent(scenario: Scenario, requiredCapabilities: Capability[]): InteractionTargetIntent {
  return {
    concept: scenario.name,
    requiredCapabilities,
    preferredEvidence: {
      roles: scenario.role ? [scenario.role] : [],
      names: [label(scenario.name)], labels: [label(scenario.name)],
      descriptions: [], placeholders: [], inputTypes: [],
    },
    scope: scenario.scope ?? { kind: "page" },
    relations: [], prohibited: ["hidden", "disabled"], risk: "ordinary",
    confidence: { requiredFamilies: [], minimum: 0.35, minimumMargin: 0, minimumFamilyCount: 1 },
  };
}

async function probe(page: Parameters<typeof resolveTarget>[0], target: InteractionTargetIntent) {
  try {
    const resolved = await resolveTarget(page, target);
    return { resolved: true, reasonCode: "RESOLVED", fingerprint: resolved.diagnostic.selectedFingerprint?.digest };
  } catch (error) {
    return { resolved: false, reasonCode: safeCode(error), fingerprint: undefined };
  }
}

function label(name: string) {
  const labels: Record<string, string> = {
    "native text input": "Name", "password input": "Password", textarea: "Notes",
    "content editable": "Biography", "readonly input": "Account", "hidden duplicate ignored": "Email",
    "dialog scoped field": "Name", "split duplicate capabilities": "Credential",
    "native select": "Environment", "custom combobox": "Environment",
    "native checkbox state": "Remember", "ARIA checkbox state": "Remember",
    "button activation": "Generate", "link activation": "Open",
    "table row activation": "Application Test", "duplicate activation": "Generate",
  };
  return labels[name] ?? name;
}
function safeCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "UNKNOWN_REFUSAL";
}
function union(left: Capability[], right: Capability[]): Capability[] {
  return [...new Set([...left, ...right])];
}
function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0 };
}
