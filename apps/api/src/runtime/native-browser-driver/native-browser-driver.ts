import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { ExpectedEffect, InteractionTargetIntent, SemanticScope } from "@scry/contracts";
import { isPrivateAddress } from "@scry/policy";
import {
  NativeControlResolutionError,
} from "@scry/executor";
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type ElementHandle,
  type Locator,
  type Page,
} from "playwright";
import {
  blockedThirdPartyScriptOrigins,
  closePraxisBrowserResources,
  navigateAndWaitNative,
  openPraxisBrowserServerSession,
  waitForDocumentSurface,
  waitForPraxisURL,
} from "@scry/praxis";

@Injectable()
export class NativeBrowserDriver {
  async openBrowser(
    options: BrowserContextOptions = {},
    owner: { kind: "safe_browser" | "protected_capsule" | "runtime_browser"; ownerId: string } = {
      kind: "runtime_browser",
      ownerId: randomUUID(),
    },
  ) {
    return openPraxisBrowserServerSession(options, owner);
  }

  async closeBrowser(browser: Browser, context: BrowserContext) {
    await closePraxisBrowserResources(context, browser);
  }

  async navigateAndWait(
    page: Page,
    url: string,
    allowedOrigins: Iterable<string>,
    timeout = 30_000,
    trustedScriptOrigins: Iterable<string> = [],
  ) {
    await navigateAndWaitNative(page, url, allowedOrigins, timeout, trustedScriptOrigins);
  }

