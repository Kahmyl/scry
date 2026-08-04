import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { RemoteArtifactStore, type RemoteObjectBackend } from "./remote-artifact-store.js";

export type S3ArtifactStoreOptions = Readonly<{
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
}>;

export class S3ArtifactStore extends RemoteArtifactStore {
  constructor(options: S3ArtifactStoreOptions, admissionKey: string) {
    const client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
      },
    });
    super(new S3Backend(client, options.bucket), admissionKey, options.prefix);
  }
}

/** Internal constructor used by the environment factory without placing secrets in shared config objects. */
export function createS3ArtifactStore(options: S3ArtifactStoreOptions, admissionKey: string) {
  return new S3ArtifactStore(options, admissionKey);
}

class S3Backend implements RemoteObjectBackend {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}
  async putObject(key: string, content: Uint8Array, metadata: Readonly<Record<string, string>>) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: content, Metadata: metadata }),
    );
  }
  async getObject(key: string, range?: { offset: number; length: number }) {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}),
      }),
    );
    if (!result.Body) throw new Error("S3 returned an empty artifact body");
    return result.Body.transformToByteArray();
  }
  async headObject(key: string) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    const checksum = result.Metadata?.["scry-sha256"];
    return {
      sizeBytes: result.ContentLength ?? 0,
      ...(checksum ? { checksumSha256: checksum } : {}),
    };
  }
  async existsObject(key: string) {
    try {
      await this.headObject(key);
      return true;
    } catch (error) {
      if (notFound(error)) return false;
      throw error;
    }
  }
  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function notFound(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    (("name" in error &&
      ["NotFound", "NoSuchKey"].includes(String((error as { name?: string }).name))) ||
      ("$metadata" in error &&
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)),
  );
}
