import { v2 as cloudinary, type ConfigOptions } from "cloudinary";
import { RemoteArtifactStore, type RemoteObjectBackend } from "./remote-artifact-store.js";

export type CloudinaryArtifactStoreOptions = Readonly<{
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  prefix?: string;
}>;

export function createCloudinaryArtifactStore(
  options: CloudinaryArtifactStoreOptions,
  admissionKey: string,
) {
  const client = cloudinary;
  client.config({
    cloud_name: options.cloudName,
    api_key: options.apiKey,
    api_secret: options.apiSecret,
    secure: true,
  } satisfies ConfigOptions);
  return new RemoteArtifactStore(new CloudinaryBackend(client), admissionKey, options.prefix);
}

class CloudinaryBackend implements RemoteObjectBackend {
  constructor(private readonly client: typeof cloudinary) {}
  async putObject(key: string, content: Uint8Array, metadata: Readonly<Record<string, string>>) {
    await new Promise<void>((resolve, reject) => {
      const upload = this.client.uploader.upload_stream(
        {
          public_id: key,
          resource_type: "raw",
          type: "authenticated",
          overwrite: true,
          invalidate: true,
          context: Object.entries(metadata)
            .map(([name, value]) => `${name}=${escapeContext(value)}`)
            .join("|"),
        },
        (error) => (error ? reject(error) : resolve()),
      );
      upload.end(Buffer.from(content));
    });
  }
  async getObject(key: string, range?: { offset: number; length: number }) {
    const response = await fetch(this.signedUrl(key), {
      headers: range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {},
    });
    if (!response.ok && response.status !== 206)
      throw new Error(`Cloudinary artifact download failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (range && response.status !== 206)
      return bytes.subarray(range.offset, range.offset + range.length);
    return bytes;
  }
  async headObject(key: string) {
    const resource = await this.client.api.resource(key, {
      resource_type: "raw",
      type: "authenticated",
    });
    const context = (resource.context?.custom ?? {}) as Record<string, string>;
    const checksum = context["scry-sha256"];
    return {
      sizeBytes: Number(resource.bytes ?? 0),
      ...(checksum ? { checksumSha256: checksum } : {}),
    };
  }
  async existsObject(key: string) {
    try {
      await this.headObject(key);
      return true;
    } catch (error) {
      if (cloudinaryNotFound(error)) return false;
      throw error;
    }
  }
  async deleteObject(key: string) {
    await this.client.uploader.destroy(key, {
      resource_type: "raw",
      type: "authenticated",
      invalidate: true,
    });
  }
  private signedUrl(key: string) {
    return this.client.url(key, {
      resource_type: "raw",
      type: "authenticated",
      sign_url: true,
      secure: true,
    });
  }
}

function escapeContext(value: string) {
  return value.replace(/[=|]/g, (character) => `\\${character}`);
}
function cloudinaryNotFound(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    (("http_code" in error && (error as { http_code?: number }).http_code === 404) ||
      ("error" in error && String((error as { error?: unknown }).error).includes("not found"))),
  );
}
