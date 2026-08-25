import { randomBytes } from "node:crypto";

import type { OperationOutcome } from "@scry/contracts";
import type { ElementHandle, Locator, Page } from "playwright";

import { observationIdentity, PraxisDocumentEpoch, PraxisDocumentIdentity } from "./observation.js";
import { PraxisTargetHandle } from "./observation.js";
import { observePublicValueCandidates } from "./public-value.js";

type SemanticPageContext = NonNullable<OperationOutcome["semanticPageContext"]>;

const MAX_CONTEXT_CONTROLS = 48;
const MAX_CONTEXT_CANDIDATES = 5_000;
const MAX_CONTEXT_CONTAINERS = 48;
const CONTEXT_CONTROL_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=combobox]",
  "[role=dialog]",
  "[role=status]",
  "[role=alert]",
  "[contenteditable=true]",
  "h1",
  "h2",
  "h3",
  "[role=heading]",
  "[role=region][aria-label]",
].join(",");
const CONTEXT_CONTAINER_SELECTOR = [
  "[role=row]",
  "[role=listitem]",
  "tr",
  "li",
  "article",
  "fieldset",
  "[role=group]",
].join(",");

type ContextContainerKind = SemanticPageContext["containers"][number]["kind"];
type ContextContainerEntry = {
  reference: string;
  element: ElementHandle<Element>;
  kind: ContextContainerKind;
  documentIdentity: string;
};

type ContextControlEntry = {
  handle: PraxisTargetHandle;
  locator: Locator;
  locate: () => Promise<Locator | undefined>;
  element: ElementHandle<Element>;
  containers: ContextContainerEntry[];
  capabilities: SemanticPageContext["controls"][number]["capabilities"];
  valueProtected: boolean;
  semanticIdentity: string;
};
const contextControls = new WeakMap<Page, Map<string, ContextControlEntry>>();
const contextContainers = new WeakMap<Page, Map<string, ContextContainerEntry>>();

export function resolveSemanticPageContextControl(page: Page, reference: string) {
  return contextControls.get(page)?.get(reference);
}

export type SemanticPageContextReferenceState = {
  state: "visible" | "hidden" | "absent" | "ambiguous_stale";
  reasonCode:
    | "CONTEXT_REFERENCE_VISIBLE"
    | "CONTEXT_REFERENCE_HIDDEN"
    | "CONTEXT_REFERENCE_ABSENT"
    | "CONTEXT_REFERENCE_UNKNOWN"
    | "CONTEXT_REFERENCE_DOCUMENT_CHANGED"
    | "CONTEXT_REFERENCE_CONTAINER_CHANGED"
    | "CONTEXT_REFERENCE_SEMANTICS_CHANGED"
    | "CONTEXT_REFERENCE_REPLACEMENT_AMBIGUOUS"
    | "CONTEXT_REFERENCE_OBSERVATION_TRUNCATED";
};

/**
 * Observation-only state reconciliation for a host-owned context reference.
 * It never resolves by order or text alone and never performs an interaction.
 */
