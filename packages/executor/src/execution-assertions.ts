import type { Assertion, CurrentAction } from "@scry/contracts";
import {
  requirePraxisSuccess,
  resolveTargetLocator,
  type PraxisConsumerContext,
} from "@scry/praxis";
import type { Page } from "playwright";

import { requirePraxisContext } from "./action-runtime.js";
import type { ExecuteOptions, StepExecutionResult } from "./types.js";

export function initializeSteps(options: ExecuteOptions): StepExecutionResult[] {
  return options.plan.steps.map((step) => ({
    id: step.id,
    title: step.title,
    status: "unevaluated",
    action: { status: "unevaluated" },
    evidence: step.evidence.map((kind) => ({ kind, status: "degraded" as const })),
    assertions: executableAssertions(step.id, step.action, step.assertions).map(
      (assertion, index) => ({ index, type: assertion.type, status: "unevaluated" }),
    ),
    artifacts: [],
  }));
}

export function executableAssertions(
  stepId: string,
  action: CurrentAction,
  assertions: Assertion[],
) {
  if (action.type !== "navigate" || !/^(step-\d+-navigate|visit-\d+)$/.test(stepId))
    return assertions;
  const requested = new URL(action.url, "https://scry.invalid");
  const requestedPath = requested.pathname + requested.search;
  return assertions.filter(
    (assertion) =>
      !(
        assertion.type === "url" &&
        assertion.match === "path" &&
        assertion.expected === requestedPath
      ),
  );
}

export async function executeAssertion(
  page: Page,
  assertion: Assertion,
  baseOrigin: string,
  praxisContext?: PraxisConsumerContext,
  signal: AbortSignal = new AbortController().signal,
) {
  if (assertion.type !== "url" && !(assertion.type === "text" && !assertion.exact)) {
    const expectedEffect =
      assertion.type === "visible"
        ? { type: "visibility_change" as const, target: assertion.target, visible: true }
        : assertion.type === "hidden"
          ? { type: "visibility_change" as const, target: assertion.target, visible: false }
          : assertion.type === "enabled"
            ? { type: "state_change" as const, target: assertion.target, enabled: true }
            : {
                type: "value_change" as const,
                target: assertion.target,
                expected: assertion.expected,
              };
    await requirePraxisSuccess({
      page,
      intent: assertion.target,
      operation: { type: "inspect" },
      expectedEffect,
      context: requirePraxisContext(praxisContext),
      signal,
    });
    return;
  }
  if (assertion.type === "text") {
    const locator = await resolveTargetLocator(page, assertion.target);
    await locator.waitFor({ state: "visible", ...optionalTimeout(assertion.timeoutMs) });
    const actual = (await locator.textContent()) ?? "";
    const matches = assertion.exact
      ? actual.trim() === assertion.expected
      : actual.includes(assertion.expected);
    if (!matches)
      throw new Error(`Expected text "${assertion.expected}", received "${actual.trim()}"`);
    return;
  }
  const actual = new URL(page.url());
  await page.waitForLoadState("domcontentloaded", optionalTimeout(assertion.timeoutMs));
  const expected = new URL(assertion.expected, baseOrigin);
  const matches =
    assertion.match === "exact"
      ? actual.href === expected.href
      : assertion.match === "path"
        ? actual.pathname + actual.search === expected.pathname + expected.search
        : actual.href.includes(assertion.expected);
  if (!matches)
    throw new Error(
      `Expected URL ${assertion.match} "${assertion.expected}", received "${actual.href}"`,
    );
}

export function markRemainingAssertionsUnevaluated(result: StepExecutionResult) {
  for (const assertion of result.assertions) {
    if (assertion.status !== "passed" && assertion.status !== "failed")
      assertion.status = "unevaluated";
  }
}

function optionalTimeout(timeoutMs: number | undefined): { timeout?: number } {
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}
