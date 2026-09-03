import { Buffer } from "node:buffer";

export type PatternDefinition = readonly [category: string, pattern: RegExp];

const BUILTIN_PATTERNS: readonly PatternDefinition[] = [
  [
    "private-key",
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
  ],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu],
  ["connection-string", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/giu],
  ["api-key", /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/giu],
  [
    "assignment-secret",
    /\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*[^\s,;"']{4,}/giu,
  ],
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu],
  ["payment-card", /\b(?:\d[ -]*?){13,19}\b/gu],
  ["nigerian-bvn-or-nin", /\b\d{11}\b/gu],
  [
    "phone",
    /(?<![A-Za-z0-9.-])(?:\+\d[\d\s()-]{7,}\d|\d[\d\s()-]{8,}\d)(?![A-Za-z0-9.-])/gu,
  ],
];

export interface SensitiveFinding {
  category: string;
  name?: string;
  start: number;
  length: number;
}

function variants(value: string): Set<string> {
  const result = new Set<string>();
  if (value.length === 0) return result;
  result.add(value);
  result.add(value.trim());
  result.add(encodeURIComponent(value));
  result.add(Buffer.from(value, "utf8").toString("base64"));
  result.add(Buffer.from(value, "utf8").toString("base64url"));
  return new Set([...result].filter(Boolean));
}

function replacement(category: string, name?: string): string {
  const label = name ? `${category}:${name}` : category;
  return `[PROTECTED:${label.toUpperCase().replace(/[^A-Z0-9:_-]/g, "_")}]`;
}

export class SensitiveValueClassifier {
  readonly #exact: Array<{ name: string; candidate: string }> = [];
  readonly #patterns: readonly PatternDefinition[];

  constructor(
    options: {
      protectedValues?: Readonly<Record<string, string>>;
      patterns?: readonly PatternDefinition[];
    } = {},
  ) {
    for (const [name, value] of Object.entries(options.protectedValues ?? {})) {
      for (const candidate of variants(value)) this.#exact.push({ name, candidate });
    }
    this.#exact.sort((left, right) => right.candidate.length - left.candidate.length);
    this.#patterns = [...BUILTIN_PATTERNS, ...(options.patterns ?? [])];
  }

  sanitize(input: string): string {
    let output = this.sanitizeExact(input);
    for (const [category, pattern] of this.#patterns) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, replacement(category));
    }
    output = output.replace(/[A-Za-z0-9_+-]{20,}={0,2}/gu, (candidate) =>
      looksLikeHighEntropyToken(candidate) ? replacement("high-entropy") : candidate,
    );
    return output;
  }

  sanitizeExact(input: string): string {
    let output = input;
    for (const { name, candidate } of this.#exact) {
      output = output.split(candidate).join(replacement("reference", name));
    }
    return output;
  }

  findings(input: string): SensitiveFinding[] {
    const findings: SensitiveFinding[] = [];
    for (const { name, candidate } of this.#exact) {
      let from = 0;
      while ((from = input.indexOf(candidate, from)) !== -1) {
        findings.push({ category: "reference", name, start: from, length: candidate.length });
        from += Math.max(1, candidate.length);
      }
    }
    for (const [category, pattern] of this.#patterns) {
      pattern.lastIndex = 0;
      for (const match of input.matchAll(pattern)) {
        findings.push({ category, start: match.index ?? 0, length: match[0].length });
      }
    }
    for (const match of input.matchAll(/[A-Za-z0-9_+-]{20,}={0,2}/gu)) {
      if (looksLikeHighEntropyToken(match[0])) {
        findings.push({
          category: "high-entropy",
          start: match.index ?? 0,
          length: match[0].length,
        });
      }
    }
    return findings.sort((left, right) => left.start - right.start || right.length - left.length);
  }
}

function looksLikeHighEntropyToken(candidate: string): boolean {
  if (!/[A-Za-z]/u.test(candidate) || !/\d/u.test(candidate)) return false;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(candidate)) return false;
  if (/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/u.test(candidate)) return false;
  const counts = new Map<string, number>();
  for (const character of candidate) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / candidate.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.5;
}

export function protectedValueVariants(values: Readonly<Record<string, string>>): string[] {
  return [...new Set(Object.values(values).flatMap((value) => [...variants(value)]))].sort(
    (left, right) => right.length - left.length,
  );
}
