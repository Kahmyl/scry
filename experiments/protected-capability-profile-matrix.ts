import { performance } from "node:perf_hooks";

import playwright from "../packages/executor/node_modules/playwright/index.js";
import type { InteractionTargetIntent } from "../packages/contracts/src/index.js";
import { resolveTarget } from "../packages/praxis/src/grounding.js";

type Capability = InteractionTargetIntent["requiredCapabilities"][number];
type Family = "fill" | "select" | "check" | "activate";
type Variant = "clean" | "hidden_noise" | "disabled_noise" | "readonly_noise" | "ambiguous" | "incompatible";
type Case = {
  id: string;
  family: Family;
  html: string;
  name: string;
  role: InteractionTargetIntent["preferredEvidence"]["roles"][number];
  scope: InteractionTargetIntent["scope"];
  capabilities: Capability[];
  shouldResolve: boolean;
};

const wrappers = [
  (value: string) => value,
  (value: string) => `<div>${value}</div>`,
  (value: string) => `<main><section>${value}</section></main>`,
  (value: string) => `<div><section><div>${value}</div></section></div>`,
];
const scopes: Array<{ wrap(value: string): string; scope: InteractionTargetIntent["scope"] }> = [
  { wrap: (value) => value, scope: { kind: "page" } },
  { wrap: (value) => `<dialog open aria-label="Credential ceremony">${value}</dialog>`, scope: { kind: "dialog", name: "Credential ceremony" } },
  { wrap: (value) => `<section aria-label="API access">${value}</section>`, scope: { kind: "section", name: "API access" } },
  { wrap: (value) => `<table><tr aria-label="Application account"><td>${value}</td></tr></table>`, scope: { kind: "row", name: "Application account" } },
];
const variants: Variant[] = ["clean", "hidden_noise", "disabled_noise", "readonly_noise", "ambiguous", "incompatible"];
const families: Array<{ family: Family; role: Case["role"]; name: string; capabilities: Capability[]; control: string; incompatible: string }> = [
  {
    family: "fill", role: "textbox", name: "Credential name",
    capabilities: ["focusable", "accepts_text", "editable", "readable_value"],
    control: `<input aria-label="Credential name">`,
    incompatible: `<input aria-label="Credential name" readonly value="existing">`,
  },
  {
    family: "fill", role: "textbox", name: "Description",
    capabilities: ["focusable", "accepts_text", "editable", "readable_value"],
    control: `<textarea aria-label="Description"></textarea>`,
    incompatible: `<textarea aria-label="Description" readonly>existing</textarea>`,
  },
  {
    family: "fill", role: "textbox", name: "Biography",
    capabilities: ["focusable", "accepts_text", "editable", "readable_value"],
    control: `<div role="textbox" aria-label="Biography" contenteditable="true" style="min-height:1px">Biography</div>`,
    incompatible: `<div role="textbox" aria-label="Biography">existing</div>`,
  },
  {
    family: "select", role: "combobox", name: "Environment",
    capabilities: ["focusable", "selects_option", "readable_value"],
    control: `<select aria-label="Environment"><option>Test</option></select>`,
    incompatible: `<div aria-label="Environment">Test</div>`,
  },
  {
    family: "select", role: "combobox", name: "Region",
    capabilities: ["focusable", "selects_option", "readable_value"],
    control: `<div role="combobox" tabindex="0" aria-label="Region">EU</div>`,
    incompatible: `<div role="combobox" aria-label="Region">EU</div>`,
  },
  {
    family: "check", role: "checkbox", name: "Remember",
    capabilities: ["focusable", "toggleable"],
    control: `<input type="checkbox" aria-label="Remember">`,
    incompatible: `<span aria-label="Remember">Remember</span>`,
  },
  {
    family: "check", role: "checkbox", name: "Enabled",
    capabilities: ["focusable", "toggleable"],
    control: `<div role="checkbox" tabindex="0" aria-label="Enabled" aria-checked="false">Enabled</div>`,
    incompatible: `<div aria-label="Enabled">Enabled</div>`,
  },
  {
    family: "activate", role: "button", name: "Generate",
    capabilities: ["focusable", "pointer_activatable"],
    control: `<button aria-label="Generate">Generate</button>`,
    incompatible: `<span aria-label="Generate">Generate</span>`,
  },
  {
    family: "activate", role: "link", name: "Credentials",
    capabilities: ["focusable", "pointer_activatable"],
    control: `<a href="#credentials" aria-label="Credentials">Credentials</a>`,
    incompatible: `<span aria-label="Credentials">Credentials</span>`,
  },
  {
    family: "activate", role: "link", name: "Application Test Active",
    capabilities: ["focusable", "pointer_activatable"],
    control: `<table><tr role="link" tabindex="0" aria-label="Application Test Active"><td>Application</td><td>Test</td><td>Active</td></tr></table>`,
    incompatible: `<div aria-label="Application Test Active">Application Test Active</div>`,
  },
];

