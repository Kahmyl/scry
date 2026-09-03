import {
  randomUUID,
} from "node:crypto";
import {
  readFile,
  stat,
} from "node:fs/promises";

import type {
  Artifact,
  VeilEvidenceManifest,
} from "@scry/contracts";

import {
  artifactSha256,
} from "./integrity.js";

import {
  signVeilEvidenceAdmission,
} from "./admission.js";

export type ArtifactMaterializationBinding =
  Readonly<{
    evidenceId: string;
    contentDigest: string;
  }>;

export type ArtifactMaterializationAuthorization =
  Readonly<{
    admissionKey: string;
    manifest: VeilEvidenceManifest;
    sanitation: Readonly<
      Record<string, unknown>
    >;
    privacyClassification:
      | "safe"
      | "sanitized";
  }>;

export async function materializeAvailableArtifact<
  Prepared,
>(
  input: Readonly<{
    kind: Artifact["kind"];
    contentType: string;
    filePath: string;
    relativePath?: string;
    prepared: Prepared;
    finalize: (
      prepared: Prepared,
      binding: ArtifactMaterializationBinding,
    ) =>
      | ArtifactMaterializationAuthorization
      | Promise<ArtifactMaterializationAuthorization>;
  }>,
): Promise<Artifact> {
  const [
    data,
    metadata,
  ] = await Promise.all([
    readFile(input.filePath),
    stat(input.filePath),
  ]);

  const evidenceId =
    randomUUID();

  const contentDigest =
    artifactSha256(data);

  const authorization =
    await input.finalize(
      input.prepared,
      {
        evidenceId,
        contentDigest,
      },
    );

  if (
    authorization.manifest
      .evidenceId !==
    evidenceId
  ) {
    throw new Error(
      "VEIL_EVIDENCE_ID_MISMATCH",
    );
  }

  if (
    authorization.manifest
      .contentDigest !==
    contentDigest
  ) {
    throw new Error(
      "VEIL_EVIDENCE_DIGEST_MISMATCH",
    );
  }

  const proof =
    signVeilEvidenceAdmission(
      authorization.manifest,
      authorization.admissionKey,
      authorization.sanitation,
    );

  return {
    id: evidenceId,
    kind: input.kind,
    availability: "available",
    privacyClassification:
      authorization
        .privacyClassification,
    contentType:
      input.contentType,
    sizeBytes: metadata.size,
    checksumSha256:
      contentDigest,
    ...(input.relativePath
      ? {
          relativePath:
            input.relativePath,
        }
      : {}),
    observation: {
      veilManifest:
        proof.manifest,
      veilAdmissionToken:
        proof.token,
      veilSanitation:
        authorization.sanitation,
    },
  };
}
