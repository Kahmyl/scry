import type { EvidenceClosureIssue } from "@scry/contracts";

/** Construct only at a known artifact operation. Never wrap database authority,
 * cancellation or arbitrary controller exceptions as an availability decision. */
export class EvidenceArtifactFailure extends Error {
  constructor(readonly issue: EvidenceClosureIssue) {
    super("SCRY_BROWSER_EVIDENCE_ARTIFACT_UNAVAILABLE");
    this.name = "EvidenceArtifactFailure";
  }
}

export function isArtifactFilesystemFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    [
      "ENOENT",
      "EACCES",
      "EPERM",
      "ENOSPC",
      "EROFS",
      "EIO",
      "EMFILE",
      "ENFILE",
      "ENOTDIR",
      "EISDIR",
      "ELOOP",
    ].includes(error.code)
  );
}
