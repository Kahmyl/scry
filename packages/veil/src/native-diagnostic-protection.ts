import { domainToASCII, domainToUnicode } from "node:url";
import { SensitiveValueClassifier, protectedValueVariants } from "./classifier.js";

/** Diagnostic-only privacy capability. Canonical hosts can lowercase ASCII or
 * encode Unicode/escaped labels before the proxy reports an origin. Those secret
 * variants belong here with the existing classifier, not in browser execution.
 * Any changed display is omitted by Praxis rather than turned into a URL.
 */
export function createNativeDiagnosticProtection(protectedValues: Record<string, string>) {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const markedValues: Record<string, string> = Object.create(null) as Record<string, string>;
  let markOnly = false;
  let index = 0;
  // Include canonical host forms of the same literal/encoded/base64 variants
  // that Veil already protects. Generated keys cannot collide with input names.
  for (const value of protectedValueVariants(protectedValues)) {
    const lower = value.toLowerCase();
    const ascii = domainToASCII(lower);
    // IDNA's case mapping is not identical to context-sensitive toLowerCase
    // (e.g. Greek final sigma), so preserve both canonicalization paths.
    const directAscii = domainToASCII(value);
    const variants = new Set([
      value,
      lower,
      ascii,
      domainToUnicode(ascii),
      directAscii,
      domainToUnicode(directAscii),
    ]);
    for (const variant of variants) {
      if (!variant) continue;
      values[`diagnostic:${index++}`] = variant;
      // Composition can cross the public/protected substring boundary (e.g.
      // public u + a protected leading diaeresis becomes ü). Compare in NFD.
      const decomposed = variant.normalize("NFD");
      values[`diagnostic:${index++}`] = decomposed;
      const unmarked = decomposed.replace(/\p{M}/gu, "");
      if (unmarked !== decomposed) {
        if (unmarked) markedValues[`diagnostic:${index++}`] = unmarked;
        else markOnly = true;
      }
    }
  }
  const classifier = new SensitiveValueClassifier({ protectedValues: values });
  const markedClassifier = Object.keys(markedValues).length
    ? new SensitiveValueClassifier({ protectedValues: markedValues })
    : undefined;
  return {
    sanitize(value: string): unknown {
      const sanitized = classifier.sanitize(value);
      if (sanitized !== value) return sanitized;
      try {
        const hostname = new URL(/^https?:\/\//.test(value) ? value : `http://${value}`).hostname;
        // Punycode encodes a whole label. Encoding the secret alone cannot
        // detect it inside prefix/suffix text; classify complete decoded labels
        // (and the hostname) against Veil's canonical protected variants.
        const labels = hostname.split(".").map((label) => domainToUnicode(label) || label);
        for (const decoded of [...labels, labels.join(".")]) {
          const decomposed = decoded.normalize("NFD");
          if (classifier.sanitize(decomposed) !== decomposed)
            return "[PROTECTED:NATIVE_DIAGNOSTIC_HOST]";
          // Canonical ordering can interleave public combining marks with a
          // protected leading/trailing mark cluster. Conservatively suppress
          // matching unmarked payloads for marked secrets. All-mark secrets
          // suppress Unicode host displays rather than matching an empty string.
          // This affects diagnostics only; false positives remain count-only.
          const unmarked = decomposed.replace(/\p{M}/gu, "");
          if (
            (markedClassifier && markedClassifier.sanitize(unmarked) !== unmarked) ||
            (markOnly && /[^\x00-\x7f]/.test(decoded))
          )
            return "[PROTECTED:NATIVE_DIAGNOSTIC_HOST]";
        }
        return value;
      } catch {
        return "[UNAVAILABLE:NATIVE_DIAGNOSTIC_HOST]";
      }
    },
  };
}
