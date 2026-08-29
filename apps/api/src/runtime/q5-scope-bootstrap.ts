import { createHash } from "node:crypto";

import { Q5_MCP_CONTRACT_DIGEST, Q5_MCP_PROFILE } from "@scry/contracts";

export const LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED = "LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED" as const;

export const Q5_CANONICAL_SCOPE = Object.freeze({
  qualificationKey: "m6-q5-authoritative",
  qualificationPolicyVersion: "q5-bootstrap-v1",
  applicationIdentity: "vitract-preview-test",
  environmentClass: "preview_test",
  targetOrigin: "https://preview-api.vitract.com",
  allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
  credentialType: "vitract_partner_api_client_pair",
  protectedPolicy: "atomic_protected_pair_v1",
  mcpProfile: Q5_MCP_PROFILE,
  mcpContractDigest: Q5_MCP_CONTRACT_DIGEST,
} as const);

export const Q5_IDENTITY_CLASSES = Object.freeze({
  stableCanonical: [
    "applicationIdentity",
    "environmentClass",
    "targetOrigin",
    "qualificationPolicyVersion",
    "credentialType",
    "protectedPolicy",
    "mcpProfile",
    "mcpContractDigest",
  ],
  provisionedInstance: [
    "projectId",
    "environmentId",
    "issuanceOperationId",
    "credentialPairReferenceId",
    "clientIdReferenceId",
    "clientSecretReferenceId",
    "preparedScopeId",
  ],
  attempt: [
    "authoritativeAttemptId",
    "campaignId",
    "missionId",
    "objectiveId",
    "agentSessionId",
    "runId",
    "praxisSessionId",
    "externalRunId",
    "correlationId",
  ],
} as const);

export type Q5CanonicalProject = Readonly<{ id: string; designation: string }>;
export type Q5CanonicalEnvironment = Readonly<{
  id: string;
  projectId: string;
  applicationIdentity: string;
  environmentClass: string;
  baseOrigin: string;
  allowedOrigins: readonly string[];
  protectedPolicy: string;
  qualificationCompatible: boolean;
}>;

export type Q5CredentialPair = Readonly<{
  pairReferenceId: string;
  projectId: string;
  environmentId: string;
  applicationIdentity: string;
  issuanceOperationId: string;
  clientIdReferenceId: string;
  clientSecretReferenceId: string;
  credentialType: string;
  protectedPolicy: string;
  provenance: "supported_protected_issuance";
  issuanceState: "completed";
  persistenceState: "committed";
  atomic: boolean;
  active: boolean;
  revoked: boolean;
  expiresAt: string | null;
}>;

export type Q5PreparedScopeFacts = Readonly<{
  sourceCommit: string;
  sourceManifest: string;
  schemaFingerprint: string;
  migrationIdentity: string;
}>;

export type Q5PreparedScope = Q5PreparedScopeFacts &
  Readonly<{
    id: string;
    bindingDigest: string;
    projectId: string;
    environmentId: string;
    applicationIdentity: typeof Q5_CANONICAL_SCOPE.applicationIdentity;
    environmentClass: typeof Q5_CANONICAL_SCOPE.environmentClass;
    targetOrigin: typeof Q5_CANONICAL_SCOPE.targetOrigin;
    allowedOrigins: readonly string[];
    credentialPairReferenceId: string;
    clientIdReferenceId: string;
    clientSecretReferenceId: string;
    issuanceOperationId: string;
    credentialType: typeof Q5_CANONICAL_SCOPE.credentialType;
    protectedPolicy: typeof Q5_CANONICAL_SCOPE.protectedPolicy;
    credentialProvenance: "supported_protected_issuance";
    q5McpProfile: typeof Q5_MCP_PROFILE;
    q5McpContractDigest: typeof Q5_MCP_CONTRACT_DIGEST;
    qualificationPolicyVersion: typeof Q5_CANONICAL_SCOPE.qualificationPolicyVersion;
    state: "prepared";
  }>;

export type Q5ScopeBootstrapStore = {
  exclusively<T>(qualificationKey: string, operation: () => Promise<T>): Promise<T>;
  findCanonicalProjects(designation: string): Promise<Q5CanonicalProject[]>;
  createCanonicalProject(designation: string): Promise<Q5CanonicalProject>;
  findCanonicalEnvironments(projectId: string): Promise<Q5CanonicalEnvironment[]>;
  createCanonicalEnvironment(projectId: string): Promise<Q5CanonicalEnvironment>;
  findCredentialPairs(projectId: string, environmentId: string): Promise<Q5CredentialPair[]>;
  freezePreparedScope(input: Omit<Q5PreparedScope, "id" | "state">): Promise<Q5PreparedScope>;
};

