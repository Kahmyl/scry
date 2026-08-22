import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { materializeAvailableArtifact } from "@scry/chronicle";

import type { Artifact } from "@scry/contracts";

import {
  finalizeVeilArtifactEvidence,
  prepareVeilArtifactEvidence,
  registerVeilEvidenceAdmission,
  type VeilArtifactEvidence,
} from "@scry/veil";

export { registerVeilEvidenceAdmission };

export async function ensureOutputDirectories(root: string): Promise<void> {
  await Promise.all(
    ["screenshots", "dom", "network", "video"].map((directory) =>
      mkdir(path.join(root, directory), {
        recursive: true,
      }),
    ),
  );
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function availableArtifact(
  kind: Artifact["kind"],
  contentType: string,
  filePath: string,
  relativePath?: string,
  evidence?: VeilArtifactEvidence,
): Promise<Artifact> {
  const prepared = prepareVeilArtifactEvidence({
    kind,
    filePath,
    evidence,
  });

  return materializeAvailableArtifact({
    kind,
    contentType,
    filePath,
    ...(relativePath
      ? {
          relativePath,
        }
      : {}),
    prepared,
    finalize: finalizeVeilArtifactEvidence,
  });
}
