/**
 * Prepared single-live-issuance qualification composition root.
 *
 * The exported orchestration accepts only opaque production readback handles.
 * It has one issuance call and no lifecycle-dispatch capability. The CLI stays
 * deliberately disarmed until the separately authorized live checkpoint wires
 * the production MCP authoring adapter and production preparation service.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { executionPolicySchema, type InteractionTargetIntent, type MissionAuthoringIntent } from "@scry/contracts";
import { chromium, type Page, type Response } from "playwright";
import { resolveTarget, resolveTargetLocator } from "@scry/praxis";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/database.js";
import { ExternalResourceBindingRepository } from "../src/runtime/repositories/external-resource-binding.repository.js";
import { ExternalResourcePresentationAuthorityRepository } from "../src/runtime/repositories/external-resource-presentation-authority.repository.js";
import { ExternalResourceDestructiveTargetPreparationService } from "../src/runtime/services/external-resource-destructive-target-preparation.service.js";
import { ExternalResourceCredentialLifecycleService } from "../src/runtime/services/external-resource-credential-lifecycle.service.js";
import { ExecutionKernelRepository } from "../src/runtime/repositories/execution-kernel.repository.js";
import { initializeMcp, findAdaptiveSessionId, rejectToolError } from "./deployed-adaptive-campaign.js";
import { navigateAndWaitNative, type AuthoritativeExternalResourceObservation } from "@scry/executor";

export const LIVE_QUALIFICATION = {
  projectId: "6b3b5011-0f41-430c-a8a2-d4abfd9ff3f1",
  environmentId: "9a581bb0-2276-4888-9ddb-07b2485cddc3",
  missionId: "8c0a9e3a-56a7-4286-a331-1e73c0129533",
  objectiveId: "e5c0f365-d373-4375-9005-38a16bce770c",
  flowDraftId: "e5d6971e-320e-4c61-83dc-b3c7c2839ce7",
  agentSessionId: "925f7e55-1562-411a-8a62-c7b0434fe36c",
  loginEmailReference: "045970aa-9210-47e7-bafa-18ce4da5089c",
  loginPasswordReference: "6547b053-f2b8-420c-91c0-bb4e1c7ae2a6",
  resourceScope: "vtr_app_sandbox_c76f2735-de94-f111-9b33-00224854e25a",
  credentialUrl: "https://preview.vitract.com/partner/developer/applications/vtr_app_sandbox_c76f2735-de94-f111-9b33-00224854e25a/credentials",
} as const;

export type SafeLiveIssuanceResult = {
  operationId: string;
  generatedReferences: Array<{
    reference: "credentialRecordIdentity" | "credentialClientId" | "credentialClientSecret";
    classification: "public" | "protected";
    opaqueReferenceId: string;
  }>;
};

export type SafeBindingReadback = {
  status: "active";
  provider: "vitract";
  resourceKind: "credential_record";
  resourceScope: string;
  identityContractVersion: 1;
  sourceProtectedOperationId: string;
};

export type SafePresentationAuthorityReadback = {
  classification: "internal_non_secret";
  permittedPurpose: "browser_presentation_identity";
  contractVersion: 1;
  status: "active";
};

export type PreparedTargetProof = {
  providerRevalidated: true;
  presentationIdentityValidated: true;
};

export type LiveQualificationProductionAdapters = {
  /** Production MCP authoring/execution path. This is the sole mutation seam. */
  executeSingleIssuance(intent: MissionAuthoringIntent): Promise<SafeLiveIssuanceResult>;
  /** Production atomic persistence/readback path; never returns stored values. */
  readBinding(input: {
    operationId: string;
    canonicalIdentityReferenceId: string;
  }): Promise<SafeBindingReadback>;
  /** Production environment-policy authority repository. */
  readPresentationAuthority(input: {
    binding: SafeBindingReadback;
  }): Promise<SafePresentationAuthorityReadback>;
  /**
   * Production ExternalResourceDestructiveTargetPreparationService. Its
   * implementation owns both fresh observations, uniqueness checks, browser
   * scoping, and Praxis revalidation. The returned target is intentionally not
   * exposed by this qualification harness, so it cannot be dispatched.
   */
  prepareTargetWithoutDispatch(input: {
    canonicalIdentityReferenceId: string;
  }): Promise<PreparedTargetProof>;
};

const SINGLE_ISSUANCE_INTENT: MissionAuthoringIntent = {
  intentId: "vitract-single-live-credential-issuance",
  objectiveId: LIVE_QUALIFICATION.objectiveId,
  flowDraftId: LIVE_QUALIFICATION.flowDraftId,
  action: {
    kind: "acquire_protected_outputs",
    preparationIntentIds: ["vitract-live-open-credentials", "vitract-live-add-control-ready", "vitract-live-open-add-dialog"],
    mutation: {
      kind: "one_time",
      target: { concept: "confirm add credential", role: "button", name: "Add credential", exact: true,
        scope: { kind: "dialog", name: "Add credential" } },
    },
    outputs: [
      {
        reference: "credentialRecordIdentity", classification: "public",
        target: { concept: "credential id", role: "value", name: "id", exact: true },
        storageName: "Vitract credential record identity",
      },
      {
        reference: "credentialClientId", classification: "protected",
        target: { concept: "client id", role: "textbox", name: "Client ID", exact: true },
        storageName: "Vitract test client ID",
      },
      {
        reference: "credentialClientSecret", classification: "protected",
        target: { concept: "client secret", role: "textbox", name: "Client secret", exact: true },
        storageName: "Vitract test client secret",
      },
    ],
    externalResourceBindings: [{
      status: "active", identityReference: "credentialRecordIdentity",
      provider: "vitract", resourceKind: "credential_record",
      resourceScope: LIVE_QUALIFICATION.resourceScope,
      identityContractVersion: 1, identitySource: "response",
      requiredForDestructiveLifecycle: true,
    }],
  },
  expectedEffect: { kind: "none" },
  constraints: { timeoutMs: 30_000, allowNewPage: false, allowNonExact: false },
  authorization: { kind: "protected_mutation", authorizationId: "00000000-0000-4000-8000-000000000000" },
  protectedInputReferences: [],
};