export type Q5BootstrapResult =
  | Readonly<{
      status: "credential_issuance_required";
      code: typeof LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED;
      projectId: string;
      environmentId: string;
      paidAttemptCreated: false;
    }>
  | Readonly<{ status: "prepared"; scope: Q5PreparedScope; paidAttemptCreated: false }>;

export async function bootstrapQ5CanonicalScope(
  store: Q5ScopeBootstrapStore,
  facts: Q5PreparedScopeFacts,
  now = new Date(),
): Promise<Q5BootstrapResult> {
  assertPreparedFacts(facts);
  return store.exclusively(Q5_CANONICAL_SCOPE.qualificationKey, async () => {
    const projects = await store.findCanonicalProjects(Q5_CANONICAL_SCOPE.qualificationKey);
    if (projects.length > 1) throw new Error("Q5_CANONICAL_PROJECT_AMBIGUOUS");
    const project =
      projects[0] ?? (await store.createCanonicalProject(Q5_CANONICAL_SCOPE.qualificationKey));
    const environments = await store.findCanonicalEnvironments(project.id);
    if (environments.length > 1) throw new Error("Q5_CANONICAL_ENVIRONMENT_AMBIGUOUS");
    const environment = environments[0] ?? (await store.createCanonicalEnvironment(project.id));
    assertCanonicalEnvironment(project, environment);
    const pairs = (await store.findCredentialPairs(project.id, environment.id)).filter((pair) =>
      eligiblePair(pair, project, environment, now),
    );
    if (pairs.length === 0)
      return {
        status: "credential_issuance_required",
        code: LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED,
        projectId: project.id,
        environmentId: environment.id,
        paidAttemptCreated: false,
      };
    if (pairs.length > 1) throw new Error("Q5_ELIGIBLE_CREDENTIAL_PAIR_AMBIGUOUS");
    const pair = pairs[0]!;
    const frozen = {
      ...facts,
      bindingDigest: preparedScopeDigest({ facts, project, environment, pair }),
      projectId: project.id,
      environmentId: environment.id,
      applicationIdentity: Q5_CANONICAL_SCOPE.applicationIdentity,
      environmentClass: Q5_CANONICAL_SCOPE.environmentClass,
      targetOrigin: Q5_CANONICAL_SCOPE.targetOrigin,
      allowedOrigins: [...Q5_CANONICAL_SCOPE.allowedOrigins],
      credentialPairReferenceId: pair.pairReferenceId,
      clientIdReferenceId: pair.clientIdReferenceId,
      clientSecretReferenceId: pair.clientSecretReferenceId,
      issuanceOperationId: pair.issuanceOperationId,
      credentialType: Q5_CANONICAL_SCOPE.credentialType,
      protectedPolicy: Q5_CANONICAL_SCOPE.protectedPolicy,
      credentialProvenance: pair.provenance,
      q5McpProfile: Q5_CANONICAL_SCOPE.mcpProfile,
      q5McpContractDigest: Q5_CANONICAL_SCOPE.mcpContractDigest,
      qualificationPolicyVersion: Q5_CANONICAL_SCOPE.qualificationPolicyVersion,
    } as const;
    const scope = await store.freezePreparedScope(frozen);
    assertPreparedScopeValid(scope, facts, pair, now);
    return { status: "prepared", scope, paidAttemptCreated: false };
  });
}

export function assertPreparedScopeValid(
  scope: Q5PreparedScope,
  currentFacts: Q5PreparedScopeFacts,
  currentPair: Q5CredentialPair,
  now = new Date(),
) {
  assertPreparedFacts(currentFacts);
  if (scope.state !== "prepared") throw new Error("Q5_PREPARED_SCOPE_NOT_ACTIVE");
  if (
    scope.sourceCommit !== currentFacts.sourceCommit ||
    scope.sourceManifest !== currentFacts.sourceManifest ||
    scope.schemaFingerprint !== currentFacts.schemaFingerprint ||
    scope.migrationIdentity !== currentFacts.migrationIdentity
  )
    throw new Error("Q5_PREPARED_SCOPE_SOURCE_RUNTIME_CHANGED");
  if (
    !eligiblePair(
      currentPair,
      { id: scope.projectId },
      {
        id: scope.environmentId,
        applicationIdentity: scope.applicationIdentity,
      },
      now,
    )
  )
    throw new Error("Q5_PREPARED_SCOPE_CREDENTIAL_INVALID");
  if (
    currentPair.pairReferenceId !== scope.credentialPairReferenceId ||
    currentPair.issuanceOperationId !== scope.issuanceOperationId ||
    currentPair.clientIdReferenceId !== scope.clientIdReferenceId ||
    currentPair.clientSecretReferenceId !== scope.clientSecretReferenceId
  )
    throw new Error("Q5_PREPARED_SCOPE_CREDENTIAL_CHANGED");
  const digest = preparedScopeDigest({
    facts: currentFacts,
    project: { id: scope.projectId, designation: Q5_CANONICAL_SCOPE.qualificationKey },
    environment: {
      id: scope.environmentId,
      projectId: scope.projectId,
      applicationIdentity: scope.applicationIdentity,
      environmentClass: scope.environmentClass,
      baseOrigin: scope.targetOrigin,
      allowedOrigins: scope.allowedOrigins,
      protectedPolicy: scope.protectedPolicy,
      qualificationCompatible: true,
    },
    pair: currentPair,
  });
  if (digest !== scope.bindingDigest) throw new Error("Q5_PREPARED_SCOPE_MUTATED");
}

