import { createHash } from "node:crypto";

import type { OperationOutcome } from "@scry/contracts";
import type { Page } from "playwright";

import { observationIdentity, PraxisDocumentEpoch } from "./observation.js";

type SemanticPageContext = NonNullable<OperationOutcome["semanticPageContext"]>;

const MAX_CONTEXT_CONTROLS = 48;

/**
 * Projects one bounded, public semantic interaction surface. This deliberately
 * reuses Praxis' mutation epoch as authority and never reads form values,
 * hidden DOM, request data, or protected descendants.
 */
export async function observeSemanticPageContext(page: Page): Promise<SemanticPageContext> {
  const frame = page.mainFrame();
  const documentEpoch = await PraxisDocumentEpoch.stable(page, frame, new AbortController().signal);
  const observed = await page.evaluate((limit) => {
    const selector = [
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
    }> = [];
    const seen = new Set<string>();
    for (const element of candidates) {
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
        (element.tagName.toLowerCase() === "input" && input.type === "password");
      const tag = element.tagName.toLowerCase();
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
      const name = sensitive
        ? "identity suppressed"
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
      const key = `${role}\u0000${name}\u0000${group}`;
      if (seen.has(key)) continue;
      seen.add(key);
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
      const selectedAttribute = element.getAttribute("aria-selected");
      const expandedAttribute = element.getAttribute("aria-expanded");
      const checkedAttribute = element.getAttribute("aria-checked");
      const selected = selectedAttribute === null ? undefined : selectedAttribute === "true";
      const expanded = expandedAttribute === null ? undefined : expandedAttribute === "true";
      const ariaChecked = checkedAttribute === null ? undefined : checkedAttribute === "true";
      projected.push({
        role,
        name,
        ...(group ? { group } : {}),
        capabilities,
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
    };
  }, MAX_CONTEXT_CONTROLS);
  const controls: SemanticPageContext["controls"] = [];
  const seen = new Set<string>();
  for (const control of observed.controls) {
    const role = cleanContextText(control.role, 40);
    const name = cleanContextText(control.name, 160);
    const group = cleanContextText(control.group, 120);
    if (!role || !name) continue;
    const key = `${role}\u0000${name}\u0000${group}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const projected = {
      ...control,
      role,
      name,
      ...(group ? { group } : {}),
      capabilities: control.capabilities as SemanticPageContext["controls"][number]["capabilities"],
    };
    controls.push({
      ...projected,
      reference: `context-control-${createHash("sha256")
        .update(JSON.stringify({ documentEpoch, ...projected }))
        .digest("hex")
        .slice(0, 16)}`,
    });
  }
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