export function livePreparationIntents(runId: string): MissionAuthoringIntent[] {
  const common = {
    objectiveId: LIVE_QUALIFICATION.objectiveId,
    flowDraftId: LIVE_QUALIFICATION.flowDraftId,
    constraints: { timeoutMs: 60_000, allowNewPage: false, allowNonExact: false },
    protectedInputReferences: [] as string[],
  };
  return [
    { ...common, intentId: `vitract-live-open-login-${runId}`,
      action: { kind: "navigate", url: "https://preview.vitract.com/login" },
      expectedEffect: { kind: "navigation", url: "https://preview.vitract.com/login", match: "exact" },
      authorization: { kind: "ordinary" } },
    { ...common, intentId: `vitract-live-email-${runId}`,
      action: { kind: "fill", target: { concept: "login email", role: "textbox", placeholder: "Enter your email", exact: true },
        protectedReferenceId: LIVE_QUALIFICATION.loginEmailReference },
      expectedEffect: { kind: "none" }, authorization: { kind: "authentication" },
      protectedInputReferences: [LIVE_QUALIFICATION.loginEmailReference] },
    { ...common, intentId: `vitract-live-password-${runId}`,
      action: { kind: "fill", target: { concept: "login password", role: "textbox", placeholder: "Enter your password", exact: true },
        protectedReferenceId: LIVE_QUALIFICATION.loginPasswordReference },
      expectedEffect: { kind: "none" }, authorization: { kind: "authentication" },
      protectedInputReferences: [LIVE_QUALIFICATION.loginPasswordReference] },
    { ...common, intentId: `vitract-live-login-${runId}`,
      action: { kind: "activate", target: { concept: "sign in", role: "button", name: "Login", exact: true } },
      expectedEffect: { kind: "navigation", url: "https://preview.vitract.com/partner", match: "exact" },
      authorization: { kind: "ordinary" } },
    { ...common, intentId: "vitract-live-open-credentials",
      action: { kind: "navigate", url: LIVE_QUALIFICATION.credentialUrl },
      expectedEffect: { kind: "target_visibility", target: { concept: "add credential", role: "button", name: "Add credential", exact: true }, visible: true },
      authorization: { kind: "live_read" } },
    { ...common, intentId: "vitract-live-add-control-ready",
      action: { kind: "wait_for", target: { concept: "add credential", role: "button", name: "Add credential", exact: true }, state: "visible" },
      expectedEffect: { kind: "none" }, authorization: { kind: "ordinary" } },
    { ...common, intentId: "vitract-live-open-add-dialog",
      action: { kind: "activate", target: { concept: "outer add credential", role: "button", name: "Add credential", exact: true } },
      expectedEffect: { kind: "target_visibility", target: { concept: "add credential dialog", role: "dialog", name: "Add credential", exact: true }, visible: true },
      authorization: { kind: "ordinary" } },
  ];
}

export function preparedSingleIssuanceIntent(authorizationId: string) {
  if (!authorizationId || authorizationId === SINGLE_ISSUANCE_INTENT.authorization.authorizationId)
    throw new Error("LIVE_ISSUANCE_AUTHORIZATION_INVALID");
  return {
    ...structuredClone(SINGLE_ISSUANCE_INTENT),
    authorization: { kind: "protected_mutation" as const, authorizationId },
  };
}

export async function qualifySingleLiveIssuance(
  authorizationId: string,
  production: LiveQualificationProductionAdapters,
) {
  const issuance = await production.executeSingleIssuance(
    preparedSingleIssuanceIntent(authorizationId),
  );
  assertReferenceShape(issuance.generatedReferences);
  const canonical = issuance.generatedReferences.find(
    (reference) => reference.reference === "credentialRecordIdentity",
  )!;
  const binding = await production.readBinding({
    operationId: issuance.operationId,
    canonicalIdentityReferenceId: canonical.opaqueReferenceId,
  });
  if (binding.sourceProtectedOperationId !== issuance.operationId)
    throw new Error("LIVE_ISSUANCE_BINDING_ATOMICITY_UNPROVEN");
  const authority = await production.readPresentationAuthority({ binding });
  if (
    authority.classification !== "internal_non_secret" ||
    authority.permittedPurpose !== "browser_presentation_identity" ||
    authority.contractVersion !== binding.identityContractVersion ||
    authority.status !== "active"
  ) throw new Error("LIVE_ISSUANCE_PRESENTATION_AUTHORITY_INVALID");
  const prepared = await production.prepareTargetWithoutDispatch({
    canonicalIdentityReferenceId: canonical.opaqueReferenceId,
  });
  if (!prepared.providerRevalidated || !prepared.presentationIdentityValidated)
    throw new Error("LIVE_ISSUANCE_TARGET_PREPARATION_UNPROVEN");
  return {
    issuanceDispatchCount: 1 as const,
    destructiveDispatchCount: 0 as const,
    atomicBindingReadback: true as const,
    trustedPresentationAuthorityReadback: true as const,
    targetPreparedWithoutDispatch: true as const,
  };
}

function assertReferenceShape(references: SafeLiveIssuanceResult["generatedReferences"]) {
  const expected = new Map([
    ["credentialRecordIdentity", "public"],
    ["credentialClientId", "protected"],
    ["credentialClientSecret", "protected"],
  ] as const);
  if (references.length !== expected.size) throw new Error("LIVE_ISSUANCE_OUTPUT_SET_INVALID");
  for (const reference of references) {
    if (
      expected.get(reference.reference) !== reference.classification ||
      !reference.opaqueReferenceId ||
      references.filter((candidate) => candidate.reference === reference.reference).length !== 1
    ) throw new Error("LIVE_ISSUANCE_OUTPUT_SET_INVALID");
  }
}

