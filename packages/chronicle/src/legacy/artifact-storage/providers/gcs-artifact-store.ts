import { Storage } from "@google-cloud/storage";
import { RemoteArtifactStore, type RemoteObjectBackend } from "./remote-artifact-store.js";

export type GcsArtifactStoreOptions = Readonly<{
  bucket: string;
  projectId: string;
  credentials?: Record<string, unknown>;
  keyFilename?: string;
  prefix?: string;
}>;

export function createGcsArtifactStore(options: GcsArtifactStoreOptions, admissionKey: string) {
  const storage = new Storage({
    projectId: options.projectId,
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.keyFilename ? { keyFilename: options.keyFilename } : {}),
  });
  return new RemoteArtifactStore(
    new GcsBackend(storage, options.bucket),
    admissionKey,
    options.prefix,
  );
}

class GcsBackend implements RemoteObjectBackend {
  private readonly bucket;
  constructor(storage: Storage, bucket: string) {
    this.bucket = storage.bucket(bucket);
  }
  async putObject(key: string, content: Uint8Array, metadata: Readonly<Record<string, string>>) {
    await this.bucket.file(key).save(Buffer.from(content), {
      resumable: false,
      metadata: { contentType: "application/octet-stream", metadata },
    });
  }
  async getObject(key: string, range?: { offset: number; length: number }) {
    const [content] = await this.bucket
      .file(key)
      .download(range ? { start: range.offset, end: range.offset + range.length - 1 } : {});
    return content;
  }
  async headObject(key: string) {
    const [metadata] = await this.bucket.file(key).getMetadata();
    const checksum = metadata.metadata?.["scry-sha256"];
    return {
      sizeBytes: Number(metadata.size ?? 0),
      ...(typeof checksum === "string" ? { checksumSha256: checksum } : {}),
    };
  }
  async existsObject(key: string) {
    const [exists] = await this.bucket.file(key).exists();
    return exists;
  }
  async deleteObject(key: string) {
    await this.bucket.file(key).delete({ ignoreNotFound: true });
  }
}
