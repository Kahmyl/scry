export type StoredArtifact = Readonly<{
  storageKey: string;

  sizeBytes: number;

  checksumSha256: string;
}>;

export type ArtifactDestructionResult =
  Readonly<{
    outcome:
      | "deleted"
      | "missing"
      | "tampered";

    bytesDestroyed: true;
  }>;

/**
 * Persistence contract only.
 *
 * This interface deliberately contains no:
 *
 * - Veil policy
 * - admission token
 * - capture permit
 * - semantic classification
 * - execution authorization
 *
 * Trust decisions happen before persistence.
 */
export interface ArtifactStore {
  put(
    storageKey: string,
    content: Uint8Array,
  ): Promise<StoredArtifact>;

  get(
    storageKey: string,
  ): Promise<Uint8Array>;

  getRange(
    storageKey: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;

  size(
    storageKey: string,
  ): Promise<number>;

  exists(
    storageKey: string,
  ): Promise<boolean>;

  delete(
    storageKey: string,
  ): Promise<void>;

  quarantine(
    storageKey: string,
  ): Promise<void>;

  destroy(
    storageKey: string,
  ): Promise<ArtifactDestructionResult>;
}

export type ArtifactStorageProvider =
  | "local"
  | "s3"
  | "cloudinary"
  | "gcs";
