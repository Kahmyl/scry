import {
  createHmac,
} from "node:crypto";

import {
  veilEvidenceManifestSchema,
  type VeilEvidenceManifest,
} from "@scry/contracts";

import {
  artifactSha256,
} from "./integrity.js";

export type VeilEvidenceAdmissionProof =
  Readonly<{
    manifest: VeilEvidenceManifest;
    sanitation?: Readonly<
      Record<string, unknown>
    >;
    token: string;
  }>;

export function signVeilEvidenceAdmission(
  manifest: VeilEvidenceManifest,
  key: string,
  sanitation?: Readonly<
    Record<string, unknown>
  >,
): VeilEvidenceAdmissionProof {
  const parsed =
    veilEvidenceManifestSchema.parse(
      manifest,
    );

  requireAdmissionKey(key);

  const envelope = sanitation
    ? {
        manifest: parsed,
        sanitation,
      }
    : {
        manifest: parsed,
      };

  return Object.freeze({
    ...envelope,
    token: createHmac(
      "sha256",
      key,
    )
      .update(canonical(envelope))
      .digest("base64url"),
  });
}

export function sha256(
  content: Uint8Array,
): string {
  return artifactSha256(
    content,
  );
}

export function requireAdmissionKey(
  key: string,
): void {
  if (
    Buffer.byteLength(key) < 32
  ) {
    throw new Error(
      "VEIL_ADMISSION_KEY must contain at least 32 bytes",
    );
  }
}

function canonical(
  value: unknown,
): string {
  if (Array.isArray(value)) {
    return `[${value
      .map(canonical)
      .join(",")}]`;
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return `{${Object.entries(
      value,
    )
      .sort(([a], [b]) =>
        a.localeCompare(b),
      )
      .map(
        ([name, child]) =>
          `${JSON.stringify(
            name,
          )}:${canonical(child)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
