import { createHash } from "node:crypto";

export const VEIL_PUBLIC_VALUE_ADMISSION_REVISION = 1;
export const VEIL_PUBLIC_VALUE_MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export type VeilPublicValueKind = "code" | "pre" | "output" | "annotated";

export type VeilPublicValueClassification = "public" | "protected" | "unknown";

export type VeilPublicValueCandidate = Readonly<{
  kind: VeilPublicValueKind;
  text: string;
  redactedBoundary: boolean;
  editableBoundary: boolean;
  contextLabel?: string;
}>;

export type VeilPublicValueAdmission = Readonly<{
  classification: "public";
  admissionRevision: typeof VEIL_PUBLIC_VALUE_ADMISSION_REVISION;
  contentDigest: string;
  admissionDigest: string;
  safeContext?: string;
}>;

export class VeilPublicValueAdmissionError extends Error {
  override readonly name = "VeilPublicValueAdmissionError";

  constructor(
    readonly code:
      | "VEIL_PUBLIC_VALUE_PROTECTED"
      | "VEIL_PUBLIC_VALUE_UNKNOWN"
      | "VEIL_PUBLIC_VALUE_SOURCE_TOO_LARGE",
  ) {
    super(code);
  }
}

export function classifyVeilPublicValue(
  input: VeilPublicValueCandidate,
): VeilPublicValueClassification {
  const text = input.text.trim();

  if (input.redactedBoundary || input.editableBoundary) {
    return "protected";
  }

  if (!text) return "unknown";

  const bytes = Buffer.byteLength(text, "utf8");

  if (bytes > VEIL_PUBLIC_VALUE_MAX_SOURCE_BYTES) {
    return "unknown";
  }

  if (containsProtectedMaterial(text) || containsProtectedMaterial(input.contextLabel ?? "")) {
    return "protected";
  }

  return "public";
}

export function admitVeilPublicValue(input: VeilPublicValueCandidate): VeilPublicValueAdmission {
  const classification = classifyVeilPublicValue(input);

  if (
    classification === "unknown" &&
    Buffer.byteLength(input.text, "utf8") > VEIL_PUBLIC_VALUE_MAX_SOURCE_BYTES
  ) {
    throw new VeilPublicValueAdmissionError("VEIL_PUBLIC_VALUE_SOURCE_TOO_LARGE");
  }

  if (classification === "protected") {
    throw new VeilPublicValueAdmissionError("VEIL_PUBLIC_VALUE_PROTECTED");
  }

  if (classification !== "public") {
    throw new VeilPublicValueAdmissionError("VEIL_PUBLIC_VALUE_UNKNOWN");
  }

  const contentDigest = createHash("sha256").update(input.text, "utf8").digest("hex");
  const safeContext = safePublicContext(input.contextLabel);

  const admissionDigest = createHash("sha256")
    .update(
      JSON.stringify({
        admissionRevision: VEIL_PUBLIC_VALUE_ADMISSION_REVISION,
        kind: input.kind,
        contentDigest,
        safeContext: safeContext ?? null,
      }),
    )
    .digest("hex");

  return {
    classification: "public",
    admissionRevision: VEIL_PUBLIC_VALUE_ADMISSION_REVISION,
    contentDigest,
    admissionDigest,
    ...(safeContext ? { safeContext } : {}),
  };
}

function safePublicContext(value: string | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim().slice(0, 160);

  if (!normalized || containsProtectedMaterial(normalized)) {
    return undefined;
  }

  return normalized;
}

function containsProtectedMaterial(value: string) {
  const text = value.trim();

  if (!text) return false;

  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(text) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text) ||
    /\b(?:sk|rk|pk|api|token|secret|key)_[A-Za-z0-9_-]{12,}\b/i.test(text)
  ) {
    return true;
  }

  if (
    /\b(?:password|passcode|secret|client[_ -]?secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization)\b\s*[:=]\s*\S+/i.test(
      text,
    )
  ) {
    return true;
  }

  if (/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/{\}-]{1,1000}$/.test(text)) {
    return false;
  }

  const compact = text.replace(/\s+/g, "");

  if (
    compact.length >= 40 &&
    compact.length <= 1024 &&
    /^[A-Za-z0-9+/_=-]+$/.test(compact) &&
    !text.includes(" ")
  ) {
    return true;
  }

  return false;
}
