import { randomBytes } from "node:crypto";

import type { OperationOutcome } from "@scry/contracts";
import type { Locator, Page } from "playwright";

import { observationIdentity, PraxisDocumentEpoch, PraxisDocumentIdentity } from "./observation.js";
import { PraxisTargetHandle } from "./observation.js";

type SemanticPageContext = NonNullable<OperationOutcome["semanticPageContext"]>;

const MAX_CONTEXT_CONTROLS = 48;
const CONTEXT_CONTROL_SELECTOR = [
  "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "[role=button]",
  "[role=link]", "[role=tab]", "[role=menuitem]", "[role=switch]", "[role=checkbox]",
  "[role=radio]", "[role=combobox]", "[role=dialog]", "[role=status]", "[role=alert]",
  "[contenteditable=true]", "h1", "h2", "h3", "[role=heading]", "[role=region][aria-label]",
].join(",");

type ContextControlEntry = {
  handle: PraxisTargetHandle;
  locator: Locator;
  runtimeId: string;
  capabilities: SemanticPageContext["controls"][number]["capabilities"];
  valueProtected: boolean;
  semanticIdentity: string;
};
const contextControls = new WeakMap<Page, Map<string, ContextControlEntry>>();

export function resolveSemanticPageContextControl(page: Page, reference: string) {
  return contextControls.get(page)?.get(reference);
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
  const observed = await page.evaluate(({ limit, selector }) => {
    const candidates = Array.from(document.querySelectorAll(selector));
    const projected: Array<{
      role: string;
      name: string;
      group?: string;
      capabilities: string[];
      selected?: boolean;
      expanded?: boolean;
      checked?: boolean;
      disabled?: boolean;
      current?: boolean;
      candidateIndex: number;
      runtimeId: string;
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
            ["current-password", "new-password", "one-time-code"].includes(input.autocomplete.toLowerCase()) ||
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
        "[role=dialog],[role=menu],[role=region],nav,section,form,main",
      );
      const heading = boundary?.querySelector("h1,h2,h3,h4,h5,h6");
      const groupSensitive = Boolean(boundary?.closest('[data-scry-redacted="true"]'));
      const group = groupSensitive
        ? ""
        : (boundary?.getAttribute("aria-label") || heading?.textContent || "").slice(0, 500);
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
      ];
      const inputSources: Array<"literal" | "protected_reference"> | undefined = capabilities.includes("enter_text")
        ? sensitive
          ? ["protected_reference"]
          : ["literal", "protected_reference"]
        : undefined;
      const selectedAttribute = element.getAttribute("aria-selected");
      const expandedAttribute = element.getAttribute("aria-expanded");
      const checkedAttribute = element.getAttribute("aria-checked");
      const selected = selectedAttribute === null ? undefined : selectedAttribute === "true";
      const expanded = expandedAttribute === null ? undefined : expandedAttribute === "true";
      const ariaChecked = checkedAttribute === null ? undefined : checkedAttribute === "true";
      projected.push({
        candidateIndex,
        runtimeId,
        role,
        name,
        ...(semanticPurpose ? { semanticPurpose, valueProtected: true } : {}),
        ...(group ? { group } : {}),
        capabilities,
        ...(inputSources ? { inputSources } : {}),
        ...(selected === undefined ? {} : { selected }),
        ...(expanded === undefined ? {} : { expanded }),
        ...("checked" in input && ["checkbox", "radio"].includes(input.type)
          ? { checked: Boolean(input.checked) }
          : ariaChecked === undefined
            ? {}
            : { checked: ariaChecked }),
        ...(("disabled" in input && input.disabled) ||
        element.getAttribute("aria-disabled") === "true"
          ? { disabled: true }
          : {}),
        ...(element.getAttribute("aria-current") && element.getAttribute("aria-current") !== "false"
          ? { current: true }
          : {}),
      });
    }
    return {
      title: document.title.slice(0, 500),
      url: `${location.origin}${location.pathname}`,
      observed: candidates.length,
      truncated: projected.length >= limit && candidates.length > projected.length,
      controls: projected,
      sectionObserved: document.querySelectorAll("h1,h2,h3,[role=heading]").length,
      sections: Array.from(document.querySelectorAll("h1,h2,h3,[role=heading]"))
        .filter((heading) => !heading.closest('[data-scry-redacted="true"],[aria-hidden="true"],[inert]'))
        .slice(0, 12)
        .map((heading) => {
          const parts: string[] = [];
          let sibling = heading.nextElementSibling;
          while (sibling && !sibling.matches("h1,h2,h3,[role=heading]") && parts.join(" ").length < 4000) {
            if (!sibling.closest('[data-scry-redacted="true"],[aria-hidden="true"],[inert]')) {
              const safeClone = sibling.cloneNode(true) as HTMLElement;
              safeClone.querySelectorAll('[data-scry-redacted="true"],[aria-hidden="true"],[inert],script,style').forEach((node) => node.remove());
              const text = safeClone.innerText || safeClone.textContent || "";
              if (text.trim()) parts.push(text.trim());
            }
            sibling = sibling.nextElementSibling;
          }
          return { heading: (heading.textContent || "").trim(), content: parts.join(" ").slice(0, 4000) };
        })
        .filter((section) => section.heading && section.content),
    };
  }, { limit: MAX_CONTEXT_CONTROLS, selector: CONTEXT_CONTROL_SELECTOR });
  const controls: SemanticPageContext["controls"] = [];
  const registered = new Map<string, ContextControlEntry>();
  const previous = contextControls.get(page);
  for (const control of observed.controls) {
    const role = cleanContextText(control.role, 40);
    const name = cleanContextText(control.name, 160);
    const group = cleanContextText(control.group, 120);
    if (!role || !name) continue;
    const locator = page.locator(CONTEXT_CONTROL_SELECTOR).nth(control.candidateIndex);
    const semanticIdentity = JSON.stringify({
      role, name, group, capabilities: [...control.capabilities].sort(),
      semanticPurpose: control.semanticPurpose ?? null,
      valueProtected: Boolean(control.valueProtected),
      disabled: Boolean(control.disabled),
    });
    let reference: string | undefined;
    const currentElement = await locator.elementHandle();
    if (previous && currentElement) {
      for (const [candidateReference, entry] of previous) {
        if (
          entry.handle.documentIdentity !== documentIdentity ||
          entry.semanticIdentity !== semanticIdentity
        ) continue;
        const sameElement = await entry.locator
          .evaluate((priorElement, candidateElement) => priorElement === candidateElement, currentElement)
          .catch(() => false);
        if (sameElement) {
          reference = candidateReference;
          break;
        }
      }
    }
    await currentElement?.dispose();
    reference ??= `context-control-${randomBytes(16).toString("hex")}`;
    registered.set(reference, {
      handle: new PraxisTargetHandle(page, frame, locator, documentEpoch, documentIdentity),
      locator,
      runtimeId: control.runtimeId,
      capabilities: control.capabilities as SemanticPageContext["controls"][number]["capabilities"],
      valueProtected: Boolean(control.valueProtected),
      semanticIdentity,
    });
    const { candidateIndex: _candidateIndex, runtimeId: _runtimeId, ...publicControl } = control;
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
    });
  }
  contextControls.set(page, registered);
  const pageId = observationIdentity(page, { kind: "page" }, "public", documentEpoch, frame).pageId;
  return {
    schemaVersion: 1,
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
    sections: observed.sections.map((section) => ({
      heading: cleanContextText(section.heading, 200),
      content: cleanContextText(section.content, 4_000),
    })).filter((section) => section.heading && section.content),
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