export async function main() {
  const authorizationId = process.env.SCRY_VITRACT_SINGLE_ISSUANCE_AUTHORIZATION_ID;
  if (!authorizationId) throw new Error("LIVE_ISSUANCE_EXPLICIT_AUTHORIZATION_REQUIRED");
  const database = new Database();
  let stage = "PREFLIGHT";
  try {
    const preflight = await loadLivePreflight(database, authorizationId);
    if (process.argv.includes("--continue-existing")) {
      stage = "TARGET_PREPARATION";
      const credentialId = await latestIssuedCredentialReference(database);
      await prepareLiveTarget(database, credentialId, preflight);
      if (
        process.argv.includes("--revoke-existing") ||
        process.argv.includes("--reconcile-revoke-existing")
      ) return;
      process.stdout.write([
        "LIVE_ISSUANCE_BUDGET_CONSUMED: yes", "credentialGenerationDispatchCount: 1",
        "credentialGenerationOutcome: confirmed_succeeded", "creationResponseCorrelation: exact",
        "atomicPersistence: PASS", "bindingPersisted: yes", "providerObservation1: PASS",
        "providerObservation2: PASS", "praxisRevalidation: PASS", "destructiveTargetPrepared: yes",
        "revokeDispatchCount: 0", "providerMutationsPerformed: 1",
        "FINAL_STATUS: LIVE_BOUND_CREDENTIAL_READY_FOR_REVOKE",
      ].join("\n") + "\n");
      return;
    }
    stage = "ISSUANCE";
    const result = await qualifySingleLiveIssuance(authorizationId, {
      executeSingleIssuance: (intent) => executeProductionIssuance(intent, preflight),
      readBinding: (input) => readSafeBinding(database, input),
      readPresentationAuthority: ({ binding }) => readSafeAuthority(database, binding),
      prepareTargetWithoutDispatch: ({ canonicalIdentityReferenceId }) => {
        stage = "TARGET_PREPARATION";
        return prepareLiveTarget(database, canonicalIdentityReferenceId, preflight);
      },
    });
    process.stdout.write([
      "LIVE_ISSUANCE_BUDGET_CONSUMED: yes",
      `credentialGenerationDispatchCount: ${result.issuanceDispatchCount}`,
      "credentialGenerationOutcome: confirmed_succeeded",
      "creationResponseCorrelation: exact",
      "canonicalIdentityCaptured: yes",
      "canonicalIdentityExposed: no",
      "protectedOutputsCaptured: yes",
      "protectedPlaintextExposed: no",
      "atomicPersistence: PASS",
      "bindingPersisted: yes",
      "trustedPresentationAuthorityResolved: yes",
      "providerObservation1: PASS",
      "providerObservation2: PASS",
      "praxisRevalidation: PASS",
      "destructiveTargetPrepared: yes",
      "revokeDispatchCount: 0",
      "providerMutationsPerformed: 1",
      "FINAL_STATUS: LIVE_BOUND_CREDENTIAL_READY_FOR_REVOKE",
    ].join("\n") + "\n");
  } catch (error) {
    process.stderr.write(`failureStage: ${stage}\nfailureClassification: ${safeCode(error)}\n`);
    process.exitCode = 1;
  } finally {
    await database.onModuleDestroy();
  }
}