export async function observeSemanticPageContextReferenceState(
  page: Page,
  reference: string,
): Promise<SemanticPageContextReferenceState> {
  const entry = resolveSemanticPageContextControl(page, reference);
  if (!entry) return { state: "ambiguous_stale", reasonCode: "CONTEXT_REFERENCE_UNKNOWN" };
  const documentIdentity = await PraxisDocumentIdentity.current(page, page.mainFrame()).catch(
    () => null,
  );
  if (documentIdentity !== entry.handle.documentIdentity)
    return { state: "ambiguous_stale", reasonCode: "CONTEXT_REFERENCE_DOCUMENT_CHANGED" };

  const exactAttached = await entry.element
    .evaluate((element) => element.isConnected)
    .catch(() => false);
  const locator = await entry.locate();
  if (exactAttached) {
    if (!locator)
      return { state: "ambiguous_stale", reasonCode: "CONTEXT_REFERENCE_SEMANTICS_CHANGED" };
    return (await locator.isVisible())
      ? { state: "visible", reasonCode: "CONTEXT_REFERENCE_VISIBLE" }
      : { state: "hidden", reasonCode: "CONTEXT_REFERENCE_HIDDEN" };
  }
  if (!(await contextContainersCurrent(entry, false)))
    return { state: "ambiguous_stale", reasonCode: "CONTEXT_REFERENCE_CONTAINER_CHANGED" };

  const candidates = page.locator(CONTEXT_CONTROL_SELECTOR);
  const candidateCount = await candidates.count();
  const examined = Math.min(candidateCount, MAX_CONTEXT_CANDIDATES);
  for (let index = 0; index < examined; index += 1) {
    const candidate = candidates.nth(index);
    if ((await semanticIdentityForLocator(candidate).catch(() => null)) === entry.semanticIdentity)
      return { state: "ambiguous_stale", reasonCode: "CONTEXT_REFERENCE_REPLACEMENT_AMBIGUOUS" };
  }
  if (candidateCount > examined)
    return { state: "ambiguous_stale", reasonCode: "CONTEXT_REFERENCE_OBSERVATION_TRUNCATED" };
  return { state: "absent", reasonCode: "CONTEXT_REFERENCE_ABSENT" };
}

async function semanticIdentityForLocator(locator: Locator) {
  const identity = await locator.evaluate((element) => {
    const html = element as HTMLElement;
    const input = element as HTMLInputElement;
    const tag = element.tagName.toLowerCase();
    const redactedBoundary = Boolean(element.closest('[data-scry-redacted="true"]'));
    const sensitive =
      redactedBoundary ||
      (tag === "input" &&
        (input.type === "password" ||
          ["current-password", "new-password", "one-time-code"].includes(
            input.autocomplete.toLowerCase(),
          ) ||
          input.inputMode === "numeric"));
    const label = "labels" in input && input.labels ? input.labels[0]?.textContent : undefined;
    const role =
      element.getAttribute("role") ||
      (tag === "a"
        ? "link"
        : tag === "button"
          ? "button"
          : tag === "select"
            ? "combobox"
            : ["h1", "h2", "h3"].includes(tag)
              ? "heading"
              : tag === "textarea" || tag === "input"
                ? input.type === "checkbox"
                  ? "checkbox"
                  : input.type === "radio"
                    ? "radio"
                    : "textbox"
                : html.isContentEditable
                  ? "textbox"
                  : "control");
    const safeProtectedLabel = redactedBoundary
      ? ""
      : element.getAttribute("aria-label") || label || "";
    const name = sensitive
      ? safeProtectedLabel || "identity suppressed"
      : element.getAttribute("aria-label") ||
        label ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        html.innerText ||
        element.textContent ||
        "";
    const boundary = element.closest(
      "dialog,[role=dialog],[role=menu],[role=region],[role=form],nav,section,article,form,main,aside",
    );
    const heading = boundary
      ? Array.from(boundary.querySelectorAll("h1,h2,h3,h4,h5,h6")).find(
          (candidate) =>
            candidate.closest(
              "dialog,[role=dialog],[role=menu],[role=region],[role=form],nav,section,article,form,main,aside",
            ) === boundary,
        )
      : undefined;
    const groupSensitive = Boolean(
      boundary?.closest('[data-scry-redacted="true"]') ||
      boundary?.querySelector(
        '[data-scry-redacted="true"],input[type=password],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"]',
      ),
    );
    const group = groupSensitive
      ? ""
      : boundary?.getAttribute("aria-label") || heading?.textContent || "";
    const boundaryRole = boundary?.getAttribute("role") ?? "";
    const boundaryTag = boundary?.tagName.toLowerCase() ?? "";
    const boundaryKind =
      boundaryRole === "dialog" || boundaryTag === "dialog"
        ? "dialog"
        : boundaryRole === "form" || boundaryTag === "form"
          ? "form"
          : boundaryTag === "section" || boundaryTag === "article"
            ? "section"
            : boundaryRole === "region" || ["nav", "main", "aside"].includes(boundaryTag)
              ? "region"
              : undefined;
    const autocomplete = tag === "input" ? input.autocomplete.toLowerCase() : "";
    const semanticPurpose = sensitive
      ? autocomplete === "one-time-code"
        ? "one_time_code"
        : autocomplete === "current-password"
          ? "current_password"
          : autocomplete === "new-password"
            ? "new_password"
            : input.inputMode === "numeric"
              ? "pin"
              : input.type === "password"
                ? "password"
                : "protected_input"
      : null;
    const capabilities = [
      "observe",
      ...(tag === "a" || tag === "button" || ["button", "link", "tab", "menuitem"].includes(role)
        ? ["activate"]
        : []),
      ...(tag === "textarea" ||
      (tag === "input" && !["checkbox", "radio"].includes(input.type)) ||
      html.isContentEditable
        ? ["enter_text"]
        : []),
      ...(["checkbox", "radio", "switch"].includes(role) ? ["toggle"] : []),
      ...(tag === "select" || ["combobox", "listbox"].includes(role) ? ["select_option"] : []),
    ].sort();
    return {
      role,
      name,
      group,
      boundaryKind,
      capabilities,
      semanticPurpose,
      valueProtected: sensitive,
      disabled: Boolean(
        ("disabled" in input && input.disabled) || element.getAttribute("aria-disabled") === "true",
      ),
    };
  });
  return JSON.stringify({
    role: cleanContextText(identity.role, 40),
    name: cleanContextText(identity.name, 160),
    group: cleanContextText(identity.group, 120),
    boundary: identity.boundaryKind
      ? {
          kind: identity.boundaryKind,
          ...(cleanContextText(identity.group, 120)
            ? { name: cleanContextText(identity.group, 120) }
            : {}),
        }
      : null,
    capabilities: identity.capabilities,
    semanticPurpose: identity.semanticPurpose,
    valueProtected: identity.valueProtected,
    disabled: identity.disabled,
  });
}

