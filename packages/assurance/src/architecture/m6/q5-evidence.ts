import { createHash } from "node:crypto";
import {
  Q5_MCP_CONTRACT_DIGEST,
  Q5_MCP_PROTOCOL_VERSION,
  Q5_MCP_TOOL_NAMES,
  Q5_REQUIRED_EVIDENCE_KINDS,
} from "@scry/contracts";

export const Q5_EVIDENCE_SCHEMA = "scry.m6.q5.vitract-authoritative.v1" as const;

export type Q5RequiredEvidence = Readonly<{
  kind:
    | "public_discovery"
    | "protected_authentication"
    | "business_mutation"
    | "external_effect_binding"
    | "exact_retrieval"
    | "run_operation"
    | "run_finalization"
    | "objective_acceptance"
    | "mission_report";
  state: "accepted" | "failed" | "quarantined" | "missing" | "unknown";
  required: true;
  proof: readonly string[];
}>;

export type Q5EvidenceManifest = Readonly<{
  schema: typeof Q5_EVIDENCE_SCHEMA;
  qualification: "M6_Q5_VITRACT_PREVIEW_TEST";
  source: {
    commit: string;
    dirty: false;
    manifestSha256: string;
    schemaFingerprint: string;
    migrationSha256: string;
    runtimeManifestSha256: string;
  };
  authority: {
    authoritativeAttemptId: string;
    authoritativeAttemptState: "succeeded" | "failed" | "inconclusive" | "cancelled";
    campaignId: string;
    campaignDisposition: "succeeded" | "failed" | "inconclusive" | "expired" | "revoked";
    projectId: string;
    environmentId: string;
    canonicalApplicationId: string;
    applicationIdentity: "vitract-preview-test";
    origin: string;
    missionId: string;
    objectiveId: string;
    agentSessionId: string;
    externalRunId: string;
  };
  runtime: {
    runId: string;
    runState: "passed" | "failed" | "inconclusive";
    attemptId: string;
    attemptState: "succeeded" | "failed" | "cancelled";
    praxisSessionId: string;
    praxisState: "completed" | "failed" | "recovery_required";
    agentSessionState: "completed" | "failed";
    missionState: "completed" | "failed";
    objectiveState: "passed" | "failed";
    reportState: "published" | "failed";
  };
  protectedOperation: {
    id: string;
    state: "succeeded" | "failed" | "unknown";
    plaintextExposed: false;
  };
  mutation: {
    operationId: string;
    identity: string;
    outcome: "applied" | "not_applied" | "unknown";
    campaignConsumptions: number;
    dispatches: number;
    externalRequests: number;
    externalEffects: number;
    duplicates: number;
    redispatches: number;
  };
  retrieval: {
    createdOpaqueDigest: string;
    retrievedOpaqueDigest: string;
    association: "exact_digest_match" | "mismatch" | "missing";
    retrievalCount: number;
  };
  evidence: Q5RequiredEvidence[];
  provider: {
    name: "deepseek";
    model: string;
    requestCount: number;
    automaticRetries: 0;
  };
  mcp: {
    profile: "q5-authoritative-v1";
    protocolVersion: string;
    toolCount: number;
    contractDigest: string;
  };
  privacy: { audit: "PASS" | "FAIL"; protectedLeakCount: number };
  residue: { adjudication: "PASS" | "FAIL"; unsafeLiveOwners: number; unknownPreserved: boolean };
}>;

export type Q5EvidenceExpectation = Readonly<{
  sourceCommit: string;
  sourceManifestSha256: string;
  schemaFingerprint: string;
  migrationSha256: string;
  canonicalApplicationId?: string;
  projectId?: string;
  environmentId?: string;
}>;

const requiredEvidenceKinds: readonly Q5RequiredEvidence["kind"][] = Q5_REQUIRED_EVIDENCE_KINDS;

