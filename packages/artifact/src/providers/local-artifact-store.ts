import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireAdmission, requireAdmissionKey, sha256 } from "../admission.js";
import type {
  ArtifactDestructionResult,
  ArtifactStore,
  VeilEvidenceAdmissionProof,
} from "../contracts.js";
import { requireSafeStorageKey } from "../storage-key.js";

export class LocalArtifactStore implements ArtifactStore {
  constructor(
    private readonly root: string,
    private readonly admissionKey: string,
  ) {
    requireAdmissionKey(admissionKey);
  }
  async put(storageKey: string, content: Uint8Array, proof: VeilEvidenceAdmissionProof) {
    const admission = requireAdmission(proof, content, this.admissionKey);
    const target = this.resolve(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    return {
      storageKey,
      sizeBytes: content.byteLength,
      checksumSha256: sha256(content),
      admission: Object.freeze({
        manifest: admission,
        ...(proof.sanitation ? { sanitation: proof.sanitation } : {}),
        token: proof.token,
      }),
    };
  }
  async get(storageKey: string, proof: VeilEvidenceAdmissionProof) {
    const content = await readFile(this.resolve(storageKey));
    requireAdmission(proof, content, this.admissionKey);
    return content;
  }
  async getRange(
    storageKey: string,
    offset: number,
    length: number,
    proof: VeilEvidenceAdmissionProof,
  ) {
    validateRange(offset, length);
    await this.verifyStored(storageKey, proof);
    const handle = await open(this.resolve(storageKey), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  async size(storageKey: string, proof: VeilEvidenceAdmissionProof) {
    await this.verifyStored(storageKey, proof);
    return (await stat(this.resolve(storageKey))).size;
  }
  async exists(storageKey: string) {
    try {
      await stat(this.resolve(storageKey));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  async delete(storageKey: string) {
    await rm(this.resolve(storageKey), { force: true });
    if (await this.exists(storageKey)) throw new Error("Artifact bytes still exist after deletion");
  }
  async quarantine(storageKey: string) {
    await this.delete(storageKey);
  }
  async destroy(
    storageKey: string,
    proof: VeilEvidenceAdmissionProof,
  ): Promise<ArtifactDestructionResult> {
    if (!(await this.exists(storageKey)))
      return Object.freeze({ outcome: "missing", bytesDestroyed: true });
    let outcome: ArtifactDestructionResult["outcome"] = "deleted";
    try {
      await this.verifyStored(storageKey, proof);
    } catch {
      outcome = "tampered";
    }
    await this.delete(storageKey);
    return Object.freeze({ outcome, bytesDestroyed: true });
  }
  private async verifyStored(storageKey: string, proof: VeilEvidenceAdmissionProof) {
    requireAdmission(proof, await readFile(this.resolve(storageKey)), this.admissionKey);
  }
  private resolve(storageKey: string) {
    return path.join(this.root, requireSafeStorageKey(storageKey));
  }
}

function validateRange(offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0)
    throw new Error("Artifact range must contain non-negative safe integers");
}
function isMissing(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["ENOENT", "ENOTDIR"].includes(String((error as { code?: string }).code)),
  );
}
