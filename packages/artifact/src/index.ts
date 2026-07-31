import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoredArtifact = {
  storageKey: string;
  sizeBytes: number;
  checksumSha256: string;
};

export interface ArtifactStore {
  put(storageKey: string, content: Uint8Array): Promise<StoredArtifact>;
  get(storageKey: string): Promise<Uint8Array>;
  exists(storageKey: string): Promise<boolean>;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async put(storageKey: string, content: Uint8Array): Promise<StoredArtifact> {
    const target = this.resolve(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    return {
      storageKey,
      sizeBytes: content.byteLength,
      checksumSha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  async get(storageKey: string) {
    return readFile(this.resolve(storageKey));
  }

  async exists(storageKey: string) {
    try {
      await stat(this.resolve(storageKey));
      return true;
    } catch {
      return false;
    }
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
