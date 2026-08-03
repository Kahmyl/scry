import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { veilEvidenceManifestSchema, type VeilEvidenceManifest } from "@scry/contracts";
import type { VeilEvidenceAdmissionProof } from "./contracts.js";

export class VeilEvidenceAdmissionError extends Error {
  override name = "VeilEvidenceAdmissionError";
  constructor(readonly code: "VEIL_EVIDENCE_NOT_ADMITTED" | "VEIL_EVIDENCE_DIGEST_MISMATCH" | "VEIL_EVIDENCE_ID_MISMATCH", message: string) {
    super(message);
  }
}

export function signVeilEvidenceAdmission(manifest: VeilEvidenceManifest, key: string, sanitation?: Readonly<Record<string, unknown>>): VeilEvidenceAdmissionProof {
  const parsed = veilEvidenceManifestSchema.parse(manifest);
  requireAdmissionKey(key);
  const envelope = sanitation ? { manifest: parsed, sanitation } : { manifest: parsed };
  return Object.freeze({ ...envelope, token: createHmac("sha256", key).update(canonical(envelope)).digest("base64url") });
}

export function requireAdmissionProof(raw: VeilEvidenceAdmissionProof, key: string): VeilEvidenceManifest {
  requireAdmissionKey(key);
  const admission = veilEvidenceManifestSchema.parse(raw.manifest);
  const expected = createHmac("sha256", key).update(canonical(proofEnvelope(admission, raw.sanitation))).digest();
  const actualToken = Buffer.from(raw.token, "base64url");
  if (expected.length !== actualToken.length || !timingSafeEqual(expected, actualToken))
    throw new VeilEvidenceAdmissionError("VEIL_EVIDENCE_NOT_ADMITTED", "Evidence admission token is invalid");
  if (admission.disposition !== "allow" && admission.disposition !== "sanitize")
    throw new VeilEvidenceAdmissionError("VEIL_EVIDENCE_NOT_ADMITTED", "Only allowed or sanitized evidence may retain bytes");
  return Object.freeze({ ...admission, omissionIntervals: Object.freeze(admission.omissionIntervals.map((interval) => Object.freeze({ ...interval }))) }) as VeilEvidenceManifest;
}

export function requireAdmission(raw: VeilEvidenceAdmissionProof, content: Uint8Array, key: string): VeilEvidenceManifest {
  const admission = requireAdmissionProof(raw, key);
  const actual = sha256(content);
  if (!admission.contentDigest || admission.contentDigest !== actual)
    throw new VeilEvidenceAdmissionError("VEIL_EVIDENCE_DIGEST_MISMATCH", "Evidence admission does not match artifact bytes");
  return admission;
}

export function sha256(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

export function requireAdmissionKey(key: string) {
  if (Buffer.byteLength(key) < 32) throw new Error("VEIL_ADMISSION_KEY must contain at least 32 bytes");
}

function proofEnvelope(manifest: VeilEvidenceManifest, sanitation?: Readonly<Record<string, unknown>>) {
  return sanitation ? { manifest, sanitation } : { manifest };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => `${JSON.stringify(name)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
