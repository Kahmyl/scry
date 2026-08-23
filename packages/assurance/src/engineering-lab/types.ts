export type EngineeringLabNetworkPolicy = "disabled";

export interface EngineeringLabCommand {
  executable: string;
  args: readonly string[];
  relativeCwd?: string;
  timeoutMs: number;
}

export interface EngineeringLabVerificationContract {
  id: string;
  claim: string;
  command: EngineeringLabCommand;
  reproductionExpectedExitCode: number;
  candidateExpectedExitCode: number;
}

export interface EngineeringLabRuntimeRequirements {
  database: "isolated_local_directory";
  queue: "isolated_local_namespace";
  browser: "isolated_local_profile";
  fixtures: readonly string[];
  portCount: number;
}

export interface EngineeringLabUntrackedPolicy {
  allowedPathPrefixes: readonly string[];
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface EngineeringLabAdapterDescriptor {
  id: string;
  kind: "deterministic_fake" | "capable_agent";
  provider: string;
  version: string;
}

export interface EngineeringLabCohortAvailability {
  cohort: string;
  status: "available" | "unavailable";
  reason?: string;
  inspectedCapabilities?: readonly string[];
}

export interface EngineeringLabManifestInput {
  experimentId: string;
  issueId: string;
  sourceRoot: string;
  artifactRoot: string;
  invariants: readonly string[];
  verification: EngineeringLabVerificationContract;
  runtime: EngineeringLabRuntimeRequirements;
  untrackedPolicy: EngineeringLabUntrackedPolicy;
  approvedAdapter: EngineeringLabAdapterDescriptor;
  adapterCohorts: readonly EngineeringLabCohortAvailability[];
  networkPolicy: EngineeringLabNetworkPolicy;
  externalSystemPolicy: "none";
  createdAt?: string;
}

export interface EngineeringLabSourceFingerprint {
  headSha: string;
  branch: string | null;
  trackedPatchDigest: string;
  statusDigest: string;
  untrackedPathDigest: string;
  untrackedMetadataDigest: string;
  selectedUntrackedContentDigest: string;
}

export interface EngineeringLabCapturedFile {
  path: string;
  digest: string;
  bytes: number;
  executable: boolean;
  blobRef: string;
}

export interface EngineeringLabExcludedFile {
  path: string;
  reason:
    | "not_explicitly_allowed"
    | "secret_or_credential"
    | "generated_or_artifact"
    | "unsupported_file_type"
    | "file_too_large"
    | "total_size_limit";
}

export interface EngineeringLabSourceCapture {
  sourceRoot: string;
  headSha: string;
  treeSha: string;
  branch: string | null;
  trackedPatchRef: string;
  trackedPatchDigest: string;
  trackedPatchBytes: number;
  untrackedManifestRef: string;
  untrackedBundleDigest: string;
  selectedUntrackedFiles: readonly EngineeringLabCapturedFile[];
  excludedUntrackedFiles: readonly EngineeringLabExcludedFile[];
  sourceFingerprint: EngineeringLabSourceFingerprint;
}

export interface EngineeringLabManifest {
  schemaVersion: 1;
  experimentId: string;
  issueId: string;
  createdAt: string;
  source: Omit<EngineeringLabSourceCapture, "sourceRoot" | "sourceFingerprint">;
  invariants: readonly string[];
  verification: EngineeringLabVerificationContract;
  runtimeRequirements: EngineeringLabRuntimeRequirements;
  approvedAdapter: EngineeringLabAdapterDescriptor;
  adapterCohorts: readonly EngineeringLabCohortAvailability[];
  policies: {
    network: EngineeringLabNetworkPolicy;
    externalSystems: "none";
    productionCredentials: "forbidden";
    providerMutations: "forbidden";
    sourcePatchApplication: "forbidden";
  };
}

export type EngineeringLabLedgerEntryType =
  | "provision"
  | "reproduction"
  | "hypothesis"
  | "candidate_patch"
  | "verification"
  | "observation"
  | "cost"
  | "teardown"
  | "source_proof";

export interface EngineeringLabLedgerEntryInput {
  timestamp?: string;
  type: EngineeringLabLedgerEntryType;
  summary: string;
  evidenceRefs?: readonly string[];
  command?: EngineeringLabCommand;
  durationMs?: number;
  costUsd?: number;
  facts?: Readonly<Record<string, unknown>>;
}

export interface EngineeringLabLedgerEntry extends EngineeringLabLedgerEntryInput {
  sequence: number;
  timestamp: string;
  previousHash: string | null;
  hash: string;
}

export interface EngineeringAgentAttempt {
  id: string;
  hypothesis: string;
  patch: string;
}

export interface EngineeringAgentRequest {
  experimentId: string;
  issueId: string;
  workspaceRoot: string;
  manifestPath: string;
  invariants: readonly string[];
  verification: EngineeringLabVerificationContract;
  reproductionArtifactRef: string;
}

export interface EngineeringAgentPlan {
  attempts: readonly EngineeringAgentAttempt[];
  durationMs: number;
  cost: {
    currency: "USD";
    amount: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface EngineeringAgentAdapter {
  readonly descriptor: EngineeringLabAdapterDescriptor;
  propose(request: EngineeringAgentRequest): Promise<EngineeringAgentPlan>;
}

export interface EngineeringLabRuntimeIdentity {
  runId: string;
  composeProjectName: string;
  databaseDirectory: string;
  databaseName: string;
  queueDirectory: string;
  queueNamespace: string;
  browserProfileDirectory: string;
  fixtureDirectory: string;
  artifactDirectory: string;
  ports: readonly number[];
  environment: Readonly<Record<string, string>>;
}

export interface EngineeringLabCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface EngineeringLabVerificationResult {
  contractId: string;
  phase: "reproduction" | "candidate";
  expectedExitCode: number;
  matchedExpectation: boolean;
  workspaceUnchangedDuringVerification: boolean;
  commandResult: EngineeringLabCommandResult;
}

export interface EngineeringLabAttemptResult {
  attemptId: string;
  hypothesis: string;
  status: "failed" | "proven";
  patchRef: string;
  verificationRef: string;
  changedFiles: readonly string[];
  verification: EngineeringLabVerificationResult;
}

export interface EngineeringLabTeardownResult {
  worktreeRemoved: boolean;
  runtimeRemoved: boolean;
  errors: readonly string[];
}

export interface EngineeringLabSourceProof {
  unchanged: boolean;
  before: EngineeringLabSourceFingerprint;
  after: EngineeringLabSourceFingerprint;
  mismatches: readonly string[];
}

export interface EngineeringLabReport {
  schemaVersion: 1;
  experimentId: string;
  issueId: string;
  status: "candidate_proven" | "candidate_failed" | "reproduction_failed" | "lab_failed";
  manifestRef: string;
  ledgerRef: string;
  ledgerVerificationRef: string;
  reproductionRef: string;
  attempts: readonly EngineeringLabAttemptResult[];
  candidatePatchRef: string | null;
  changedFiles: readonly string[];
  verificationRef: string | null;
  adapter: EngineeringLabAdapterDescriptor;
  adapterCohorts: readonly EngineeringLabCohortAvailability[];
  cost: EngineeringAgentPlan["cost"] | null;
  durationMs: number;
  teardown: EngineeringLabTeardownResult;
  sourceProof: EngineeringLabSourceProof;
  authorizationRequired: true;
  candidateAutoApplied: false;
}

export interface EngineeringLabRunResult {
  artifactRoot: string;
  manifest: EngineeringLabManifest;
  report: EngineeringLabReport;
}