const cases: Case[] = [];
let ordinal = 0;
for (const family of families) {
  for (const wrapper of wrappers) {
    for (const scoped of scopes) {
      for (const variant of variants) {
        ordinal += 1;
        const { html, shouldResolve } = markup(family, variant);
        cases.push({
          id: String(ordinal).padStart(4, "0"), family: family.family,
          html: scoped.wrap(wrapper(html)), name: family.name, role: family.role,
          scope: scoped.scope, capabilities: family.capabilities, shouldResolve,
        });
      }
    }
  }
}

const browser = await playwright.chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
const context = await browser.newContext();
const page = await context.newPage();
const results: Array<{ id: string; family: Family; expected: boolean; resolved: boolean; guardedResolved: boolean; reasonCode: string; durationMs: number }> = [];
try {
  for (const scenario of cases) {
    const started = performance.now();
    await page.setContent(scenario.html);
    try {
      await resolveTarget(page, intent(scenario));
      const guardedResolved = scenario.family !== "activate" || await strictProtectedCardinality(page, scenario) === 1;
      results.push({ id: scenario.id, family: scenario.family, expected: scenario.shouldResolve, resolved: true, guardedResolved, reasonCode: guardedResolved ? "RESOLVED" : "PROTECTED_TARGET_NOT_UNIQUE", durationMs: performance.now() - started });
    } catch (error) {
      results.push({ id: scenario.id, family: scenario.family, expected: scenario.shouldResolve, resolved: false, guardedResolved: false, reasonCode: safeCode(error), durationMs: performance.now() - started });
    }
  }
} finally {
  await page.close();
  await context.close();
  await browser.close();
}

const baselineFailures = results.filter((result) => result.expected !== result.resolved);
const failures = results.filter((result) => result.expected !== result.guardedResolved);
const serialized = JSON.stringify(results);
if (/(selector|xpath|runtimeId|fingerprint|browserHandle|outerHTML|innerHTML|plaintext|credentialValue)/i.test(serialized))
  throw new Error("PROFILE_MATRIX_FORBIDDEN_IMPLEMENTATION_DETAIL");
const report = {
  outcome: failures.length ? "CAPABILITY_PROFILE_MATRIX_FAILED" : "CAPABILITY_PROFILE_MATRIX_PASSED",
  cases: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  observedPassRate: (results.length - failures.length) / results.length,
  baselineWithoutProtectedCardinality: {
    passed: results.length - baselineFailures.length,
    failed: baselineFailures.length,
    observedPassRate: (results.length - baselineFailures.length) / results.length,
  },
  byFamily: Object.fromEntries((["fill", "select", "check", "activate"] as const).map((family) => {
    const sample = results.filter((result) => result.family === family);
    return [family, { cases: sample.length, passed: sample.filter((result) => result.expected === result.guardedResolved).length }];
  })),
  refusals: counts(results.filter((result) => !result.resolved).map((result) => result.reasonCode)),
  latencyMs: latency(results.map((result) => result.durationMs)),
  failures: failures.map((failure) => ({ id: failure.id, family: failure.family, reasonCode: failure.reasonCode })),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

function markup(family: typeof families[number], variant: Variant) {
  if (variant === "clean") return { html: family.control, shouldResolve: true };
  if (variant === "hidden_noise") return { html: `${hidden(family.control)}${family.control}`, shouldResolve: true };
  if (variant === "disabled_noise") return { html: `${disable(family.control)}${family.control}`, shouldResolve: true };
  if (variant === "readonly_noise") return { html: `${family.incompatible}${family.control}`, shouldResolve: true };
  if (variant === "ambiguous") return { html: `${family.control}${family.control}`, shouldResolve: false };
  return { html: family.incompatible, shouldResolve: false };
}
function hidden(value: string) { return `<div hidden>${value}</div>`; }
function disable(value: string) {
  if (value.startsWith("<input") || value.startsWith("<select") || value.startsWith("<button")) return value.replace(">", " disabled>");
  return `<div hidden>${value}</div>`;
}
function intent(scenario: Case): InteractionTargetIntent {
  return {
    concept: `${scenario.family} profile`, requiredCapabilities: scenario.capabilities,
    preferredEvidence: { roles: [scenario.role], names: [scenario.name], labels: [scenario.name], descriptions: [], placeholders: [], inputTypes: [] },
    scope: scenario.scope, relations: [], prohibited: ["hidden", "disabled", ...(scenario.family === "fill" ? ["readonly" as const, "display_only_text" as const] : [])],
    risk: scenario.family === "activate" ? "protected" : "ordinary",
    confidence: { requiredFamilies: [] },
  };
}
async function strictProtectedCardinality(page: import("playwright").Page, scenario: Case) {
  let scope: import("playwright").Locator = page.locator("body");
  if (scenario.scope.kind === "dialog") scope = page.getByRole("dialog", { name: scenario.scope.name });
  else if (scenario.scope.kind === "section") scope = page.getByRole("region", { name: scenario.scope.name });
  else if (scenario.scope.kind === "row") scope = page.getByRole("row", { name: scenario.scope.name });
  const candidates = scope.getByRole(scenario.role as "button" | "link", { name: scenario.name, exact: true });
  let eligible = 0;
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) eligible += 1;
  }
  return eligible;
}
function safeCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "UNKNOWN_REFUSAL";
}
function counts(values: string[]) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((candidate) => candidate === value).length]));
}
function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) ?? 0 };
}