async function contextContainersCurrent(
  entry: NonNullable<ReturnType<typeof resolveSemanticPageContextControl>>,
  requireControlMembership: boolean,
) {
  for (let index = 0; index < entry.containers.length; index += 1) {
    const container = entry.containers[index]!;
    const attached = await container.element
      .evaluate((element) => element.isConnected)
      .catch(() => false);
    if (!attached) return false;
    const currentKind = await container.element
      .evaluate((element) => {
        const role = element.getAttribute("role");
        const tag = element.tagName.toLowerCase();
        return role === "row" || tag === "tr"
          ? "row"
          : role === "listitem" || tag === "li"
            ? "list_item"
            : tag === "article"
              ? "card"
              : "group";
      })
      .catch(() => null);
    if (currentKind !== container.kind) return false;
    if (requireControlMembership) {
      const containsControl = await container.element
        .evaluate((authority, control) => authority.contains(control), entry.element)
        .catch(() => false);
      if (!containsControl) return false;
    }
    const parent = entry.containers[index + 1];
    if (parent) {
      const containsContainer = await parent.element
        .evaluate((authority, child) => authority.contains(child), container.element)
        .catch(() => false);
      if (!containsContainer) return false;
    }
  }
  return true;
}

async function locateCurrentControl(page: Page, expected: ElementHandle<Element>) {
  const candidates = page.locator(CONTEXT_CONTROL_SELECTOR);
  const count = Math.min(await candidates.count(), MAX_CONTEXT_CANDIDATES);
  for (let index = 0; index < count; index += 1) {
    const locator = candidates.nth(index);
    const current = await locator.elementHandle();
    if (!current) continue;
    const same = await expected
      .evaluate((observed, candidate) => observed === candidate, current)
      .catch(() => false);
    await current.dispose();
    if (same) return locator;
  }
  return undefined;
}

