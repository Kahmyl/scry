import type { Readiness, ReadinessCondition } from "@scry/contracts";
import { resolveTargetLocator } from "@scry/praxis";
import type { Page } from "playwright";

type ActiveRequest = { url: string; resourceType: string };

export class ReadinessTimeoutError extends Error {
  constructor(
    readonly stepId: string,
    message: string,
  ) {
    super(`Readiness timed out for step "${stepId}": ${message}`);
    this.name = "ReadinessTimeoutError";
  }
}

export async function executeReadiness(
  page: Page,
  readiness: Readiness,
  baseOrigin: string,
  networkRecords: Array<Record<string, unknown>>,
  activeRequests: Map<string, ActiveRequest>,
  observationStartedAt: number,
) {
  const startedAt = Date.now();
  const execute = (condition: ReadinessCondition) =>
    executeReadinessCondition(
      page,
      condition,
      baseOrigin,
      readiness.timeoutMs,
      startedAt,
      observationStartedAt,
      networkRecords,
      activeRequests,
    );
  if (readiness.mode === "all") {
    await Promise.all(readiness.conditions.map(execute));
    return readiness.conditions.map((condition) => condition.type);
  }
  const winner = await Promise.any(
    readiness.conditions.map(async (condition) => {
      await execute(condition);
      return condition.type;
    }),
  );
  return [winner];
}

export async function stabilizeApplication(
  page: Page,
  activeRequests: Map<string, ActiveRequest>,
  timeoutMs: number,
  quietWindowMs: number,
) {
  const startedAt = Date.now();
  const [domQuiet, networkQuiet] = await Promise.all([
    waitForDomQuiet(page, quietWindowMs, timeoutMs)
      .then(() => true)
      .catch(() => false),
    waitForNetworkQuiet(activeRequests, quietWindowMs, timeoutMs, [])
      .then(() => true)
      .catch(() => false),
  ]);
  const visibleLoader = await page
    .locator('[aria-busy="true"], [role="progressbar"], .loading, .spinner')
    .evaluateAll((elements) =>
      elements.some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }),
    )
    .catch(() => false);
  return {
    method: "dom-and-network" as const,
    durationMs: Date.now() - startedAt,
    domQuiet,
    networkQuiet,
    visibleLoader,
  };
}

async function executeReadinessCondition(
  page: Page,
  condition: ReadinessCondition,
  baseOrigin: string,
  timeoutMs: number,
  startedAt: number,
  observationStartedAt: number,
  networkRecords: Array<Record<string, unknown>>,
  activeRequests: Map<string, ActiveRequest>,
) {
  const remaining = () => Math.max(100, timeoutMs - (Date.now() - startedAt));
  switch (condition.type) {
    case "visible":
      await expectEventually(
        async () => (await resolveTargetLocator(page, condition.target)).isVisible(),
        remaining(),
      );
      return;
    case "hidden":
      await (
        await resolveTargetLocator(page, condition.target)
      ).waitFor({ state: "hidden", timeout: remaining() });
      return;
    case "text":
      await expectEventually(async () => {
        const locator = await resolveTargetLocator(page, condition.target);
        if ((await locator.count()) === 0 || !(await locator.first().isVisible())) return false;
        const actual = ((await locator.first().textContent()) ?? "").trim();
        return condition.exact
          ? actual === condition.expected
          : actual.includes(condition.expected);
      }, remaining());
      return;
    case "value":
      await expectEventually(
        async () =>
          (await (await resolveTargetLocator(page, condition.target)).inputValue()) ===
          condition.expected,
        remaining(),
      );
      return;
    case "checked":
      await expectEventually(
        async () =>
          (await (await resolveTargetLocator(page, condition.target)).isChecked()) ===
          condition.expected,
        remaining(),
      );
      return;
    case "url":
      await expectEventually(async () => {
        const actual = new URL(page.url());
        const expected = new URL(condition.expected, baseOrigin);
        return condition.match === "exact"
          ? actual.href === expected.href
          : condition.match === "path"
            ? actual.pathname + actual.search === expected.pathname + expected.search
            : actual.href.includes(condition.expected);
      }, remaining());
      return;
    case "content":
      await expectEventually(async () => {
        const locator = await resolveTargetLocator(page, condition.target);
        if ((await locator.count()) === 0) return false;
        const snapshot = await locator.first().evaluate((element) => ({
          children: element.childElementCount,
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        }));
        return (
          (condition.minimumChildren === undefined ||
            snapshot.children >= condition.minimumChildren) &&
          (condition.minimumTextLength === undefined ||
            snapshot.text.length >= condition.minimumTextLength) &&
          (condition.requiredText === undefined || snapshot.text.includes(condition.requiredText))
        );
      }, remaining());
      return;
    case "request":
      await expectEventually(
        async () =>
          networkRecords.some(
            (record) =>
              record.type === "response" &&
              String(record.url).includes(condition.urlPattern) &&
              (!condition.method || record.method === condition.method) &&
              Number(record.status) >= condition.status.min &&
              Number(record.status) <= condition.status.max &&
              new Date(String(record.occurredAt)).getTime() >= observationStartedAt,
          ),
        remaining(),
      );
      return;
    case "domStable":
      await waitForDomQuiet(page, condition.quietWindowMs, remaining());
      return;
    case "networkQuiet":
      await waitForNetworkQuiet(
        activeRequests,
        condition.quietWindowMs,
        remaining(),
        condition.ignoreUrlPatterns,
      );
      return;
    case "delay":
      if (condition.durationMs > remaining()) {
        await new Promise((resolve) => setTimeout(resolve, remaining()));
        throw new Error("Fixed delay exceeded the readiness group timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, condition.durationMs));
  }
}

async function waitForDomQuiet(page: Page, quietWindowMs: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let prior = await page.content();
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, quietWindowMs)));
    const current = await page.content();
    if (current !== prior) {
      prior = current;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietWindowMs) return;
  }
  throw new Error("DOM did not become quiet");
}

async function waitForNetworkQuiet(
  activeRequests: Map<string, ActiveRequest>,
  quietWindowMs: number,
  timeoutMs: number,
  ignorePatterns: string[],
) {
  const ignored = [
    ...ignorePatterns,
    "google-analytics",
    "googletagmanager",
    "cloudflareinsights",
    "segment.io",
  ];
  let quietSince: number | undefined;
  await expectEventually(async () => {
    const relevant = [...activeRequests.values()].filter(
      (request) =>
        !["websocket", "eventsource"].includes(request.resourceType) &&
        !ignored.some((pattern) => request.url.includes(pattern)),
    );
    if (relevant.length > 0) {
      quietSince = undefined;
      return false;
    }
    quietSince ??= Date.now();
    return Date.now() - quietSince >= quietWindowMs;
  }, timeoutMs);
}

async function expectEventually(check: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Readiness condition was not satisfied before timeout");
}
