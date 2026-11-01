import { SensitiveValueClassifier } from "./classifier.js";

/** Narrow best-effort protection for access secrets, not blanket masking of
 * ordinary email/business content. Raw message copies are not retained. */
export function protectTestMessage(value: unknown) {
  const text = JSON.stringify(value);
  const candidates: Array<{ kind: "code" | "link"; value: string }> = [];
  const add = (kind: "code" | "link", value: string) => {
    if (!candidates.some((c) => c.value === value) && candidates.length < 20)
      candidates.push({ kind, value });
  };
  const collectCodes = (item: unknown): void => {
    if (Array.isArray(item)) item.forEach(collectCodes);
    else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (
          /^(?:(?:verification|authentication|security|login|one[-_ ]?time|recovery)[-_ ]?code|otp)$/i.test(
            key,
          ) &&
          /^(?:\d{4,8})$/.test(String(child))
        )
          add("code", String(child));
        else collectCodes(child);
      }
    }
  };
  collectCodes(value);
  for (const match of text.matchAll(
    /\b(?:verification|authentication|security|login|one[- ]time|otp|recovery)\s*(?:code|password)?\s*(?:is|:|=|-)?\s*(\d{4,8})\b/gi,
  ))
    add("code", match[1]!);
  for (const match of text.matchAll(/https?:\/\/[^\s"<>\\]+/gi)) {
    try {
      const url = new URL(match[0].replaceAll("&amp;", "&"));
      if (
        [...url.searchParams.keys()].some((key) => /token|secret|code|key|ticket/i.test(key)) ||
        /\/(?:invite|verify|reset|activate|confirm)[^?]*\/[a-z0-9_-]{12,}/i.test(url.pathname)
      )
        add("link", match[0]);
    } catch {
      /* Plain text resembling a URL is not navigable. */
    }
  }
  // JSON secret fields and transport authentication must not be displayed.
  const classifier = new SensitiveValueClassifier({
    protectedValues: Object.fromEntries(candidates.map((c, i) => [`test_${i}`, c.value])),
  });
  const visit = (item: unknown, key = ""): unknown => {
    if (
      /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|recovery[_-]?codes?)$/i.test(
        key,
      )
    )
      return "[PROTECTED]";
    if (typeof item === "string") return classifier.sanitize(item);
    if (typeof item === "number" && candidates.some((c) => c.value === String(item)))
      return "[PROTECTED]";
    if (Array.isArray(item)) return item.map((child) => visit(child));
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, visit(v, k)]));
    return item;
  };
  return { safe: visit(value), candidates };
}
