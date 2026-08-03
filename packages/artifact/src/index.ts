import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { veilEvidenceManifestSchema, type VeilEvidenceManifest } from "@scry/contracts";

export type StoredArtifact = {
  storageKey: string;
  sizeBytes: number;
  checksumSha256: string;
};

export type AdmittedArtifact = StoredArtifact & {
  admission: VeilEvidenceAdmissionProof;
};

export type VeilEvidenceAdmissionProof = {
  manifest: VeilEvidenceManifest;
  sanitation?: Readonly<Record<string, unknown>>;
  token: string;
};

export function signVeilEvidenceAdmission(
  manifest: VeilEvidenceManifest,
  key: string,
  sanitation?: Readonly<Record<string, unknown>>,
): VeilEvidenceAdmissionProof {
  const parsed = veilEvidenceManifestSchema.parse(manifest);
  requireAdmissionKey(key);
  const envelope = sanitation ? { manifest: parsed, sanitation } : { manifest: parsed };
  return Object.freeze({
    ...envelope,
    token: createHmac("sha256", key).update(canonical(envelope)).digest("base64url"),
  });
}

export class VeilEvidenceAdmissionError extends Error {
  override name = "VeilEvidenceAdmissionError";
  constructor(
    readonly code:
      "VEIL_EVIDENCE_NOT_ADMITTED" | "VEIL_EVIDENCE_DIGEST_MISMATCH" | "VEIL_EVIDENCE_ID_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}

export interface ArtifactStore {
  put(
    storageKey: string,
    content: Uint8Array,
    admission: VeilEvidenceAdmissionProof,
  ): Promise<AdmittedArtifact>;
  get(storageKey: string, admission: VeilEvidenceAdmissionProof): Promise<Uint8Array>;
  getRange(
    storageKey: string,
    offset: number,
    length: number,
    admission: VeilEvidenceAdmissionProof,
  ): Promise<Uint8Array>;
  size(storageKey: string, admission: VeilEvidenceAdmissionProof): Promise<number>;
  exists(storageKey: string): Promise<boolean>;
  delete(storageKey: string): Promise<void>;
  destroy(
    storageKey: string,
    admission: VeilEvidenceAdmissionProof,
  ): Promise<ArtifactDestructionResult>;
}

export type ArtifactDestructionResult = Readonly<{
  outcome: "deleted" | "missing" | "tampered";
  bytesDestroyed: true;
}>;

export class LocalArtifactStore implements ArtifactStore {
  constructor(
    private readonly root: string,
    private readonly admissionKey: string,
  ) {
    requireAdmissionKey(admissionKey);
  }

  async put(
    storageKey: string,
    content: Uint8Array,
    proof: VeilEvidenceAdmissionProof,
  ): Promise<AdmittedArtifact> {
    const admission = requireAdmission(proof, content, this.admissionKey);
    const target = this.resolve(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    return {
      storageKey,
      sizeBytes: content.byteLength,
      checksumSha256: createHash("sha256").update(content).digest("hex"),
      admission: Object.freeze({
        manifest: admission,
        ...(proof.sanitation ? { sanitation: proof.sanitation } : {}),
        token: proof.token,
      }),
    };
  }

  async get(storageKey: string, rawAdmission: VeilEvidenceAdmissionProof) {
    const content = await readFile(this.resolve(storageKey));
    requireAdmission(rawAdmission, content, this.admissionKey);
    return content;
  }

  async getRange(
    storageKey: string,
    offset: number,
    length: number,
    rawAdmission: VeilEvidenceAdmissionProof,
  ) {
    await this.verifyStored(storageKey, rawAdmission);
    const handle = await open(this.resolve(storageKey), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async size(storageKey: string, rawAdmission: VeilEvidenceAdmissionProof) {
    await this.verifyStored(storageKey, rawAdmission);
    return (await stat(this.resolve(storageKey))).size;
  }

  async exists(storageKey: string) {
    try {
      await stat(this.resolve(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  async delete(storageKey: string) {
    await rm(this.resolve(storageKey), { force: true });
    if (await this.exists(storageKey)) throw new Error("Artifact bytes still exist after deletion");
  }

  /** Verified, fail-safe destruction boundary. Tampered bytes are destroyed too. */
  async destroy(
    storageKey: string,
    admission: VeilEvidenceAdmissionProof,
  ): Promise<ArtifactDestructionResult> {
    if (!(await this.exists(storageKey)))
      return Object.freeze({ outcome: "missing", bytesDestroyed: true });
    let outcome: ArtifactDestructionResult["outcome"] = "deleted";
    try {
      await this.verifyStored(storageKey, admission);
    } catch {
      outcome = "tampered";
    }
    await this.delete(storageKey);
    return Object.freeze({ outcome, bytesDestroyed: true });
  }

  async quarantine(storageKey: string): Promise<void> {
    await this.delete(storageKey);
  }

  private async verifyStored(storageKey: string, rawAdmission: VeilEvidenceAdmissionProof) {
    requireAdmission(rawAdmission, await readFile(this.resolve(storageKey)), this.admissionKey);
  }

  private resolve(storageKey: string) {
    if (
      storageKey.length === 0 ||
      path.isAbsolute(storageKey) ||
      storageKey.split(/[\\/]/).includes("..")
    ) {
      throw new Error("Artifact storage key must be a safe relative path");
    }
    return path.join(this.root, storageKey);
  }
}

/** The single byte-admission rule shared by persistence and retrieval. */
export function requireAdmission(
  raw: VeilEvidenceAdmissionProof,
  content: Uint8Array,
  key: string,
): VeilEvidenceManifest {
  requireAdmissionKey(key);
  const admission = veilEvidenceManifestSchema.parse(raw.manifest);
  const expected = createHmac("sha256", key)
    .update(canonical(proofEnvelope(admission, raw.sanitation)))
    .digest();
  const actualToken = Buffer.from(raw.token, "base64url");
  if (expected.length !== actualToken.length || !timingSafeEqual(expected, actualToken)) {
    throw new VeilEvidenceAdmissionError(
      "VEIL_EVIDENCE_NOT_ADMITTED",
      "Evidence admission token is invalid",
    );
  }
  if (admission.disposition !== "allow" && admission.disposition !== "sanitize") {
    throw new VeilEvidenceAdmissionError(
      "VEIL_EVIDENCE_NOT_ADMITTED",
      "Only allowed or sanitized evidence may retain bytes",
    );
  }
  const actual = createHash("sha256").update(content).digest("hex");
  if (!admission.contentDigest || admission.contentDigest !== actual) {
    throw new VeilEvidenceAdmissionError(
      "VEIL_EVIDENCE_DIGEST_MISMATCH",
      "Evidence admission does not match artifact bytes",
    );
  }
  return Object.freeze({
    ...admission,
    omissionIntervals: Object.freeze(
      admission.omissionIntervals.map((interval) => Object.freeze({ ...interval })),
    ),
  }) as VeilEvidenceManifest;
}

function proofEnvelope(
  manifest: VeilEvidenceManifest,
  sanitation?: Readonly<Record<string, unknown>>,
) {
  return sanitation ? { manifest, sanitation } : { manifest };
}

function requireAdmissionKey(key: string) {
  if (Buffer.byteLength(key) < 32)
    throw new Error("VEIL_ADMISSION_KEY must contain at least 32 bytes");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