export function validateQ5EvidenceManifest(
  candidate: unknown,
  expected: Q5EvidenceExpectation,
): { pass: boolean; issues: string[]; manifest?: Q5EvidenceManifest } {
  const issues: string[] = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return { pass: false, issues: ["Q5_MANIFEST_INVALID"] };
  const manifest = candidate as Q5EvidenceManifest;
  const same = (actual: unknown, value: unknown, code: string) => {
    if (actual !== value) issues.push(code);
  };
  same(manifest.schema, Q5_EVIDENCE_SCHEMA, "Q5_SCHEMA_MISMATCH");
  same(manifest.qualification, "M6_Q5_VITRACT_PREVIEW_TEST", "Q5_GENERIC_FIXTURE_FORBIDDEN");
  same(manifest.source?.commit, expected.sourceCommit, "Q5_SOURCE_COMMIT_MISMATCH");
  same(manifest.source?.dirty, false, "Q5_DIRTY_SOURCE");
  same(
    manifest.source?.manifestSha256,
    expected.sourceManifestSha256,
    "Q5_SOURCE_MANIFEST_MISMATCH",
  );
  same(
    manifest.source?.runtimeManifestSha256,
    expected.sourceManifestSha256,
    "Q5_RUNTIME_SOURCE_MISMATCH",
  );
  same(
    manifest.source?.schemaFingerprint,
    expected.schemaFingerprint,
    "Q5_SCHEMA_FINGERPRINT_MISMATCH",
  );
  same(manifest.source?.migrationSha256, expected.migrationSha256, "Q5_MIGRATION_MISMATCH");
  same(manifest.authority?.applicationIdentity, "vitract-preview-test", "Q5_APPLICATION_MISMATCH");
  if (expected.canonicalApplicationId)
    same(
      manifest.authority?.canonicalApplicationId,
      expected.canonicalApplicationId,
      "Q5_APPLICATION_MISMATCH",
    );
  if (expected.projectId)
    same(manifest.authority?.projectId, expected.projectId, "Q5_PROJECT_MISMATCH");
  if (expected.environmentId)
    same(manifest.authority?.environmentId, expected.environmentId, "Q5_ENVIRONMENT_MISMATCH");
  for (const [key, value] of Object.entries(manifest.authority ?? {}))
    if (key.endsWith("Id") && (typeof value !== "string" || !value))
      issues.push(`Q5_${key.toUpperCase()}_MISSING`);
  same(manifest.authority?.authoritativeAttemptState, "succeeded", "Q5_ATTEMPT_NOT_SUCCEEDED");
  same(manifest.authority?.campaignDisposition, "succeeded", "Q5_CAMPAIGN_NOT_SUCCEEDED");
  if (!isOrigin(manifest.authority?.origin)) issues.push("Q5_ORIGIN_INVALID");
  same(manifest.runtime?.runState, "passed", "Q5_RUN_NOT_SUCCEEDED");
  same(manifest.runtime?.attemptState, "succeeded", "Q5_RUN_ATTEMPT_NOT_SUCCEEDED");
  same(manifest.runtime?.praxisState, "completed", "Q5_PRAXIS_NOT_COMPLETED");
  same(manifest.runtime?.agentSessionState, "completed", "Q5_AGENT_NOT_ENDED");
  same(manifest.runtime?.missionState, "completed", "Q5_MISSION_NOT_COMPLETED");
  same(manifest.runtime?.objectiveState, "passed", "Q5_OBJECTIVE_NOT_ACCEPTED");
  same(manifest.runtime?.reportState, "published", "Q5_REPORT_NOT_PUBLISHED");
  same(manifest.protectedOperation?.state, "succeeded", "Q5_PROTECTED_AUTH_NOT_SUCCEEDED");
  same(manifest.protectedOperation?.plaintextExposed, false, "Q5_PROTECTED_PLAINTEXT_EXPOSED");
  same(manifest.mutation?.outcome, "applied", "Q5_MUTATION_NOT_APPLIED");
  for (const [key, value] of [
    ["campaignConsumptions", manifest.mutation?.campaignConsumptions],
    ["dispatches", manifest.mutation?.dispatches],
    ["externalRequests", manifest.mutation?.externalRequests],
    ["externalEffects", manifest.mutation?.externalEffects],
  ] as const)
    same(value, 1, `Q5_MUTATION_${key.toUpperCase()}_NOT_ONE`);
  same(manifest.mutation?.duplicates, 0, "Q5_DUPLICATE_EFFECT");
  same(manifest.mutation?.redispatches, 0, "Q5_REDISPATCH");
  same(manifest.retrieval?.association, "exact_digest_match", "Q5_RETRIEVAL_NOT_EXACT");
  same(manifest.retrieval?.retrievalCount, 1, "Q5_RETRIEVAL_COUNT_NOT_ONE");
  if (!digest(manifest.retrieval?.createdOpaqueDigest)) issues.push("Q5_CREATED_DIGEST_INVALID");
  if (!digest(manifest.retrieval?.retrievedOpaqueDigest))
    issues.push("Q5_RETRIEVED_DIGEST_INVALID");
  if (manifest.retrieval?.createdOpaqueDigest !== manifest.retrieval?.retrievedOpaqueDigest)
    issues.push("Q5_CREATE_RETRIEVE_MISMATCH");
  const evidence = Array.isArray(manifest.evidence) ? manifest.evidence : [];
  for (const kind of requiredEvidenceKinds) {
    const matches = evidence.filter((item) => item?.kind === kind && item.required === true);
    if (matches.length !== 1 || matches[0]?.state !== "accepted")
      issues.push(`Q5_REQUIRED_EVIDENCE_${kind.toUpperCase()}_NOT_ACCEPTED`);
    if (
      matches.length === 1 &&
      (!Array.isArray(matches[0]?.proof) ||
        matches[0]!.proof.length === 0 ||
        matches[0]!.proof.some((entry) => typeof entry !== "string" || entry.length === 0))
    )
      issues.push(`Q5_REQUIRED_EVIDENCE_${kind.toUpperCase()}_PROOF_MISSING`);
  }
  same(manifest.provider?.name, "deepseek", "Q5_PROVIDER_MISMATCH");
  same(manifest.provider?.automaticRetries, 0, "Q5_PROVIDER_RETRY_ENABLED");
  if (!Number.isInteger(manifest.provider?.requestCount) || manifest.provider.requestCount < 1)
    issues.push("Q5_PROVIDER_REQUEST_ACCOUNTING_INVALID");
  same(manifest.mcp?.profile, "q5-authoritative-v1", "Q5_MCP_PROFILE_MISMATCH");
  same(manifest.mcp?.protocolVersion, Q5_MCP_PROTOCOL_VERSION, "Q5_MCP_PROTOCOL_MISMATCH");
  same(manifest.mcp?.toolCount, Q5_MCP_TOOL_NAMES.length, "Q5_MCP_TOOL_COUNT_MISMATCH");
  same(manifest.mcp?.contractDigest, Q5_MCP_CONTRACT_DIGEST, "Q5_MCP_DIGEST_MISMATCH");
  same(manifest.privacy?.audit, "PASS", "Q5_PRIVACY_AUDIT_FAILED");
  same(manifest.privacy?.protectedLeakCount, 0, "Q5_PROTECTED_LEAK");
  same(manifest.residue?.adjudication, "PASS", "Q5_RESIDUE_FAILED");
  same(manifest.residue?.unsafeLiveOwners, 0, "Q5_UNSAFE_LIVE_RESIDUE");
  return issues.length ? { pass: false, issues } : { pass: true, issues, manifest };
}

export function opaqueExternalIdentity(value: string) {
  return createHash("sha256").update(`scry-q5-external-identity\0${value}`).digest("hex");
}

function digest(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isOrigin(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}
