import { requireAdmission, requireAdmissionKey, requireAdmissionProof, sha256 } from "../admission.js";
import type { ArtifactDestructionResult, ArtifactStore, VeilEvidenceAdmissionProof } from "../contracts.js";
import { prefixedStorageKey } from "../storage-key.js";

export type RemoteObjectMetadata = Readonly<{ sizeBytes: number; checksumSha256?: string }>;
export interface RemoteObjectBackend {
  putObject(key: string, content: Uint8Array, metadata: Readonly<Record<string, string>>): Promise<void>;
  getObject(key: string, range?: Readonly<{ offset: number; length: number }>): Promise<Uint8Array>;
  headObject(key: string): Promise<RemoteObjectMetadata>;
  existsObject(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
}

export class RemoteArtifactStore implements ArtifactStore {
  constructor(private readonly backend: RemoteObjectBackend, private readonly admissionKey: string, private readonly prefix?: string) { requireAdmissionKey(admissionKey); }
  async put(storageKey: string, content: Uint8Array, proof: VeilEvidenceAdmissionProof) {
    const admission = requireAdmission(proof, content, this.admissionKey); const checksumSha256 = sha256(content);
    await this.backend.putObject(this.key(storageKey), content, { "scry-sha256": checksumSha256, "scry-evidence-id": admission.evidenceId });
    return { storageKey, sizeBytes: content.byteLength, checksumSha256, admission: Object.freeze({ manifest: admission, ...(proof.sanitation ? { sanitation: proof.sanitation } : {}), token: proof.token }) };
  }
  async get(storageKey: string, proof: VeilEvidenceAdmissionProof) { const content = await this.backend.getObject(this.key(storageKey)); requireAdmission(proof, content, this.admissionKey); return content; }
  async getRange(storageKey: string, offset: number, length: number, proof: VeilEvidenceAdmissionProof) {
    validateRange(offset, length); await this.verifyMetadata(storageKey, proof);
    return length === 0 ? new Uint8Array() : this.backend.getObject(this.key(storageKey), { offset, length });
  }
  async size(storageKey: string, proof: VeilEvidenceAdmissionProof) { return (await this.verifyMetadata(storageKey, proof)).sizeBytes; }
  async exists(storageKey: string) { return this.backend.existsObject(this.key(storageKey)); }
  async delete(storageKey: string) { await this.backend.deleteObject(this.key(storageKey)); if (await this.exists(storageKey)) throw new Error("Artifact bytes still exist after deletion"); }
  async quarantine(storageKey: string) { await this.delete(storageKey); }
  async destroy(storageKey: string, proof: VeilEvidenceAdmissionProof): Promise<ArtifactDestructionResult> {
    if (!(await this.exists(storageKey))) return Object.freeze({ outcome: "missing", bytesDestroyed: true });
    let outcome: ArtifactDestructionResult["outcome"] = "deleted";
    try { await this.verifyMetadata(storageKey, proof); } catch { outcome = "tampered"; }
    await this.delete(storageKey); return Object.freeze({ outcome, bytesDestroyed: true });
  }
  private async verifyMetadata(storageKey: string, proof: VeilEvidenceAdmissionProof) {
    const admission = requireAdmissionProof(proof, this.admissionKey); const metadata = await this.backend.headObject(this.key(storageKey));
    if (!metadata.checksumSha256 || metadata.checksumSha256 !== admission.contentDigest) throw new Error("Stored artifact checksum metadata does not match Veil admission");
    return metadata;
  }
  private key(storageKey: string) { return prefixedStorageKey(this.prefix, storageKey); }
}

function validateRange(offset: number, length: number) { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) throw new Error("Artifact range must contain non-negative safe integers"); }