/**
 * Projects one bounded, public semantic interaction surface. This deliberately
 * reuses Praxis' mutation epoch as authority and never reads form values,
 * hidden DOM, request data, or protected descendants.
 */
export async function observeSemanticPageContext(page: Page): Promise<SemanticPageContext> {
  const frame = page.mainFrame();
  const documentEpoch = await PraxisDocumentEpoch.stable(page, frame, new AbortController().signal);
  const documentIdentity = await PraxisDocumentIdentity.current(page, frame);
  const observed = await page.evaluate(
    ({ limit, candidateLimit, selector, containerSelector }) => {
      const allCandidates = Array.from(document.querySelectorAll(selector));
      const candidates = allCandidates.slice(0, candidateLimit);
      const containerCandidates = Array.from(document.querySelectorAll(containerSelector));
      const projected: Array<{
        role: string;
        name: string;
        group?: string;
        boundary?: { kind: "dialog" | "form" | "section" | "region"; name?: string };
        capabilities: string[];
        selected?: boolean;
        expanded?: boolean;
        checked?: boolean;
        disabled?: boolean;
        current?: boolean;
        candidateIndex: number;
        runtimeId: string;
        containerIndices: number[];
        containerRuntimeIds: string[];
        containerKinds: ContextContainerKind[];
        semanticPurpose?: string;
        valueProtected?: boolean;
        inputSources?: Array<"literal" | "protected_reference">;
      }> = [];
      const state = globalThis as typeof globalThis & {
        __scryGroundingIds?: WeakMap<Element, string>;
        __scryGroundingSequence?: number;
      };
      state.__scryGroundingIds ??= new WeakMap();
      state.__scryGroundingSequence ??= 0;
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const element = candidates[candidateIndex]!;
        if (projected.length >= limit) break;
        const html = element as HTMLElement;
        const input = element as HTMLInputElement;
        const style = getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          element.closest('[aria-hidden="true"],[inert]')
        )
          continue;
        const sensitive =
          Boolean(element.closest('[data-scry-redacted="true"]')) ||
          (element.tagName.toLowerCase() === "input" &&
            (input.type === "password" ||
              ["current-password", "new-password", "one-time-code"].includes(
                input.autocomplete.toLowerCase(),
              ) ||
              input.inputMode === "numeric"));
        const redactedBoundary = Boolean(element.closest('[data-scry-redacted="true"]'));
        const tag = element.tagName.toLowerCase();
        let runtimeId = state.__scryGroundingIds.get(element);
        if (!runtimeId) {
          state.__scryGroundingSequence += 1;
          runtimeId = `control-${state.__scryGroundingSequence}`;
          state.__scryGroundingIds.set(element, runtimeId);
        }
        const label = "labels" in input && input.labels ? input.labels[0]?.textContent : undefined;
        const role =
          element.getAttribute("role")?.slice(0, 100) ||
          (tag === "a"
            ? "link"
            : tag === "button"
              ? "button"
              : tag === "select"
                ? "combobox"
                : ["h1", "h2", "h3"].includes(tag)
                  ? "heading"
                  : tag === "textarea" || tag === "input"
                    ? input.type === "checkbox"
                      ? "checkbox"
                      : input.type === "radio"
                        ? "radio"
                        : "textbox"
                    : html.isContentEditable
                      ? "textbox"
                      : "control");
        const safeProtectedLabel = redactedBoundary
          ? ""
          : element.getAttribute("aria-label") || label || "";
        const name = sensitive
          ? safeProtectedLabel || "identity suppressed"
          : (
              element.getAttribute("aria-label") ||
              label ||
              element.getAttribute("title") ||
              element.getAttribute("placeholder") ||
              html.innerText ||
              element.textContent ||
              ""
            ).slice(0, 500);
        if (!name) continue;
        const boundary = element.closest(
          "dialog,[role=dialog],[role=menu],[role=region],[role=form],nav,section,article,form,main,aside",
        );
        const heading = boundary
          ? Array.from(boundary.querySelectorAll("h1,h2,h3,h4,h5,h6")).find(
              (candidate) =>
                candidate.closest(
                  "dialog,[role=dialog],[role=menu],[role=region],[role=form],nav,section,article,form,main,aside",
                ) === boundary,
            )
          : undefined;
        const groupSensitive = Boolean(
          boundary?.closest('[data-scry-redacted="true"]') ||
          boundary?.querySelector(
            '[data-scry-redacted="true"],input[type=password],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"]',
          ),
        );
        const group = groupSensitive
          ? ""
          : (boundary?.getAttribute("aria-label") || heading?.textContent || "").slice(0, 500);
        const boundaryRole = boundary?.getAttribute("role") ?? "";
        const boundaryTag = boundary?.tagName.toLowerCase() ?? "";
        const boundaryKind =
          boundaryRole === "dialog" || boundaryTag === "dialog"
            ? "dialog"
            : boundaryRole === "form" || boundaryTag === "form"
              ? "form"
              : boundaryTag === "section" || boundaryTag === "article"
                ? "section"
                : boundaryRole === "region" || ["nav", "main", "aside"].includes(boundaryTag)
                  ? "region"
                  : undefined;
        const autocomplete = tag === "input" ? input.autocomplete.toLowerCase() : "";
        const semanticPurpose = sensitive
          ? autocomplete === "one-time-code"
            ? "one_time_code"
            : autocomplete === "current-password"
              ? "current_password"
              : autocomplete === "new-password"
                ? "new_password"
                : input.inputMode === "numeric"
                  ? "pin"
                  : input.type === "password"
                    ? "password"
                    : "protected_input"
          : undefined;
        const capabilities = [
          "observe",
          ...(tag === "a" ||
          tag === "button" ||
          ["button", "link", "tab", "menuitem"].includes(role)
            ? ["activate"]
            : []),
          ...(tag === "textarea" ||
          (tag === "input" && !["checkbox", "radio"].includes(input.type)) ||
          html.isContentEditable
            ? ["enter_text"]
            : []),
          ...(["checkbox", "radio", "switch"].includes(role) ? ["toggle"] : []),
          ...(tag === "select" || ["combobox", "listbox"].includes(role) ? ["select_option"] : []),
        ];
        const inputSources: Array<"literal" | "protected_reference"> | undefined =
          capabilities.includes("enter_text")
            ? sensitive
              ? ["protected_reference"]
              : ["literal", "protected_reference"]
            : undefined;
        const selectedAttribute = element.getAttribute("aria-selected");
        const expandedAttribute = element.getAttribute("aria-expanded");
        const pressedAttribute = element.getAttribute("aria-pressed");
        const checkedAttribute = element.getAttribute("aria-checked");
        const containerElements: Element[] = [];
        let ancestor = element.parentElement;
        while (ancestor) {
          if (ancestor.matches(containerSelector)) containerElements.push(ancestor);
          ancestor = ancestor.parentElement;
        }
        const containerIndices = containerElements
          .map((container) => containerCandidates.indexOf(container))
          .filter((index) => index >= 0)
          .slice(0, 4);
        const containerRuntimeIds = containerElements.slice(0, 4).map((container) => {
          let id = state.__scryGroundingIds!.get(container);
          if (!id) {
            state.__scryGroundingSequence! += 1;
            id = `container-${state.__scryGroundingSequence}`;
            state.__scryGroundingIds!.set(container, id);
          }
          return id;
        });
        const containerKinds = containerElements.slice(0, 4).map((container) => {
          const role = container.getAttribute("role");
          const tag = container.tagName.toLowerCase();
          if (role === "row" || tag === "tr") return "row";
          if (role === "listitem" || tag === "li") return "list_item";
          if (tag === "article") return "card";
          return "group";
        }) as ContextContainerKind[];
        const selected = selectedAttribute === null ? undefined : selectedAttribute === "true";
        const expanded = expandedAttribute === null ? undefined : expandedAttribute === "true";
        const pressed = pressedAttribute === null ? undefined : pressedAttribute === "true";
        const ariaChecked = checkedAttribute === null ? undefined : checkedAttribute === "true";
        projected.push({
          candidateIndex,
          runtimeId,
          containerIndices,
          containerRuntimeIds,
          containerKinds,
          role,
          name,
          ...(semanticPurpose ? { semanticPurpose, valueProtected: true } : {}),
          ...(group ? { group } : {}),
          ...(boundaryKind
            ? { boundary: { kind: boundaryKind, ...(group ? { name: group } : {}) } }
            : {}),
          capabilities,
          ...(inputSources ? { inputSources } : {}),
          ...(selected === undefined ? {} : { selected }),
          ...(expanded === undefined ? {} : { expanded }),
          ...(pressed === undefined ? {} : { pressed }),
          ...("checked" in input && ["checkbox", "radio"].includes(input.type)
            ? { checked: Boolean(input.checked) }
            : ariaChecked === undefined
              ? {}
              : { checked: ariaChecked }),
          ...(("disabled" in input && input.disabled) ||
          element.getAttribute("aria-disabled") === "true"
            ? { disabled: true }
            : {}),
          ...(element.getAttribute("aria-current") &&
          element.getAttribute("aria-current") !== "false"
            ? { current: true }
            : {}),
        });
      }
      return {
        title: document.title.slice(0, 500),
        url: `${location.origin}${location.pathname}`,
        observed: allCandidates.length,
        truncated:
          allCandidates.length > candidates.length ||
          (projected.length >= limit && candidates.length > projected.length),
        controls: projected,
        sectionObserved: document.querySelectorAll("h1,h2,h3,[role=heading]").length,
        sections: Array.from(document.querySelectorAll("h1,h2,h3,[role=heading]"))
          .filter(
            (heading) =>
              !heading.closest('[data-scry-redacted="true"],[aria-hidden="true"],[inert]'),
          )
          .slice(0, 12)
          .map((heading) => {
            const parts: string[] = [];
            let sibling = heading.nextElementSibling;
            while (
              sibling &&
              !sibling.matches("h1,h2,h3,[role=heading]") &&
              parts.join(" ").length < 4000
            ) {
              if (!sibling.closest('[data-scry-redacted="true"],[aria-hidden="true"],[inert]')) {
                const safeClone = sibling.cloneNode(true) as HTMLElement;
                safeClone
                  .querySelectorAll(
                    '[data-scry-redacted="true"],[aria-hidden="true"],[inert],script,style',
                  )
                  .forEach((node) => node.remove());
                const text = safeClone.innerText || safeClone.textContent || "";
                if (text.trim()) parts.push(text.trim());
              }
              sibling = sibling.nextElementSibling;
            }
            return {
              heading: (heading.textContent || "").trim(),
              content: parts.join(" ").slice(0, 4000),
            };
          })
          .filter((section) => section.heading && section.content),
      };
    },
    {
      limit: MAX_CONTEXT_CONTROLS,
      candidateLimit: MAX_CONTEXT_CANDIDATES,
      selector: CONTEXT_CONTROL_SELECTOR,
      containerSelector: CONTEXT_CONTAINER_SELECTOR,
    },
  );
  const controls: SemanticPageContext["controls"] = [];
  const registered = new Map<string, ContextControlEntry>();
  const previous = contextControls.get(page);
  const previousContainers = contextContainers.get(page);
  const registeredContainers = new Map<string, ContextContainerEntry>();
  const containerControls = new Map<string, string[]>();
  const controlCandidates = page.locator(CONTEXT_CONTROL_SELECTOR);
  const containerCandidates = page.locator(CONTEXT_CONTAINER_SELECTOR);
  const loadedContainerElements = new Map<number, ElementHandle<Element>>();
  const retainedContainerIndices = new Set<number>();
  for (const control of observed.controls) {
    const role = cleanContextText(control.role, 40);
    const name = cleanContextText(control.name, 160);
    const group = cleanContextText(control.group, 120);
    if (!role || !name) continue;
    const locator = controlCandidates.nth(control.candidateIndex);
    const semanticIdentity = JSON.stringify({
      role,
      name,
      group,
      boundary: control.boundary ?? null,
      capabilities: [...control.capabilities].sort(),
      semanticPurpose: control.semanticPurpose ?? null,
      valueProtected: Boolean(control.valueProtected),
      disabled: Boolean(control.disabled),
    });
    let reference: string | undefined;
    const currentElement = (await locator.elementHandle()) as ElementHandle<Element> | null;
    const currentIdentityMatches = currentElement
      ? await currentElement
          .evaluate((element, runtimeId) => {
            const state = globalThis as typeof globalThis & {
              __scryGroundingIds?: WeakMap<Element, string>;
            };
            return state.__scryGroundingIds?.get(element) === runtimeId;
          }, control.runtimeId)
          .catch(() => false)
      : false;
    if (!currentIdentityMatches) {
      await currentElement?.dispose();
      continue;
    }
    if (previous && currentElement) {
      for (const [candidateReference, entry] of previous) {
        if (
          entry.handle.documentIdentity !== documentIdentity ||
          entry.semanticIdentity !== semanticIdentity
        )
          continue;
        const sameElement = await entry.element
          .evaluate(
            (priorElement, candidateElement) => priorElement === candidateElement,
            currentElement,
          )
          .catch(() => false);
        if (sameElement) {
          reference = candidateReference;
          break;
        }
      }
    }
    if (!currentElement) continue;
    const containers: ContextContainerEntry[] = [];
    for (let index = 0; index < control.containerIndices.length; index += 1) {
      const containerIndex = control.containerIndices[index]!;
      let containerElement = loadedContainerElements.get(containerIndex);
      if (!containerElement) {
        const loaded = (await containerCandidates
          .nth(containerIndex)
          .elementHandle()) as ElementHandle<Element> | null;
        if (!loaded) continue;
        containerElement = loaded;
        loadedContainerElements.set(containerIndex, loaded);
      }
      const containerIdentityMatches = await containerElement
        .evaluate((element, runtimeId) => {
          const state = globalThis as typeof globalThis & {
            __scryGroundingIds?: WeakMap<Element, string>;
          };
          return state.__scryGroundingIds?.get(element) === runtimeId;
        }, control.containerRuntimeIds[index]!)
        .catch(() => false);
      if (!containerIdentityMatches) continue;
      retainedContainerIndices.add(containerIndex);
      const kind = control.containerKinds[index]!;
      let containerReference: string | undefined;
      for (const [candidateReference, entry] of registeredContainers) {
        if (entry.kind !== kind) continue;
        const sameElement = await entry.element
          .evaluate(
            (priorElement, candidateElement) => priorElement === candidateElement,
            containerElement,
          )
          .catch(() => false);
        if (sameElement) {
          containerReference = candidateReference;
          break;
        }
      }
      for (const [candidateReference, entry] of previousContainers ?? []) {
        if (containerReference) break;
        if (entry.documentIdentity !== documentIdentity || entry.kind !== kind) continue;
        const sameElement = await entry.element
          .evaluate(
            (priorElement, candidateElement) => priorElement === candidateElement,
            containerElement,
          )
          .catch(() => false);
        if (sameElement) {
          containerReference = candidateReference;
          break;
        }
      }
      if (!containerReference && registeredContainers.size >= MAX_CONTEXT_CONTAINERS) {
        continue;
      }
      containerReference ??= `context-container-${randomBytes(16).toString("hex")}`;
      const existing = registeredContainers.get(containerReference);
      const container = existing ?? {
        reference: containerReference,
        element: containerElement,
        kind,
        documentIdentity,
      };
      if (!existing) registeredContainers.set(containerReference, container);
      containers.push(container);
    }
    reference ??= `context-control-${randomBytes(16).toString("hex")}`;
    registered.set(reference, {
      handle: new PraxisTargetHandle(page, frame, locator, documentEpoch, documentIdentity),
      locator,
      locate: () => locateCurrentControl(page, currentElement),
      element: currentElement,
      containers,
      capabilities: control.capabilities as SemanticPageContext["controls"][number]["capabilities"],
      valueProtected: Boolean(control.valueProtected),
      semanticIdentity,
    });
    const {
      candidateIndex: _candidateIndex,
      runtimeId: _runtimeId,
      containerIndices: _containerIndices,
      containerRuntimeIds: _containerRuntimeIds,
      containerKinds: _containerKinds,
      ...publicControl
    } = control;
    const projected = {
      ...publicControl,
      role,
      name,
      ...(group ? { group } : {}),
      capabilities: control.capabilities as SemanticPageContext["controls"][number]["capabilities"],
    };
    controls.push({
      ...projected,
      reference,
      ...(containers.length
        ? { containerReferences: containers.map((container) => container.reference) }
        : {}),
    });
    for (const container of containers) {
      const members = containerControls.get(container.reference) ?? [];
      members.push(reference);
      containerControls.set(container.reference, members);
    }
  }
  await Promise.all([
    ...[...loadedContainerElements.entries()].flatMap(([index, element]) =>
      retainedContainerIndices.has(index) ? [] : [element.dispose().catch(() => undefined)],
    ),
    ...[...(previous?.values() ?? [])].map((entry) =>
      entry.element.dispose().catch(() => undefined),
    ),
    ...[...(previousContainers?.values() ?? [])].map((entry) =>
      entry.element.dispose().catch(() => undefined),
    ),
  ]);
  contextControls.set(page, registered);
  contextContainers.set(page, registeredContainers);
  const readableValueObservation = await observePublicValueCandidates(page);
  const pageId = observationIdentity(page, { kind: "page" }, "public", documentEpoch, frame).pageId;
  return {
    schemaVersion: 2,
    readableValues: readableValueObservation.values.map((value) => ({ ...value })),
    readableValueCompleteness: readableValueObservation.completeness,
    authority: {
      pageId,
      documentEpoch,
      url: observed.url,
      title: cleanContextText(observed.title, 200),
      readiness: "stable",
    },
    completeness: {
      kind: "bounded",
      observed: observed.observed,
      returned: controls.length,
      truncated: observed.truncated,
    },
    controls,
    containers: await Promise.all(
      [...registeredContainers.values()].map(async (container) => {
        let parentReference: string | undefined;
        for (const candidate of registeredContainers.values()) {
          if (candidate.reference === container.reference) continue;
          const contains = await candidate.element
            .evaluate((parent, child) => parent.contains(child), container.element)
            .catch(() => false);
          if (contains) {
            parentReference = candidate.reference;
            break;
          }
        }
        return {
          reference: container.reference,
          kind: container.kind,
          controlReferences: containerControls.get(container.reference) ?? [],
          ...(parentReference ? { parentReference } : {}),
        };
      }),
    ),
    containerCompleteness: {
      kind: "bounded",
      observed: new Set(observed.controls.flatMap((control) => control.containerIndices)).size,
      returned: registeredContainers.size,
      truncated:
        new Set(observed.controls.flatMap((control) => control.containerIndices)).size >
        registeredContainers.size,
    },
    sections: observed.sections
      .map((section) => ({
        heading: cleanContextText(section.heading, 200),
        content: cleanContextText(section.content, 4_000),
      }))
      .filter((section) => section.heading && section.content),
    sectionCompleteness: {
      kind: "bounded",
      observed: observed.sectionObserved,
      returned: observed.sections.length,
      truncated: observed.sectionObserved > observed.sections.length,
    },
  };
}

function cleanContextText(value: string | null | undefined, maximum: number) {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}
