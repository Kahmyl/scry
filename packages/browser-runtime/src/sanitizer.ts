import { Buffer } from "node:buffer";
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

export function buildBrowserSanitizerSource(
  protectedValues: Readonly<Record<string, string>> = {},
): string {
  const exact = Object.entries(protectedValues)
    .flatMap(([name, value]) => {
      if (!value) return [];
      return [
        ...new Set(
          [
            value,
            value.trim(),
            encodeURIComponent(value),
            Buffer.from(value, "utf8").toString("base64"),
            Buffer.from(value, "utf8").toString("base64url"),
          ].filter(Boolean),
        ),
      ].map((candidate) => ({ name, candidate }));
    })
    .sort((left, right) => right.candidate.length - left.candidate.length);
  return `
    const __scryExact = ${JSON.stringify(exact)};
    const __scryUrlKeys = new Set(${JSON.stringify([...URL_KEYS])});
    const __scrySafeAttrs = new Set(${JSON.stringify([...SAFE_ATTRIBUTE_KEYS])});
    const __scryPatterns = [
      ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu],
      ['BEARER', /\\bBearer\\s+[A-Za-z0-9._~+\\/=-]{12,}\\b/giu],
      ['JWT', /\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b/gu],
      ['CONNECTION', /\\b(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?):\\/\\/[^\\s"'<>]+/giu],
      ['SECRET', /\\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\\s*[:=]\\s*[^\\s,;"']{4,}/giu],
      ['EMAIL', /\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b/giu]
    ];
    const __scryMask = value => '•'.repeat(Math.max(3, Math.min(24, String(value ?? '').length)));
    const __scryEntropy = candidate => {
      if (!/[A-Za-z]/u.test(candidate) || !/\\d/u.test(candidate)) return false;
      const counts = new Map();
      for (const character of candidate) counts.set(character, (counts.get(character) ?? 0) + 1);
      let entropy = 0;
      for (const count of counts.values()) { const p = count / candidate.length; entropy -= p * Math.log2(p); }
      return entropy >= 3.5;
    };
    const __scrySanitizeString = input => {
      if (typeof input !== 'string') return input;
      let output = input;
      for (const item of __scryExact) output = output.split(item.candidate).join('[PROTECTED:REFERENCE:' + item.name.toUpperCase() + ']');
      for (const [label, pattern] of __scryPatterns) { pattern.lastIndex = 0; output = output.replace(pattern, '[PROTECTED:' + label + ']'); }
      return output.replace(/[A-Za-z0-9_+\\/-]{20,}={0,2}/gu, candidate => __scryEntropy(candidate) ? '[PROTECTED:HIGH-ENTROPY]' : candidate);
    };
    const __scrySanitize = (value, key = '') => {
      if (typeof value === 'string') {
        const lower = key.toLowerCase();
        if (__scryUrlKeys.has(lower)) return '';
        if (lower === 'value') return __scryMask(value);
        return __scrySanitizeString(value);
      }
      if (Array.isArray(value)) return value.map(item => __scrySanitize(item, key));
      if (!value || typeof value !== 'object') return value;
      const output = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childKey === 'attributes' && childValue && typeof childValue === 'object') {
          const attributes = {};
          for (const [attributeKey, attributeValue] of Object.entries(childValue)) {
            const lower = attributeKey.toLowerCase();
            if (lower.startsWith('on') || __scryUrlKeys.has(lower)) continue;
            attributes[attributeKey] = lower === 'value' ? __scryMask(attributeValue) : __scrySanitizeString(String(attributeValue));
          }
          output[childKey] = attributes;
        } else output[childKey] = __scrySanitize(childValue, childKey);
      }
      return output;
    };
  `;
}
