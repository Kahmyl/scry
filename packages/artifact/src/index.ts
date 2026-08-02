import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoredArtifact = {
  storageKey: string;
  sizeBytes: number;
  checksumSha256: string;
};

export interface ArtifactStore {
  put(storageKey: string, content: Uint8Array): Promise<StoredArtifact>;
  get(storageKey: string): Promise<Uint8Array>;
  getRange(storageKey: string, offset: number, length: number): Promise<Uint8Array>;
  size(storageKey: string): Promise<number>;
  exists(storageKey: string): Promise<boolean>;
  delete(storageKey: string): Promise<void>;
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

  async getRange(storageKey: string, offset: number, length: number) {
    const handle = await open(this.resolve(storageKey), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async size(storageKey: string) {
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