function assertCanonicalEnvironment(
  project: Q5CanonicalProject,
  environment: Q5CanonicalEnvironment,
) {
  if (
    environment.projectId !== project.id ||
    environment.applicationIdentity !== Q5_CANONICAL_SCOPE.applicationIdentity ||
    environment.environmentClass !== Q5_CANONICAL_SCOPE.environmentClass ||
    environment.baseOrigin !== Q5_CANONICAL_SCOPE.targetOrigin ||
    environment.protectedPolicy !== Q5_CANONICAL_SCOPE.protectedPolicy ||
    !environment.qualificationCompatible ||
    stableJson([...environment.allowedOrigins].sort()) !==
      stableJson([...Q5_CANONICAL_SCOPE.allowedOrigins].sort())
  )
    throw new Error("Q5_CANONICAL_APPLICATION_ENVIRONMENT_MISMATCH");
}

function eligiblePair(
  pair: Q5CredentialPair,
  project: Pick<Q5CanonicalProject, "id">,
  environment: Pick<Q5CanonicalEnvironment, "id" | "applicationIdentity">,
  now: Date,
) {
  return (
    pair.projectId === project.id &&
    pair.environmentId === environment.id &&
    pair.applicationIdentity === Q5_CANONICAL_SCOPE.applicationIdentity &&
    pair.applicationIdentity === environment.applicationIdentity &&
    pair.credentialType === Q5_CANONICAL_SCOPE.credentialType &&
    pair.protectedPolicy === Q5_CANONICAL_SCOPE.protectedPolicy &&
    pair.provenance === "supported_protected_issuance" &&
    pair.issuanceState === "completed" &&
    pair.persistenceState === "committed" &&
    pair.atomic &&
    pair.active &&
    !pair.revoked &&
    pair.clientIdReferenceId !== pair.clientSecretReferenceId &&
    (!pair.expiresAt || new Date(pair.expiresAt).getTime() > now.getTime())
  );
}

function preparedScopeDigest(input: {
  facts: Q5PreparedScopeFacts;
  project: Q5CanonicalProject;
  environment: Q5CanonicalEnvironment;
  pair: Q5CredentialPair;
}) {
  return createHash("sha256")
    .update(
      stableJson({
        ...input.facts,
        qualificationKey: Q5_CANONICAL_SCOPE.qualificationKey,
        qualificationPolicyVersion: Q5_CANONICAL_SCOPE.qualificationPolicyVersion,
        projectId: input.project.id,
        environmentId: input.environment.id,
        applicationIdentity: input.environment.applicationIdentity,
        environmentClass: input.environment.environmentClass,
        targetOrigin: input.environment.baseOrigin,
        allowedOrigins: [...input.environment.allowedOrigins].sort(),
        protectedPolicy: input.environment.protectedPolicy,
        credentialPairReferenceId: input.pair.pairReferenceId,
        clientIdReferenceId: input.pair.clientIdReferenceId,
        clientSecretReferenceId: input.pair.clientSecretReferenceId,
        issuanceOperationId: input.pair.issuanceOperationId,
        credentialType: input.pair.credentialType,
        credentialProvenance: input.pair.provenance,
        q5McpProfile: Q5_CANONICAL_SCOPE.mcpProfile,
        q5McpContractDigest: Q5_CANONICAL_SCOPE.mcpContractDigest,
      }),
    )
    .digest("hex");
}

function assertPreparedFacts(facts: Q5PreparedScopeFacts) {
  if (!/^[a-f0-9]{40}$/.test(facts.sourceCommit)) throw new Error("Q5_SOURCE_COMMIT_INVALID");
  for (const value of [facts.sourceManifest, facts.schemaFingerprint, facts.migrationIdentity])
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Q5_SOURCE_RUNTIME_IDENTITY_INVALID");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, candidate]) => `${JSON.stringify(key)}:${stableJson(candidate)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
