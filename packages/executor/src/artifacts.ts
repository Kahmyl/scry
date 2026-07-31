import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Artifact } from "@scry/contracts";

export async function ensureOutputDirectories(root: string) {
  await Promise.all(
    ["screenshots", "dom", "network", "video"].map((directory) =>
      mkdir(path.join(root, directory), { recursive: true }),
    ),
  );
}

export async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function availableArtifact(
  kind: Artifact["kind"],
  contentType: string,
  filePath: string,
  relativePath?: string,
): Promise<Artifact> {
  const [data, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    id: randomUUID(),
    kind,
    status: "available",
    contentType,
    sizeBytes: metadata.size,
    checksumSha256: createHash("sha256").update(data).digest("hex"),
    ...(relativePath ? { relativePath } : {}),
  };
}
