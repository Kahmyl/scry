import type { VeilEvidenceAdmissionProof } from "../../artifacts/admission.js";

export type { VeilEvidenceAdmissionProof } from "../../artifacts/admission.js";

export type StoredArtifact = Readonly<{
  storageKey: string;
  sizeBytes: number;
  checksumSha256: string;
}>;

export type AdmittedArtifact = StoredArtifact & Readonly<{ admission: VeilEvidenceAdmissionProof }>;

export type ArtifactDestructionResult = Readonly<{
  outcome: "deleted" | "missing" | "tampered";
  bytesDestroyed: true;
}>;

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
  quarantine(storageKey: string): Promise<void>;
  destroy(
    storageKey: string,
    admission: VeilEvidenceAdmissionProof,
  ): Promise<ArtifactDestructionResult>;
}

export type ArtifactStorageProvider = "local" | "s3" | "cloudinary" | "gcs";

export type ConfiguredArtifactStore = Readonly<{
  provider: ArtifactStorageProvider;
  remote: boolean;
  store: ArtifactStore;
}>;
