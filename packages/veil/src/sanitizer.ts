import { SensitiveValueClassifier } from "./classifier.js";

export interface TextSanitizer {
  sanitize(input: string): string;
}

const MASKED_STRING_KEYS = new Set(["value"]);
const STRUCTURAL_STRING_KEYS = new Set(["tagName", "compatMode"]);
const URL_KEYS = new Set([
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "data",
  "style",
]);
const SAFE_ATTRIBUTE_KEYS = new Set([
  "class",
  "role",
  "type",
  "disabled",
  "checked",
  "selected",
  "readonly",
  "multiple",
  "required",
  "open",
  "hidden",
  "tabindex",
  "colspan",
  "rowspan",
  "width",
  "height",
  "viewbox",
  "xmlns",
]);

function mask(value: unknown): string {
  return "•".repeat(Math.max(3, Math.min(24, String(value ?? "").length)));
}

function sanitizeAttributes(
  value: Record<string, unknown>,
  classifier: TextSanitizer,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("on") || URL_KEYS.has(lower)) continue;
    output[key] =
      SAFE_ATTRIBUTE_KEYS.has(lower) && typeof child === "string"
        ? classifier.sanitize(child)
        : mask(child);
  }
  return output;
}

export function sanitizeReplayValue(value: unknown, classifier: TextSanitizer, key = ""): unknown {
  if (typeof value === "string") {
    const lower = key.toLowerCase();
    if (STRUCTURAL_STRING_KEYS.has(key)) {
      if (key === "tagName") return /^[a-z][a-z0-9-]*$/u.test(value) ? value : "div";
      return value === "CSS1Compat" ? value : "BackCompat";
    }
    if (URL_KEYS.has(lower)) return "";
    if (MASKED_STRING_KEYS.has(key) || lower.startsWith("aria-")) return mask(value);
    return classifier.sanitize(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeReplayValue(item, classifier, key));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (
      childKey === "attributes" &&
      childValue &&
      typeof childValue === "object" &&
      !Array.isArray(childValue)
    ) {
      output[childKey] = sanitizeAttributes(childValue as Record<string, unknown>, classifier);
    } else {
      output[childKey] = sanitizeReplayValue(childValue, classifier, childKey);
    }
  }
  return output;
}

export function sanitizeToolResult(value: unknown, classifier: SensitiveValueClassifier): unknown {
  if (typeof value === "string") return classifier.sanitize(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeToolResult(item, classifier));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sanitizeToolResult(child, classifier)]),
  );
}