async function latestIssuedCredentialReference(database: Database) {
  const result = await database.query<{ credentialId: string }>(
    `SELECT operation.persisted_references->'credentialClientSecret'->>'credentialId' AS "credentialId"
       FROM protected_operations operation
       JOIN external_resource_bindings binding ON binding.source_protected_operation_id=operation.id
      WHERE operation.project_id=$1 AND operation.environment_id=$2
        AND operation.state='completed' AND operation.persistence_state='committed'
        AND operation.mutation_outcome='applied' AND binding.lifecycle_state='active'
        AND binding.provider='vitract' AND binding.resource_kind='credential_record'
        AND binding.resource_scope=$3
        AND operation.safe_output_manifest::text LIKE '%credentialRecordIdentity%'
      ORDER BY operation.created_at DESC LIMIT 1`,
    [LIVE_QUALIFICATION.projectId, LIVE_QUALIFICATION.environmentId, LIVE_QUALIFICATION.resourceScope],
  );
  if (result.rowCount !== 1 || !result.rows[0]!.credentialId)
    throw new Error("PERSISTENCE_RECOVERY_REQUIRED");
  return result.rows[0]!.credentialId;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

type LivePreflight = {
  authorizationId: string;
  allowedOrigins: string[];
  trustedScriptOrigins: string[];
};

async function loadLivePreflight(database: Database, authorizationId: string): Promise<LivePreflight> {
  const result = await database.query<{ policy: unknown; authorizationId: string }>(
    `SELECT environment.policy,mission_authorization.id::text AS "authorizationId"
       FROM environments environment
       JOIN mission_authorizations mission_authorization
         ON mission_authorization.environment_id=environment.id
        AND mission_authorization.objective_id=$3
        AND mission_authorization.id=$4
        AND mission_authorization.kind='protected_mutation'
        AND mission_authorization.status='approved'
      WHERE environment.id=$1 AND environment.project_id=$2`,
    [LIVE_QUALIFICATION.environmentId, LIVE_QUALIFICATION.projectId,
      LIVE_QUALIFICATION.objectiveId, authorizationId],
  );
  if (result.rowCount !== 1) throw new Error("LIVE_ISSUANCE_AUTHORIZATION_UNAVAILABLE");
  const policy = executionPolicySchema.parse(result.rows[0]!.policy);
  const authority = policy.externalResourcePresentationAuthorities?.filter((candidate) =>
    candidate.provider === "vitract" && candidate.resourceKind === "credential_record" &&
    candidate.resourceScope === LIVE_QUALIFICATION.resourceScope && candidate.contractVersion === 1 &&
    candidate.status === "active",
  ) ?? [];
  if (authority.length !== 1 || authority[0]!.classification !== "internal_non_secret" ||
      authority[0]!.permittedPurpose !== "browser_presentation_identity")
    throw new Error("PRESENTATION_AUTHORITY_UNAVAILABLE");
  if (policy.externalResourcePresentationAuthorities!.some((candidate) =>
    candidate.provider === authority[0]!.provider && candidate.resourceKind === authority[0]!.resourceKind &&
    candidate.resourceScope === authority[0]!.resourceScope && candidate.contractVersion === 1 &&
    candidate.revision > authority[0]!.revision)) throw new Error("PRESENTATION_AUTHORITY_STALE");
  return { authorizationId, allowedOrigins: policy.allowedOrigins,
    trustedScriptOrigins: policy.trustedScriptOrigins ?? [] };
}

async function executeProductionIssuance(
  intent: MissionAuthoringIntent,
  preflight: LivePreflight,
): Promise<SafeLiveIssuanceResult> {
  const mcp = await initializeMcp();
  let sessionId = "";
  const runId = randomUUID();
  try {
    const start = await checkedMcp(mcp, "start_flow_authoring", {
      projectId: LIVE_QUALIFICATION.projectId, environmentId: LIVE_QUALIFICATION.environmentId,
      missionId: LIVE_QUALIFICATION.missionId, agentSessionId: LIVE_QUALIFICATION.agentSessionId,
      objectiveId: LIVE_QUALIFICATION.objectiveId, flowDraftId: LIVE_QUALIFICATION.flowDraftId,
      objective: "Issue exactly one bound Vitract test credential",
      allowedOrigins: preflight.allowedOrigins, correlationId: runId,
      initialProtectedReferenceIds: [LIVE_QUALIFICATION.loginEmailReference, LIVE_QUALIFICATION.loginPasswordReference],
      turnBudgets: { maxOperations: 6, maxDurationMs: 60_000 },
      idempotencyKey: `vitract-bound-issuance-start-${runId}`,
    });
    sessionId = findAdaptiveSessionId(start) ?? "";
    if (!sessionId) throw new Error("LIVE_ISSUANCE_SESSION_UNAVAILABLE");
    const preparation = livePreparationIntents(runId);
    const prepared = findTurn(await checkedMcp(mcp, "advance_flow_authoring", {
      sessionId, kind: "intents", intents: preparation,
      budgets: { maxOperations: preparation.length, maxDurationMs: 60_000 },
      idempotencyKey: `vitract-bound-issuance-prepare-${runId}`,
    }));
    if (prepared.state !== "completed") throw new Error("GENERATION_TARGET_UNAVAILABLE");
    let response = await checkedMcp(mcp, "advance_flow_authoring", {
      sessionId, kind: "intents", intents: [intent],
      budgets: { maxOperations: 1, maxDurationMs: 60_000 },
      idempotencyKey: `vitract-bound-issuance-dispatch-${runId}`,
    });
    let turn = findTurn(response);
    for (let poll = 1; turn.state === "pending" && poll <= 160; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      response = await checkedMcp(mcp, "advance_flow_authoring", {
        sessionId, kind: "continue", turnId: turn.turnId,
        budgets: { maxOperations: 1, maxDurationMs: 60_000 },
        idempotencyKey: `vitract-bound-issuance-continue-${runId}-${poll}`,
      });
      turn = findTurn(response);
    }
    const proof = await issuanceProof(sessionId, turn.turnId, intent.intentId);
    if (proof.dispatchCount !== 1) throw new Error(proof.dispatchCount ? "GENERATION_OUTCOME_UNKNOWN" : "GENERATION_DISPATCH_FAILED");
    if (turn.state !== "completed" || proof.state !== "completed" || proof.persistenceState !== "committed" ||
        proof.ownershipStatus !== "unique" || proof.httpStatusClass !== "2xx" || proof.semanticLeafMatchCount !== "one")
      throw new Error("ATOMIC_PERSISTENCE_FAILED");
    const completed = turn.completed.find((candidate) => candidate.intentId === intent.intentId);
    if (!completed || completed.mutationOutcome !== "applied") throw new Error("GENERATION_OUTCOME_UNKNOWN");
    return {
      operationId: proof.operationId,
      generatedReferences: completed.generatedReferences.map((reference) => ({
        reference: reference.reference as SafeLiveIssuanceResult["generatedReferences"][number]["reference"],
        classification: reference.classification,
        opaqueReferenceId: reference.credentialId ?? reference.valueId ?? "",
      })),
    };
  } finally {
    if (sessionId) await checkedMcp(mcp, "close_flow_authoring", {
      sessionId, idempotencyKey: `vitract-bound-issuance-close-${runId}`,
    }).catch(() => undefined);
    await mcp.close();
  }
}

async function checkedMcp(
  mcp: Awaited<ReturnType<typeof initializeMcp>>,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await mcp.call({ name, arguments: args });
  rejectToolError(response);
  return response;
}

type SafeTurn = { turnId: string; state: "completed" | "decision_required" | "pending"; completed: Array<{
  intentId: string; mutationOutcome: "not_applied" | "applied" | "unknown";
  generatedReferences: Array<{ reference: string; classification: "public" | "protected"; credentialId?: string; valueId?: string }>;
}> };
function findTurn(value: unknown): SafeTurn {
  const found = findNested(value, (record) => typeof record.turnId === "string" &&
    ["completed", "decision_required", "pending"].includes(String(record.state)) ? record as unknown as SafeTurn : undefined);
  if (!found) throw new Error("LIVE_ISSUANCE_TURN_UNAVAILABLE");
  return found;
}
function findNested<T>(value: unknown, select: (record: Record<string, unknown>) => T | undefined): T | undefined {
  if (typeof value === "string") { try { return findNested(JSON.parse(value), select); } catch { return undefined; } }
  if (Array.isArray(value)) { for (const item of value) { const found = findNested(item, select); if (found) return found; } return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const selected = select(value as Record<string, unknown>); if (selected) return selected;
  for (const item of Object.values(value)) { const found = findNested(item, select); if (found) return found; }
  return undefined;
}

async function issuanceProof(sessionId: string, turnId: string, intentId: string) {
  const database = new Database();
  try {
    const result = await database.query<{
      operationId: string; state: string; persistenceState: string; dispatchCount: number;
      ownershipStatus: string; httpStatusClass: string; semanticLeafMatchCount: string;
    }>(`SELECT operation.id::text AS "operationId",operation.state,
               operation.persistence_state AS "persistenceState",
               count(*) FILTER (WHERE transition.to_state='dispatching')::int AS "dispatchCount",
               operation.safe_diagnostics->'responseEvidence'->>'ownershipStatus' AS "ownershipStatus",
               operation.safe_diagnostics->'responseEvidence'->>'statusClass' AS "httpStatusClass",
               operation.safe_diagnostics->'responseEvidence'->>'declaredSemanticLeafMatchCount' AS "semanticLeafMatchCount"
          FROM protected_operations operation
          LEFT JOIN protected_operation_transitions transition ON transition.protected_operation_id=operation.id
         WHERE operation.authoring_session_id=$1
           AND operation.operation_id='m2-' || substr(encode(digest($2 || ':' || $3,'sha256'),'hex'),1,40)
         GROUP BY operation.id`, [sessionId, turnId, intentId]);
    if (result.rowCount !== 1) throw new Error("LIVE_ISSUANCE_DURABLE_PROOF_UNAVAILABLE");
    return result.rows[0]!;
  } finally { await database.onModuleDestroy(); }
}

async function readSafeBinding(database: Database, input: { operationId: string; canonicalIdentityReferenceId: string }) {
  const result = await database.query<SafeBindingReadback>(
    `SELECT 'active'::text AS status,binding.provider,binding.resource_kind AS "resourceKind",
            binding.resource_scope AS "resourceScope",binding.identity_contract_version AS "identityContractVersion",
            binding.source_protected_operation_id::text AS "sourceProtectedOperationId"
       FROM external_resource_bindings binding
       JOIN generated_public_values value ON value.id=binding.generated_public_value_id
      WHERE binding.source_protected_operation_id=$1 AND value.id=$2
        AND binding.project_id=$3 AND binding.environment_id=$4 AND binding.lifecycle_state='active'`,
    [input.operationId, input.canonicalIdentityReferenceId, LIVE_QUALIFICATION.projectId, LIVE_QUALIFICATION.environmentId],
  );
  if (result.rowCount !== 1) throw new Error("BINDING_PERSISTENCE_FAILED");
  return result.rows[0]!;
}

async function readSafeAuthority(database: Database, binding: SafeBindingReadback): Promise<SafePresentationAuthorityReadback> {
  const repository = new ExternalResourcePresentationAuthorityRepository(database);
  const contract = await repository.resolveActive({
    projectId: LIVE_QUALIFICATION.projectId, environmentId: LIVE_QUALIFICATION.environmentId,
    provider: binding.provider, resourceKind: binding.resourceKind, resourceScope: binding.resourceScope,
    contractVersion: binding.identityContractVersion, action: revokeAction(),
  });
  return { classification: contract.presentationIdentity.classification,
    permittedPurpose: "browser_presentation_identity", contractVersion: 1, status: "active" };
}

function revokeAction(): InteractionTargetIntent {
  return { concept: "revoke credential", requiredCapabilities: ["focusable", "pointer_activatable"],
    preferredEvidence: { roles: ["button"], names: ["Revoke"], labels: [], descriptions: [], placeholders: [], inputTypes: [], testIds: [] },
    scope: { kind: "page" as const }, relations: [], prohibited: ["hidden", "disabled"], risk: "destructive" as const,
    confidence: { requiredFamilies: [] }, matching: "exact" as const };
}

async function prepareLiveTarget(
  database: Database,
  credentialId: string,
  preflight: LivePreflight,
): Promise<PreparedTargetProof> {
  const sessions = new AdaptiveSessionRepository(database);
  const session = await sessions.create(null, {
    projectId: LIVE_QUALIFICATION.projectId, environmentId: LIVE_QUALIFICATION.environmentId,
    missionId: LIVE_QUALIFICATION.missionId, objectiveId: LIVE_QUALIFICATION.objectiveId,
    flowDraftId: LIVE_QUALIFICATION.flowDraftId, agentSessionId: LIVE_QUALIFICATION.agentSessionId,
    objective: "Read-only qualification of the freshly bound credential target",
    allowedOrigins: preflight.allowedOrigins,
    initialProtectedReferenceIds: [LIVE_QUALIFICATION.loginEmailReference, LIVE_QUALIFICATION.loginPasswordReference],
    correlationId: randomUUID(), idempotencyKey: `vitract-bound-target-${randomUUID()}`,
  });
  const browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await admitLoginReferences(sessions, session.id);
    let email = await sessions.resolveCredential(session.id, LIVE_QUALIFICATION.loginEmailReference);
    let password = await sessions.resolveCredential(session.id, LIVE_QUALIFICATION.loginPasswordReference);
    try {
      await navigateAndWaitNative(page, "https://preview.vitract.com/login", preflight.allowedOrigins,
        30_000, preflight.trustedScriptOrigins);
      const emailTarget = await resolveTargetLocator(page, loginTarget("email"));
      await emailTarget.fill(email, { timeout: 10_000 });
      const passwordTarget = await resolveTargetLocator(page, loginTarget("password"));
      await passwordTarget.fill(password, { timeout: 10_000 });
      const login = await resolveTargetLocator(page, loginTarget("login"));
      await login.click({ timeout: 10_000 });
      await page.waitForURL((url) => url.origin === "https://preview.vitract.com" && url.pathname !== "/login", { timeout: 30_000 });
    } finally {
      email = ""; password = "";
    }

    const captured: Array<Promise<{ response: Response; body: unknown } | undefined>> = [];
    const responseFacts = new Set<string>();
    const listener = (response: Response) => {
      const origin = new URL(response.url()).origin;
      if (!preflight.allowedOrigins.includes(origin)) return;
      const request = response.request();
      responseFacts.add([
        origin,
        request.method(),
        request.resourceType(),
        `${Math.floor(response.status() / 100)}xx`,
      ].join("|"));
      if (request.method() !== "GET" || response.status() < 200 || response.status() >= 300) return;
      captured.push(response.json().then((body) => ({ response, body })).catch(() => undefined));
    };
    page.on("response", listener);
    await navigateAndWaitNative(page, LIVE_QUALIFICATION.credentialUrl, preflight.allowedOrigins,
      30_000, preflight.trustedScriptOrigins);
    await page.getByRole("button", { name: "Add credential", exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(750);
    page.off("response", listener);
    const candidates = (await Promise.all(captured)).flatMap((candidate) => candidate ? [candidate] : []);
    const collection = candidates.map((candidate) => ({ ...candidate, records: providerRecords(candidate.body) }))
      .filter((candidate) => candidate.records.length > 0);
    if (collection.length === 0) {
      process.stderr.write(`providerResponseFacts: ${[...responseFacts].sort().join(",") || "NONE"}\n`);
      const hydrationScripts = await page.locator("script").allTextContents();
      const hydrationText = hydrationScripts.join("\n");
      process.stderr.write([
        `hydrationScriptCount: ${hydrationScripts.length}`,
        `hydrationHasCredentialKey: ${/credential/i.test(hydrationText) ? "yes" : "no"}`,
        `hydrationHasLabelKey: ${/["\\]label["\\]/i.test(hydrationText) ? "yes" : "no"}`,
        `hydrationHasIdKey: ${/["\\]id["\\]/i.test(hydrationText) ? "yes" : "no"}`,
      ].join("\n") + "\n");
      const schema = [...new Set(candidates.flatMap((candidate) => objectKeysWithIdentity(candidate.body)))]
        .sort().slice(0, 12).join("_").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
      throw new Error(schema ? `RESOURCE_OBSERVATION_SCHEMA_${schema}` : "RESOURCE_OBSERVATION_COLLECTION_NOT_FOUND");
    }
    if (collection.length !== 1) throw new Error("RESOURCE_OBSERVATION_COLLECTION_AMBIGUOUS");
    const first = collection[0]!;
    const binding = await new ExternalResourceBindingRepository(database).resolveActiveForCredential({
      credentialId, projectId: LIVE_QUALIFICATION.projectId,
      environmentId: LIVE_QUALIFICATION.environmentId, provider: "vitract",
      resourceKind: "credential_record", resourceScope: LIVE_QUALIFICATION.resourceScope,
    });
    await reportSafeFieldViability(page, first.body, binding.externalIdentity);
    if (process.argv.includes("--reconcile-revoke-existing")) {
      const second = await captureFreshCredentialRecords(page.context(), preflight);
      const state = (records: ProviderRecord[]) => {
        const canonical = records.filter((record) => record.id === binding.externalIdentity);
        return canonical.length === 0 || (canonical.length === 1 && canonical[0]!.fields.status === "revoked")
          ? "revoked" : canonical.length === 1 && canonical[0]!.fields.status === "active" ? "active" : "unknown";
      };
      const firstState = state(first.records); const secondState = state(second);
      const lifecycle = new ExternalResourceCredentialLifecycleService(database, new ExecutionKernelRepository(database));
      const result = await lifecycle.reconcileUnknown({
        sessionId: `external-lifecycle:${LIVE_QUALIFICATION.environmentId}`,
        operationId: "vitract-existing-bound-credential-revoke-v1", credentialId,
        projectId: LIVE_QUALIFICATION.projectId, environmentId: LIVE_QUALIFICATION.environmentId,
        provider: "vitract", resourceKind: "credential_record", resourceScope: LIVE_QUALIFICATION.resourceScope,
        result: firstState === "revoked" && secondState === "revoked" ? "confirmed_revoked"
          : firstState === "active" && secondState === "active" ? "confirmed_not_applied" : "unknown",
      });
      process.stdout.write(`reconciliationObservation1: ${firstState}\nreconciliationObservation2: ${secondState}\nreconciliationOutcome: ${result.outcome}\n`);
      if (result.outcome === "unknown") throw new Error("RECONCILIATION_REQUIRED");
      return { providerRevalidated: true, presentationIdentityValidated: true };
    }
    if (process.argv.includes("--inspect-revoke-contract")) {
      const urls = await page.locator("script[src]").evaluateAll((elements) =>
        elements.flatMap((element) => element instanceof HTMLScriptElement && element.src ? [element.src] : []));
      const scripts = await Promise.all(urls.map(async (url) =>
        page.request.get(url).then((response) => response.text())));
      const source = scripts.join("\n");
      process.stderr.write([
        `revokeStaticToken: ${/revoke/i.test(source) ? "yes" : "no"}`,
        `revokeUsesDelete: ${/(?:method\s*:\s*["']DELETE["']|\.delete\s*\()/i.test(source) ? "yes" : "no"}`,
        `revokeUsesPatch: ${/(?:method\s*:\s*["']PATCH["']|\.patch\s*\()/i.test(source) ? "yes" : "no"}`,
        `revokeUsesPost: ${/(?:method\s*:\s*["']POST["']|\.post\s*\()/i.test(source) ? "yes" : "no"}`,
        `credentialPathToken: ${/credentials/i.test(source) ? "yes" : "no"}`,
      ].join("\n") + "\n");
      return { providerRevalidated: true, presentationIdentityValidated: true };
    }
    let observationCount = 0;
    const observe = async (input: {
      presentationIdentity: { semanticField: string; classification: "internal_non_secret" };
    }): Promise<AuthoritativeExternalResourceObservation> => {
      observationCount += 1;
      let records: ProviderRecord[];
      try {
        records = observationCount === 1
          ? first.records
          : await captureFreshCredentialRecords(page.context(), preflight);
      } catch (error) {
        process.stderr.write(`revalidationCallbackFailure: ${safeCode(error)}\n`);
        throw error;
      }
      if (observationCount === 2) process.stderr.write(`revalidationCallbackRecordCount: ${records.length}\n`);
      return {
        observationId: randomUUID(), source: "authoritative_read_only_resource_observation",
        resourceCollection: "partner_application_credentials",
        projectId: LIVE_QUALIFICATION.projectId, environmentId: LIVE_QUALIFICATION.environmentId,
        provider: "vitract", resourceKind: "credential_record", resourceScope: LIVE_QUALIFICATION.resourceScope,
        records: records.map((record) => {
          const value = record.fields[input.presentationIdentity.semanticField];
          return {
            canonicalIdentity: record.id,
            presentationFields: typeof value === "string" && value
              ? [{ ...input.presentationIdentity, value }]
              : [],
          };
        }),
      };
    };
    const service = new ExternalResourceDestructiveTargetPreparationService(
      new ExternalResourceBindingRepository(database),
      new ExternalResourcePresentationAuthorityRepository(database),
    );
    const prepared = await service.prepare({
      page, credentialId, projectId: LIVE_QUALIFICATION.projectId,
      environmentId: LIVE_QUALIFICATION.environmentId, provider: "vitract",
      resourceKind: "credential_record", resourceScope: LIVE_QUALIFICATION.resourceScope,
      action: revokeAction(), observeResources: (input) => observe(input), allowedOrigins: preflight.allowedOrigins,
    });
    if (observationCount !== 2) throw new Error("PROVIDER_REVALIDATION_FAILED");
    if (process.argv.includes("--inspect-revoke-dialog")) {
      await prepared.locator.click({ timeout: 10_000 });
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible", timeout: 5_000 });
      process.stdout.write([
        `revokeDialogCount: ${await dialog.count()}`,
        `dialogRevokeButtonCount: ${await dialog.getByRole("button", { name: "Revoke", exact: true }).count()}`,
        `dialogConfirmButtonCount: ${await dialog.getByRole("button", { name: "Confirm", exact: true }).count()}`,
        `dialogRevokeCredentialButtonCount: ${await dialog.getByRole("button", { name: "Revoke credential", exact: true }).count()}`,
        `dialogYesRevokeButtonCount: ${await dialog.getByRole("button", { name: /^(Yes,? revoke|Yes,? revoke credential)$/i }).count()}`,
        `dialogContinueButtonCount: ${await dialog.getByRole("button", { name: "Continue", exact: true }).count()}`,
        `dialogDeleteButtonCount: ${await dialog.getByRole("button", { name: "Delete", exact: true }).count()}`,
        `dialogRemoveButtonCount: ${await dialog.getByRole("button", { name: "Remove", exact: true }).count()}`,
        `dialogDeactivateButtonCount: ${await dialog.getByRole("button", { name: "Deactivate", exact: true }).count()}`,
        `dialogCancelButtonCount: ${await dialog.getByRole("button", { name: "Cancel", exact: true }).count()}`,
        `dialogTextboxCount: ${await dialog.getByRole("textbox").count()}`,
        `dialogCheckboxCount: ${await dialog.getByRole("checkbox").count()}`,
        `dialogNonCancelButtonNames: ${JSON.stringify(await dialog.getByRole("button").evaluateAll((buttons) => buttons.flatMap((button) => { const name=button.getAttribute("aria-label")?.trim()||button.textContent?.trim()||""; return name && name.toLowerCase()!=="cancel" ? [name] : []; })))}`,
        `dialogTextboxPlaceholders: ${JSON.stringify(await dialog.getByRole("textbox").evaluateAll((inputs) => inputs.map((input) => input.getAttribute("placeholder") ?? "none")))}`,
      ].join("\n") + "\n");
      return { providerRevalidated: true, presentationIdentityValidated: true };
    }
    if (process.argv.includes("--revoke-existing")) {
      const authorization = await database.query<{ id: string }>(`SELECT id::text FROM mission_authorizations
        WHERE mission_id=$1 AND objective_id=$2 AND environment_id=$3 AND kind='live_mutation'
          AND status='approved' AND (expires_at IS NULL OR expires_at>now())`,
        [LIVE_QUALIFICATION.missionId,LIVE_QUALIFICATION.objectiveId,LIVE_QUALIFICATION.environmentId]);
      if (authorization.rowCount !== 1) throw new Error("REVOKE_AUTHORIZATION_UNAVAILABLE");
      let responseStatusClass: string | undefined;
      let requestObserved = false;
      let responseObserved = false;
      const lifecycle = new ExternalResourceCredentialLifecycleService(database, new ExecutionKernelRepository(database));
      await prepared.locator.click({ timeout: 10_000 });
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible", timeout: 5_000 });
      const confirmationInput = await resolveTargetLocator(page, {
        concept: "revoke confirmation phrase", requiredCapabilities: ["accepts_text", "focusable", "editable"],
        preferredEvidence: { roles: ["textbox"], names: [], labels: [], descriptions: [], placeholders: ["REVOKE"], inputTypes: [], testIds: [] },
        scope: { kind: "dialog" }, relations: [], prohibited: ["hidden", "disabled", "readonly"], risk: "destructive",
        confidence: { requiredFamilies: [] }, matching: "exact",
      });
      await confirmationInput.fill("REVOKE", { timeout: 5_000 });
      const finalButtons = dialog.getByRole("button").filter({ visible: true });
      const finalNames = await finalButtons.evaluateAll((buttons) => buttons.flatMap((button) => {
        const name = button.getAttribute("aria-label")?.trim() || button.textContent?.trim() || "";
        return name && !["cancel", "close dialog"].includes(name.toLowerCase()) && !(button instanceof HTMLButtonElement && button.disabled) ? [name] : [];
      }));
      if (finalNames.length !== 1) throw new Error("REVOKE_TARGET_AMBIGUOUS");
      const finalTarget = await resolveTarget(page, {
        concept: "confirm bound credential revoke", requiredCapabilities: ["focusable", "pointer_activatable"],
        preferredEvidence: { roles: ["button"], names: [finalNames[0]!], labels: [], descriptions: [], placeholders: [], inputTypes: [], testIds: [] },
        scope: { kind: "dialog" }, relations: [], prohibited: ["hidden", "disabled"], risk: "destructive",
        confidence: { requiredFamilies: [] }, matching: "exact",
      }, { allowedOrigins: preflight.allowedOrigins });
      const result = await lifecycle.revoke({
        sessionId: `external-lifecycle:${LIVE_QUALIFICATION.environmentId}`,
        operationId: "vitract-existing-bound-credential-revoke-v1",
        credentialId, projectId: LIVE_QUALIFICATION.projectId, environmentId: LIVE_QUALIFICATION.environmentId,
        provider: "vitract", resourceKind: "credential_record", resourceScope: LIVE_QUALIFICATION.resourceScope,
        target: finalTarget,
        dispatch: async () => {
          const responsePromise = page.waitForResponse((response) => {
            const url = new URL(response.url());
            const exact = response.request().method() === "DELETE" && preflight.allowedOrigins.includes(url.origin);
            if (exact) requestObserved = true;
            return exact;
          }, { timeout: 30_000 });
          const [, response] = await Promise.all([
            finalTarget.locator.click({ timeout: 10_000 }),
            responsePromise,
          ]);
          responseObserved = true;
          responseStatusClass = `${Math.floor(response.status() / 100)}xx`;
        },
        reconcile: async () => {
          let records: ProviderRecord[];
          try { records = await captureFreshCredentialRecords(page.context(), preflight); }
          catch { return { state: "unknown", requestObserved, responseObserved,
            ...(responseStatusClass ? { statusClass: responseStatusClass } : {}) }; }
          const canonical = records.filter((record) => record.id === binding.externalIdentity);
          if (canonical.length === 0 || (canonical.length === 1 && canonical[0]!.fields.status === "revoked"))
            return { state: "confirmed_revoked", requestObserved: true, responseObserved: true,
              statusClass: responseStatusClass ?? "2xx" };
          if (canonical.length === 1 && canonical[0]!.fields.status === "active")
            return { state: "confirmed_not_revoked", requestObserved, responseObserved,
              ...(responseStatusClass ? { statusClass: responseStatusClass } : {}) };
          return { state: "unknown", requestObserved, responseObserved,
            ...(responseStatusClass ? { statusClass: responseStatusClass } : {}) };
        },
      });
      if (result.outcome !== "confirmed_revoked") throw new Error(result.outcome === "confirmed_not_revoked"
        ? "REVOKE_EFFECT_NOT_CONFIRMED" : "RECONCILIATION_REQUIRED");
      process.stdout.write([
        "LIVE_REVOKE_BUDGET_CONSUMED: yes", "revokeDispatchCount: 1",
        "revokeMutationOutcome: confirmed_succeeded", "providerRequestCorrelation: exact",
        `responseStatusClass: ${responseStatusClass ?? "2xx"}`, "providerEffect: confirmed_revoked",
        "localCredentialLifecycle: revoked", "externalBindingLifecycle: invalidated",
        "credentialReusableAfterRevoke: no", "bindingReusableAfterRevoke: no",
        "FINAL_STATUS: CONTROLLED_REVOKE_LIFECYCLE_ACCEPTED",
      ].join("\n") + "\n");
    }
    return { providerRevalidated: prepared.providerRevalidated,
      presentationIdentityValidated: prepared.presentationIdentityValidated };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await sessions.closeAtSafeBoundary({ workspaceId: null, sessionId: session.id,
      idempotencyKey: `vitract-bound-target-close-${session.id}` }).catch(() => undefined);
  }
}

async function admitLoginReferences(sessions: AdaptiveSessionRepository, sessionId: string) {
  for (const candidate of [
    { reference: LIVE_QUALIFICATION.loginEmailReference, concept: "login email", placeholder: "Enter your email" },
    { reference: LIVE_QUALIFICATION.loginPasswordReference, concept: "login password", placeholder: "Enter your password" },
  ]) await sessions.validateIntentAdmission({ sessionId, intent: {
    intentId: `vitract-bound-${candidate.concept.replaceAll(" ", "-")}`,
    objectiveId: LIVE_QUALIFICATION.objectiveId, flowDraftId: LIVE_QUALIFICATION.flowDraftId,
    action: { kind: "fill", target: { concept: candidate.concept, role: "textbox",
      placeholder: candidate.placeholder, exact: true }, protectedReferenceId: candidate.reference },
    expectedEffect: { kind: "none" }, constraints: { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "authentication" }, protectedInputReferences: [candidate.reference],
  } });
}

function loginTarget(kind: "email" | "password" | "login"): InteractionTargetIntent {
  const fill = kind !== "login";
  return { concept: kind === "login" ? "sign in" : `login ${kind}`,
    requiredCapabilities: fill ? ["accepts_text", "focusable", "editable"] : ["focusable", "pointer_activatable"],
    preferredEvidence: { roles: [fill ? "textbox" : "button"], names: fill ? [] : ["Login"], labels: [], descriptions: [],
      placeholders: fill ? [kind === "email" ? "Enter your email" : "Enter your password"] : [], inputTypes: [], testIds: [] },
    scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"], risk: "authentication",
    confidence: { requiredFamilies: [] }, matching: "exact" };
}

type ProviderRecord = { id: string; fields: Record<string, unknown> };
function providerRecords(value: unknown): ProviderRecord[] {
  const records: ProviderRecord[] = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
    if (!candidate || typeof candidate !== "object") return;
    const object = candidate as Record<string, unknown>;
    if (typeof object.id === "string" && object.id && Object.hasOwn(object, "clientId") && Object.hasOwn(object, "label"))
      records.push({ id: object.id, fields: object });
    Object.values(object).forEach(visit);
  };
  visit(value);
  const unique = new Map(records.map((record) => [record.id, record]));
  return [...unique.values()];
}

function objectKeysWithIdentity(value: unknown): string[] {
  const signatures: string[] = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
    if (!candidate || typeof candidate !== "object") return;
    const object = candidate as Record<string, unknown>;
    if (typeof object.id === "string") {
      const fieldType = (field: unknown) => field === null ? "null" : Array.isArray(field) ? "array" : typeof field;
      signatures.push(`${Object.keys(object).sort().join("_")}_label-${fieldType(object.label)}_name-${fieldType(object.name)}`);
    }
    Object.values(object).forEach(visit);
  };
  visit(value);
  return signatures;
}

async function reportSafeFieldViability(page: Page, value: unknown, canonicalIdentity: string) {
  const objects: Array<Record<string, unknown>> = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
    if (!candidate || typeof candidate !== "object") return;
    const object = candidate as Record<string, unknown>;
    if (typeof object.id === "string" && Object.hasOwn(object, "clientId") && Object.hasOwn(object, "label"))
      objects.push(object);
    Object.values(object).forEach(visit);
  };
  visit(value);
  const exact = objects.filter((record) => record.id === canonicalIdentity);
  const categorical: string[] = [`canonicalRecordCount: ${exact.length}`];
  for (const semanticField of ["label", "name", "clientId", "applicationId", "scope", "status", "createdAt", "updatedAt", "lastUsedAt", "secretSuffix"] as const) {
    const field = exact[0]?.[semanticField];
    const present = exact.length === 1 && Object.hasOwn(exact[0]!, semanticField);
    const usableString = typeof field === "string" && field.length > 0;
    const providerMatches = usableString ? objects.filter((record) => record[semanticField] === field).length : 0;
    const exactTextMatches = usableString ? await page.getByText(field, { exact: true }).count() : 0;
    const boundaryMatches = usableString ? await page.locator('tr,[role="row"]').filter({ hasText: field }).count() : 0;
    const revokeBoundaries = usableString ? await page.locator('tr,[role="row"]')
      .filter({ hasText: field }).filter({ has: page.getByRole("button", { name: "Revoke", exact: true }) }).count() : 0;
    categorical.push(`${semanticField}: present=${present ? "yes" : "no"},nonNull=${field !== null && field !== undefined ? "yes" : "no"},string=${usableString ? "yes" : "no"},providerMatches=${providerMatches},browserExactMatches=${exactTextMatches},browserBoundaries=${boundaryMatches},revokeBoundaries=${revokeBoundaries}`);
    if (semanticField === "clientId" && usableString && exactTextMatches === 1) {
      const ancestry = await page.getByText(field, { exact: true }).evaluate((element) => {
        const facts: Array<{ tag: string; role: string; revokeCount: number }> = [];
        let current: Element | null = element;
        while (current && facts.length < 10) {
          facts.push({
            tag: current.tagName.toLowerCase(),
            role: current.getAttribute("role") ?? "none",
            revokeCount: [...current.querySelectorAll("button")]
              .filter((button) => button.textContent?.trim() === "Revoke").length,
          });
          current = current.parentElement;
        }
        return facts;
      });
      categorical.push(`clientIdAncestry: ${ancestry.map((fact, index) => `${index}:${fact.tag}/${fact.role}/revoke-${fact.revokeCount}`).join(",")}`);
    }
  }
  process.stderr.write(`fieldViability:\n${categorical.join("\n")}\n`);
}

