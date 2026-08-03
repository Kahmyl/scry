import path from "node:path";
import type { ArtifactStorageProvider, ConfiguredArtifactStore } from "./contracts.js";
import { createCloudinaryArtifactStore } from "./providers/cloudinary-artifact-store.js";
import { createGcsArtifactStore } from "./providers/gcs-artifact-store.js";
import { LocalArtifactStore } from "./providers/local-artifact-store.js";
import { createS3ArtifactStore } from "./providers/s3-artifact-store.js";

type Environment = Readonly<Record<string, string | undefined>>;

export function createArtifactStoreFromEnv(environment: Environment, admissionKey: string): ConfiguredArtifactStore {
  const provider = parseProvider(environment.ARTIFACT_STORAGE_PROVIDER);
  if (provider === "local") return Object.freeze({ provider, remote: false, store: new LocalArtifactStore(path.resolve(environment.ARTIFACT_ROOT ?? "artifacts/runs"), admissionKey) });
  if (provider === "s3") return Object.freeze({ provider, remote: true, store: createS3ArtifactStore({
    bucket: required(environment, "ARTIFACT_S3_BUCKET"), region: required(environment, "ARTIFACT_S3_REGION"),
    accessKeyId: required(environment, "ARTIFACT_S3_ACCESS_KEY_ID"), secretAccessKey: required(environment, "ARTIFACT_S3_SECRET_ACCESS_KEY"),
    ...(environment.ARTIFACT_S3_SESSION_TOKEN ? { sessionToken: environment.ARTIFACT_S3_SESSION_TOKEN } : {}),
    ...(environment.ARTIFACT_S3_ENDPOINT ? { endpoint: validUrl(environment.ARTIFACT_S3_ENDPOINT, "ARTIFACT_S3_ENDPOINT") } : {}),
    ...(environment.ARTIFACT_STORAGE_PREFIX ? { prefix: environment.ARTIFACT_STORAGE_PREFIX } : {}),
    forcePathStyle: booleanValue(environment.ARTIFACT_S3_FORCE_PATH_STYLE, Boolean(environment.ARTIFACT_S3_ENDPOINT)),
  }, admissionKey) });
  if (provider === "cloudinary") return Object.freeze({ provider, remote: true, store: createCloudinaryArtifactStore({
    cloudName: required(environment, "CLOUDINARY_CLOUD_NAME"), apiKey: required(environment, "CLOUDINARY_API_KEY"), apiSecret: required(environment, "CLOUDINARY_API_SECRET"),
    ...(environment.ARTIFACT_STORAGE_PREFIX ? { prefix: environment.ARTIFACT_STORAGE_PREFIX } : {}),
  }, admissionKey) });
  const credentialsJson = environment.GOOGLE_SERVICE_ACCOUNT_JSON;
  const keyFilename = environment.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsJson && !keyFilename) throw new ArtifactStorageConfigurationError("ARTIFACT_STORAGE_CREDENTIALS_REQUIRED", "gcs requires GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS");
  return Object.freeze({ provider, remote: true, store: createGcsArtifactStore({
    bucket: required(environment, "ARTIFACT_GCS_BUCKET"), projectId: required(environment, "GOOGLE_CLOUD_PROJECT"),
    ...(credentialsJson ? { credentials: serviceAccount(credentialsJson) } : {}), ...(keyFilename ? { keyFilename } : {}),
    ...(environment.ARTIFACT_STORAGE_PREFIX ? { prefix: environment.ARTIFACT_STORAGE_PREFIX } : {}),
  }, admissionKey) });
}

export class ArtifactStorageConfigurationError extends Error {
  override name = "ArtifactStorageConfigurationError";
  constructor(readonly code: "ARTIFACT_STORAGE_PROVIDER_INVALID" | "ARTIFACT_STORAGE_CREDENTIALS_REQUIRED" | "ARTIFACT_STORAGE_VALUE_INVALID", message: string) { super(message); }
}

function parseProvider(raw = "local"): ArtifactStorageProvider {
  if (raw === "local" || raw === "s3" || raw === "cloudinary" || raw === "gcs") return raw;
  throw new ArtifactStorageConfigurationError("ARTIFACT_STORAGE_PROVIDER_INVALID", `Unsupported ARTIFACT_STORAGE_PROVIDER: ${raw}`);
}
function required(environment: Environment, name: string) { const value = environment[name]?.trim(); if (!value) throw new ArtifactStorageConfigurationError("ARTIFACT_STORAGE_CREDENTIALS_REQUIRED", `${name} is required for the selected artifact storage provider`); return value; }
function validUrl(raw: string, name: string) { try { return new URL(raw).toString().replace(/\/$/, ""); } catch { throw new ArtifactStorageConfigurationError("ARTIFACT_STORAGE_VALUE_INVALID", `${name} must be an absolute URL`); } }
function booleanValue(raw: string | undefined, fallback: boolean) { if (raw === undefined) return fallback; if (raw === "true") return true; if (raw === "false") return false; throw new ArtifactStorageConfigurationError("ARTIFACT_STORAGE_VALUE_INVALID", "ARTIFACT_S3_FORCE_PATH_STYLE must be true or false"); }
function serviceAccount(raw: string): Record<string, unknown> { try { const value = JSON.parse(raw) as unknown; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new ArtifactStorageConfigurationError("ARTIFACT_STORAGE_VALUE_INVALID", "GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object"); } }