  async sameOriginRequest(
    page: Page,
    request: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: Record<string, string | number | boolean | null>;
      expectedStatus: { min: number; max: number };
      timeoutMs?: number;
    },
    allowedOrigins: string[],
    beforeDispatch?: () => Promise<void>,
  ) {
    const pageUrl = new URL(page.url());
    const url = new URL(request.path, pageUrl);
    if (url.origin !== pageUrl.origin || !allowedOrigins.includes(url.origin)) {
      throw new NativeError("NATIVE_SAME_ORIGIN_REQUEST_DENIED");
    }
    const cookies = await page.context().cookies(url.origin);
    const token = cookies.find((cookie) => ["token", "access_token", "auth_token", "jwt"].includes(cookie.name))?.value;
    await beforeDispatch?.();
    const response = await page.context().request.fetch(url.href, {
      method: request.method,
      ...(request.body === undefined ? {} : { data: request.body }),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
    });
    const status = response.status();
    await response.dispose();
    if (status < request.expectedStatus.min || status > request.expectedStatus.max) {
      throw new NativeError("NATIVE_SAME_ORIGIN_STATUS_UNEXPECTED");
    }
    return { status, classification: "expected" as const };
  }

  async verifyExpectedEffect(page: Page, effect: ExpectedEffect, beforeUrl: string, timeoutMs: number) {
    if (effect.type === "none") return;
    if (effect.type === "navigation") {
      await waitForPraxisURL(page, (url) => {
        if (!effect.url) return url.href !== beforeUrl;
        return effect.match === "exact" ? url.href === effect.url :
          effect.match === "path" ? url.pathname === new URL(effect.url).pathname : url.href.includes(effect.url);
      }, { timeout: timeoutMs });
      return;
    }
    if (effect.type === "network_outcome") return;
    if (effect.type === "new_page") {
      if (page.url() === beforeUrl || (effect.origin && new URL(page.url()).origin !== new URL(effect.origin).origin)) {
        throw new NativeError("EXPECTED_NEW_PAGE_NOT_OBSERVED");
      }
      return;
    }
    if (effect.type === "new_region") {
      await this.waitForSemanticState(page, effect.target, "visible", timeoutMs);
      return;
    }
    if (effect.type === "visibility_change" && effect.visible) {
      await this.waitForSemanticState(page, effect.target, "visible", timeoutMs);
      return;
    }
    const target = await this.resolveSemanticTarget(page, effect.target, timeoutMs);
    if (effect.type === "visibility_change") {
      if ((await target.isVisible()) !== effect.visible) throw new NativeError("NATIVE_EXPECTED_EFFECT_NOT_OBSERVED");
      return;
    }
    if (effect.type === "value_change") {
      if (effect.expected !== undefined) {
        const value = await target.evaluate((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value : element.textContent ?? "");
        if (value !== effect.expected) throw new NativeError("NATIVE_EXPECTED_EFFECT_NOT_OBSERVED");
      }
      return;
    }
    if (effect.checked !== undefined && (await target.isChecked()) !== effect.checked)
      throw new NativeError("NATIVE_EXPECTED_EFFECT_NOT_OBSERVED");
    if (effect.enabled !== undefined && (await target.isEnabled()) !== effect.enabled)
      throw new NativeError("NATIVE_EXPECTED_EFFECT_NOT_OBSERVED");
  }

  async resolveSemanticTarget(page: Page, intent: InteractionTargetIntent, waitTimeoutMs = 0) {
    const candidates = await semanticCandidateLocators(page, intent, false);
    const deadline = performance.now() + waitTimeoutMs;
    do {
      const eligible = await eligibleSemanticMatches(candidates, intent, false);
      if (eligible.size === 1) return eligible.values().next().value!;
      if (eligible.size > 1) throw new NativeControlResolutionError("NATIVE_TARGET_AMBIGUOUS");
      if (performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    if (blockedThirdPartyScriptOrigins(page).length) {
      throw trustedScriptOriginRequired(page);
    }
    throw new NativeControlResolutionError("NATIVE_TARGET_NOT_FOUND");
  }

  async executeSemanticControl(
    page: Page,
    intent: InteractionTargetIntent,
    operation:
      | { type: "click"; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number }
      | { type: "fill"; value: string; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number; protected: boolean }
      | { type: "select"; value: string; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number }
      | { type: "check"; checked: boolean; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number }
      | { type: "press"; key: string; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number }
      | { type: "scroll"; deltaY: number; preDispatchDeadlineAt?: number }
      | { type: "waitFor"; state: "visible" | "hidden" | "attached" | "detached"; timeoutMs?: number; preDispatchDeadlineAt?: number },
    beforeDispatch?: () => Promise<void>,
  ) {
    if (operation.type === "waitFor") {
      await this.waitForSemanticState(
        page,
        intent,
        operation.state,
        remainingActionTime(operation, operation.timeoutMs ?? 10_000),
      );
      return;
    }
    const target = await this.resolveSemanticTarget(
      page,
      intent,
      "resolutionTimeoutMs" in operation
        ? remainingActionTime(
            operation,
            operation.resolutionTimeoutMs ?? operation.timeoutMs ?? 10_000,
          )
        : 10_000,
    );
    const literalFillTarget = operation.type === "fill" && !operation.protected
      ? await target.elementHandle({ timeout: "resolutionTimeoutMs" in operation
        ? remainingActionTime(operation, operation.resolutionTimeoutMs ?? operation.timeoutMs ?? 10_000)
        : 10_000 })
      : null;
    if (literalFillTarget) await assertPublicLiteralTarget(literalFillTarget);
    if ("preDispatchDeadlineAt" in operation) assertPreDispatchDeadline(operation);
    await beforeDispatch?.();
    if ("preDispatchDeadlineAt" in operation) assertPreDispatchDeadline(operation);
    const timeout = "timeoutMs" in operation
      ? { timeout: remainingActionTime(operation, operation.timeoutMs ?? 10_000) }
      : {};
    switch (operation.type) {
      case "click": await target.click(timeout); return;
      case "fill":
        if (operation.protected) await maskProtectedTarget(target);
        if (literalFillTarget) {
          await assertPublicLiteralTarget(literalFillTarget);
          await literalFillTarget.fill(operation.value, timeout);
        } else await target.fill(operation.value, timeout);
        return;
      case "select": await target.selectOption(operation.value, timeout); return;
      case "check": await target.setChecked(operation.checked, timeout); return;
      case "press": await target.press(operation.key, timeout); return;
      case "scroll": await target.evaluate((element, deltaY) => element.scrollBy(0, deltaY), operation.deltaY); return;
    }
  }

  private async waitForSemanticState(
    page: Page,
    intent: InteractionTargetIntent,
    state: "visible" | "hidden" | "attached" | "detached",
    timeoutMs: number,
  ) {
    const candidates = await semanticCandidateLocators(page, intent, true);
    const deadline = performance.now() + timeoutMs;
    do {
      const matches = [...(await eligibleSemanticMatches(candidates, intent, true)).values()];
      const satisfied = state === "visible"
        ? (await Promise.all(matches.map((match) => match.isVisible()))).some(Boolean)
        : state === "attached"
          ? matches.length > 0
          : state === "hidden"
            ? !(await Promise.all(matches.map((match) => match.isVisible()))).some(Boolean)
            : matches.length === 0;
      if (satisfied) return;
      if (performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    if (blockedThirdPartyScriptOrigins(page).length) {
      throw trustedScriptOriginRequired(page);
    }
    throw new NativeControlResolutionError("NATIVE_TARGET_NOT_FOUND");
  }
}

async function semanticCandidateLocators(
  page: Page,
  intent: InteractionTargetIntent,
  stateObservation: boolean,
) {
  const root = await semanticScopeRoot(page, intent.scope);
  const candidates: Locator[] = [];
  const exact = intent.matching !== "non_exact";
  for (const role of intent.preferredEvidence.roles) {
    for (const name of intent.preferredEvidence.names) {
      if (role === "text") candidates.push(root.getByText(name, { exact }));
      else if (role === "field")
        candidates.push(root.getByRole("textbox", { name, exact, includeHidden: stateObservation }));
      else if (role === "value")
        candidates.push(root.locator("output,dd,input,textarea").filter({ hasText: name }));
      else candidates.push(root.getByRole(role, { name, exact, includeHidden: stateObservation }));
    }
  }
  for (const label of intent.preferredEvidence.labels) candidates.push(root.getByLabel(label, { exact }));
  for (const placeholder of intent.preferredEvidence.placeholders)
    candidates.push(root.getByPlaceholder(placeholder, { exact }));
  for (const testId of intent.preferredEvidence.testIds ?? []) candidates.push(root.getByTestId(testId));
  if (intent.preferredEvidence.expectedText)
    candidates.push(root.getByText(intent.preferredEvidence.expectedText, { exact }));
  return candidates;
}

async function eligibleSemanticMatches(
  candidates: readonly Locator[],
  intent: InteractionTargetIntent,
  stateObservation: boolean,
) {
  const eligible = new Map<string, Locator>();
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = 0; index < count; index += 1) {
      const element = candidate.nth(index);
      if (!stateObservation && intent.prohibited.includes("hidden") && !(await element.isVisible())) continue;
      if (intent.prohibited.includes("disabled") && !(await element.isEnabled())) continue;
      if (intent.prohibited.includes("readonly") && (await element.getAttribute("readonly")) !== null) continue;
      if (!(await supportsRequiredCapabilities(element, intent))) continue;
      eligible.set(await nativeElementIdentity(element), element);
    }
  }
  return eligible;
}

async function nativeElementIdentity(locator: Locator) {
  return locator.evaluate((element) => {
    const scope = globalThis as typeof globalThis & {
      __scryNativeCandidateIds?: WeakMap<Element, number>;
      __scryNativeCandidateNextId?: number;
    };
    const ids = scope.__scryNativeCandidateIds ??= new WeakMap<Element, number>();
    const existing = ids.get(element);
    if (existing !== undefined) return String(existing);
    const next = (scope.__scryNativeCandidateNextId ?? 0) + 1;
    scope.__scryNativeCandidateNextId = next;
    ids.set(element, next);
    return String(next);
  });
}

async function supportsRequiredCapabilities(locator: Locator, intent: InteractionTargetIntent) {
  const capabilities = new Set(intent.requiredCapabilities);
  const requestsInteractiveCapability = ["focusable", "pointer_activatable", "keyboard_activatable", "submittable", "toggleable", "selects_option", "accepts_text", "editable"].some((capability) => capabilities.has(capability as never));
  if (requestsInteractiveCapability && intent.preferredEvidence.roles.includes("text")) return false;
  const facts = await locator.evaluate((element) => {
    const html = element as HTMLElement;
    const input = element as HTMLInputElement;
    return {
      tag: element.tagName.toLowerCase(),
      type: input.type?.toLowerCase(),
      role: element.getAttribute("role"),
      contentEditable: html.isContentEditable,
      tabIndex: html.tabIndex,
      href: element.getAttribute("href"),
    };
  });
  const text = facts.tag === "textarea" || facts.tag === "input" || facts.contentEditable;
  const interactiveRole = ["button", "link", "menuitem", "checkbox", "radio", "tab", "combobox", "listbox", "option"].includes(facts.role ?? "");
  const focusable = facts.tabIndex >= 0 || text || facts.tag === "select" || facts.tag === "button" || (facts.tag === "a" && Boolean(facts.href)) || interactiveRole;
  const pointer = facts.tag === "button" || facts.tag === "select" || facts.tag === "input" || facts.tag === "textarea" || (facts.tag === "a" && Boolean(facts.href)) || interactiveRole;
  const keyboard = focusable && pointer;
  const toggle = (facts.tag === "input" && ["checkbox", "radio"].includes(facts.type)) ||
    ["checkbox", "radio", "switch"].includes(facts.role ?? "");
  const select = facts.tag === "select" || ["combobox", "listbox"].includes(facts.role ?? "");
  const submittable = (facts.tag === "button" && (!facts.type || facts.type === "submit")) ||
    (facts.tag === "input" && facts.type === "submit");
  const readable = pointer || text || facts.tag === "select" || ["output", "dd", "meter", "progress", "p", "span", "div", "h1", "h2", "h3", "h4", "h5", "h6"].includes(facts.tag) ||
    ["status", "alert", "region", "textbox", "heading", "text"].includes(facts.role ?? "");
  const observable = facts.tag.length > 0;
  return (!capabilities.has("observable") || observable) &&
    (!capabilities.has("accepts_text") && !capabilities.has("editable") || text) &&
    (!capabilities.has("focusable") || focusable) &&
    (!capabilities.has("pointer_activatable") || pointer) &&
    (!capabilities.has("keyboard_activatable") || keyboard) &&
    (!capabilities.has("toggleable") || toggle) &&
    (!capabilities.has("selects_option") || select) &&
    (!capabilities.has("submittable") || submittable) &&
    (!capabilities.has("readable_value") || readable);
}

class NativeError extends Error {
  constructor(readonly code: string, readonly safeEnvironmentFailure?: {
    missingTrustedScriptOrigins: string[];
    missingOriginClassification: "public" | "redacted";
  }) { super(code); }
}

function trustedScriptOriginRequired(page: Page) {
  const blocked = blockedThirdPartyScriptOrigins(page);
  const publicOrigins = blocked.filter(isSafelyDisclosablePublicOrigin).sort();
  return new NativeError("ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED", {
    missingTrustedScriptOrigins: publicOrigins,
    missingOriginClassification: publicOrigins.length === blocked.length ? "public" : "redacted",
  });
}

function isSafelyDisclosablePublicOrigin(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (url.protocol !== "https:" || hostname === "localhost" || !hostname.includes(".") ||
        [".localhost", ".local", ".internal", ".lan", ".home", ".test", ".example", ".invalid"]
          .some((suffix) => hostname.endsWith(suffix))) return false;
    return !isIP(hostname) || !isPrivateAddress(hostname);
  } catch { return false; }
}

export { waitForDocumentSurface };

async function semanticScopeRoot(page: Page, scope: SemanticScope): Promise<Page | Locator> {
  const parent = scope.within ? await semanticScopeRoot(page, scope.within) : page;
  switch (scope.kind) {
    case "page": return parent;
    case "dialog": return parent.getByRole("dialog", scope.name ? { name: scope.name, exact: true } : {});
    case "form": return scope.name ? parent.getByRole("form", { name: scope.name, exact: true }) : parent.locator("form");
    case "section": return structuralSectionRoot(parent, scope.name!);
    case "table": return parent.getByRole("table", scope.name ? { name: scope.name, exact: true } : {});
    case "row": return scope.name ? parent.getByRole("row", { name: scope.name, exact: true }) : parent.getByRole("row");
    case "region": return parent.getByRole("region", scope.name ? { name: scope.name, exact: true } : {});
    case "live_region":
      return scope.name
        ? parent.locator('[aria-live], [role="status"], [role="alert"]').filter({ hasText: scope.name })
        : parent.locator('[aria-live], [role="status"], [role="alert"]');
    case "field_group": return scope.name ? parent.getByRole("group", { name: scope.name, exact: true }) : parent.getByRole("group");
    case "recently_changed": throw new NativeControlResolutionError("NATIVE_SCOPE_UNSAFE");
  }
}

async function structuralSectionRoot(parent: Page | Locator, name: string): Promise<Locator> {
  // A visible heading is the authoritative section anchor. Generic exact text
  // is only a fallback for markup without a heading; combining both sets makes
  // a navigation link and its corresponding section heading falsely ambiguous.
  const visibleMatches = async (candidate: Locator) => {
    const visible = new Map<string, Locator>();
    for (let index = 0; index < await candidate.count(); index += 1) {
      const anchor = candidate.nth(index);
      if (await anchor.isVisible()) visible.set(await nativeElementIdentity(anchor), anchor);
    }
    return visible;
  };
  const headings = await visibleMatches(parent.getByRole("heading", { name, exact: true }));
  const visible = headings.size > 0
    ? headings
    : await visibleMatches(parent.getByText(name, { exact: true }));
  if (visible.size !== 1) {
    throw new NativeControlResolutionError("NATIVE_SECTION_SCOPE_AMBIGUOUS");
  }
  return visible.values().next().value!.locator(
    "xpath=ancestor-or-self::*[self::section or self::article or self::li or @role='row' or contains(concat(' ', normalize-space(@class), ' '), ' card ')][1]",
  );
}

async function maskProtectedTarget(target: Locator) {
  await target.evaluate((element) => {
    element.setAttribute("data-scry-redacted", "true");
    (element as HTMLElement).style.setProperty("-webkit-text-security", "disc");
  });
}

async function assertPublicLiteralTarget(target: ElementHandle<HTMLElement | SVGElement>) {
  const protectedTarget = await target.evaluate((element) =>
    Boolean(element.closest('[data-scry-redacted="true"]')) ||
    (element instanceof HTMLInputElement &&
      (element.type === "password" ||
        ["current-password", "new-password", "one-time-code"].includes(element.autocomplete.toLowerCase()) ||
        element.inputMode === "numeric")),
  );
  if (protectedTarget) throw new NativeError("PROTECTED_INPUT_REFERENCE_REQUIRED");
}

function remainingActionTime(
  operation: { preDispatchDeadlineAt?: number },
  maximum: number,
) {
  if (operation.preDispatchDeadlineAt === undefined) return maximum;
  const remaining = operation.preDispatchDeadlineAt - performance.now();
  if (remaining <= 0) throw new NativeError("NATIVE_ACTION_DEADLINE_EXCEEDED");
  return Math.max(1, Math.min(maximum, remaining));
}

function assertPreDispatchDeadline(operation: { preDispatchDeadlineAt?: number }) {
  remainingActionTime(operation, Number.MAX_SAFE_INTEGER);
}