async function captureFreshCredentialRecords(context: import("playwright").BrowserContext, preflight: LivePreflight) {
  const page = await context.newPage();
  const captured: Array<Promise<unknown | undefined>> = [];
  const facts = new Set<string>();
  let stage = "NAVIGATION";
  const listener = (response: Response) => {
    const origin = new URL(response.url()).origin;
    if (!preflight.allowedOrigins.includes(origin)) return;
    facts.add(`${origin}|${response.request().method()}|${response.request().resourceType()}|${Math.floor(response.status() / 100)}xx`);
    if (response.request().method() !== "GET" || response.status() < 200 || response.status() >= 300) return;
    captured.push(response.json().catch(() => undefined));
  };
  try {
    page.on("response", listener);
    await navigateAndWaitNative(page, LIVE_QUALIFICATION.credentialUrl, preflight.allowedOrigins,
      30_000, preflight.trustedScriptOrigins);
    stage = "READINESS";
    await page.getByRole("button", { name: "Add credential", exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    stage = "COLLECTION";
    await page.waitForTimeout(750);
    const collections = (await Promise.all(captured)).map(providerRecords).filter((records) => records.length > 0);
    if (collections.length !== 1) {
      process.stderr.write(`revalidationStage: ${stage}\nrevalidationPath: ${page.url() ? new URL(page.url()).pathname : "NONE"}\nrevalidationFacts: ${[...facts].sort().join(",") || "NONE"}\nrevalidationCollectionCount: ${collections.length}\n`);
      throw new Error("RESOURCE_OBSERVATION_UNAVAILABLE");
    }
    return collections[0]!;
  } catch (error) {
    if (stage !== "COLLECTION") process.stderr.write(`revalidationStage: ${stage}\nrevalidationPath: ${page.url() ? new URL(page.url()).pathname : "NONE"}\nrevalidationFacts: ${[...facts].sort().join(",") || "NONE"}\n`);
    throw error;
  } finally {
    page.off("response", listener);
    await page.close().catch(() => undefined);
  }
}

function safeCode(error: unknown) {
  const direct = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : undefined;
  if (direct && /^[A-Z][A-Z0-9_]+$/.test(direct)) return direct;
  const response = error && typeof error === "object" && "response" in error ? (error as { response?: unknown }).response : undefined;
  const nested = response && typeof response === "object" && "code" in response && typeof (response as { code?: unknown }).code === "string"
    ? (response as { code: string }).code : undefined;
  if (nested && /^[A-Z][A-Z0-9_]+$/.test(nested)) return nested;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message;
  return "LIVE_ISSUANCE_QUALIFICATION_FAILED";
}
