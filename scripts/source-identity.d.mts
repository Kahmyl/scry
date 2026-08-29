export interface RepositorySourceIdentity {
  readonly commitSha: string;
  readonly dirty: boolean;
  readonly manifestSha256: string;
}

export function deriveRepositorySourceIdentity(
  repositoryRootInput?: string,
): RepositorySourceIdentity;

export function assertAuthoritativeSourceIdentity(
  actual: RepositorySourceIdentity,
  expected: Pick<RepositorySourceIdentity, "commitSha" | "manifestSha256">,
): void;

export function assertRuntimeSourceIdentity(
  runtime: {
    readonly gitCommit: string;
    readonly dirty: boolean | null;
    readonly manifestSha256: string;
  },
  expected: RepositorySourceIdentity,
): void;

export function sourceIdentityEnvironment(identity: RepositorySourceIdentity): {
  readonly SCRY_GIT_COMMIT: string;
  readonly SCRY_SOURCE_DIRTY: "true" | "false";
  readonly SCRY_SOURCE_MANIFEST_SHA256: string;
};
