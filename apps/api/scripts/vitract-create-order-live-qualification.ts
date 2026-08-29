import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { NestFactory } from "@nestjs/core";
import {
  executionPolicyAllowsProtectedSyntheticInput,
  executionPolicySchema,
  type MissionAuthoringIntent,
} from "@scry/contracts";
import pg from "pg";
import { AppModule } from "../src/app.module.js";
import { MissionProtectedQualificationRunner } from "../src/adaptive-sessions/index.js";

export const VITRACT_CREATE_QUALIFICATION = {
  providerOrigin: "https://preview-api.vitract.com",
  path: "/api/v1/partner-api/orders",
} as const;

type DurableContext = {
  missionId: string;
  objectiveId: string;
  flowDraftId: string;
  agentSessionId: string;
  authorizationId: string;
  entryUrl: string;
  allowedOrigins: string[];
  credentialReferenceIds: [string, string];
  policy: unknown;
};

export type CredentialPairCandidate = {
  clientIdReferenceId: string;
  clientSecretReferenceId: string;
  projectId: string;
  environmentId: string;
  issuanceOperationId: string;
  providerOrigin: string;
  listRequestMethod: string;
  listOperationCompleted: boolean;
  listPersistenceCommitted: boolean;
  issuanceCompleted: boolean;
  issuancePersistenceCommitted: boolean;
  issuanceApplied: boolean;
  clientIdRole: string;
  clientSecretRole: string;
  pairActive: boolean;
  pairEnvironmentBound: boolean;
  pairAtomicallyPersisted: boolean;
};

export function selectAuthoritativeCredentialPair(
  candidates: CredentialPairCandidate[],
  authority: {
    projectId: string;
    environmentId: string;
    providerOrigin: string;
    credentialIssuanceOperationId?: string;
  },
): [string, string] {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.projectId === authority.projectId &&
      candidate.environmentId === authority.environmentId &&
      candidate.providerOrigin === authority.providerOrigin &&
      (!authority.credentialIssuanceOperationId ||
        candidate.issuanceOperationId === authority.credentialIssuanceOperationId) &&
      candidate.listRequestMethod === "GET" &&
      candidate.listOperationCompleted &&
      candidate.listPersistenceCommitted &&
      candidate.issuanceCompleted &&
      candidate.issuancePersistenceCommitted &&
      candidate.issuanceApplied &&
      candidate.clientIdRole === "partner_api_client_id" &&
      candidate.clientSecretRole === "partner_api_client_secret" &&
      candidate.pairActive &&
      candidate.pairEnvironmentBound &&
      candidate.pairAtomicallyPersisted &&
      candidate.clientIdReferenceId !== candidate.clientSecretReferenceId,
  );
  const pairs = new Map<string, [string, string]>();
  for (const candidate of eligible) {
    const key = `${candidate.issuanceOperationId}:${candidate.clientIdReferenceId}:${candidate.clientSecretReferenceId}`;
    pairs.set(key, [candidate.clientIdReferenceId, candidate.clientSecretReferenceId]);
  }
  if (pairs.size === 0) throw new Error("CREATE_CREDENTIAL_PAIR_UNAVAILABLE");
  if (pairs.size !== 1) throw new Error("CREATE_CREDENTIAL_PAIR_AMBIGUOUS");
  return [...pairs.values()][0]!;
}

export function createIntents(context: DurableContext, runId: string) {
  const common = {
    objectiveId: context.objectiveId,
    flowDraftId: context.flowDraftId,
    constraints: { timeoutMs: 30_000, allowNewPage: false, allowNonExact: false },
  };
  const target = (concept: string, role: "textbox" | "button" | "checkbox", name: string) => ({
    concept,
    role,
    name,
    exact: true,
    scope: { kind: "section" as const, name: "Create Order" },
  });
  const preparation: MissionAuthoringIntent[] = [
    {
      ...common,
      intentId: `create-nav-${runId}`,
      action: { kind: "navigate", url: context.entryUrl },
      expectedEffect: { kind: "navigation", url: context.entryUrl, match: "exact" },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    },
    {
      ...common,
      intentId: `create-client-id-${runId}`,
      action: {
        kind: "fill",
        target: target("client id", "textbox", "Client ID"),
        protectedReferenceId: context.credentialReferenceIds[0],
      },
      expectedEffect: { kind: "none" },
      authorization: { kind: "authentication" },
      protectedInputReferences: [context.credentialReferenceIds[0]],
    },
    {
      ...common,
      intentId: `create-client-secret-${runId}`,
      action: {
        kind: "fill",
        target: target("client secret", "textbox", "Client secret"),
        protectedReferenceId: context.credentialReferenceIds[1],
      },
      expectedEffect: { kind: "none" },
      authorization: { kind: "authentication" },
      protectedInputReferences: [context.credentialReferenceIds[1]],
    },
    {
      ...common,
      intentId: `create-mutation-ack-${runId}`,
      action: {
        kind: "set_checked",
        target: target(
          "mutation acknowledgement",
          "checkbox",
          "I understand this sends a real request that may create or change Partner data.",
        ),
        checked: true,
      },
      expectedEffect: {
        kind: "target_state",
        target: target(
          "mutation acknowledgement",
          "checkbox",
          "I understand this sends a real request that may create or change Partner data.",
        ),
        checked: true,
      },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    },
  ];
  const operation: MissionAuthoringIntent = {
    ...common,
    intentId: `create-order-${runId}`,
    action: {
      kind: "acquire_protected_outputs",
      preparationIntentIds: preparation.map((intent) => intent.intentId),
      syntheticProtectedInputs: [
        {
          semantic: "provider_idempotency_key",
          generatorContract: "opaque_operation_token",
          generatorVersion: 1,
          purpose: "test_order_qualification",
          resourceKind: "order",
          operation: "create",
          target: target("idempotency key", "textbox", "Idempotency-Key"),
        },
        {
          semantic: "nested_client_payload",
          generatorContract: "nested_client_order_json",
          generatorVersion: 1,
          purpose: "test_order_qualification",
          resourceKind: "order",
          operation: "create",
          target: target("json body", "textbox", "JSON body"),
        },
      ],
      mutation: { kind: "one_time", target: target("execute Create Order", "button", "Run POST") },
      request: {
        method: "POST",
        pathTemplate: VITRACT_CREATE_QUALIFICATION.path,
        transports: ["fetch"],
      },
      response: { confirmedNotAppliedStatuses: [400, 401, 403, 404, 409, 429] },
      outputs: [
        {
          reference: "createdOrderId",
          classification: "protected",
          target: {
            concept: "created order id",
            role: "value",
            name: "id",
            exact: true,
            scope: { kind: "section", name: "Create Order" },
          },
          storageName: "Created Vitract Test order identity",
        },
      ],
    },
    expectedEffect: { kind: "none" },
    authorization: { kind: "protected_mutation", authorizationId: context.authorizationId },
    protectedInputReferences: [],
  };
  return { preparation, operation };
}

export async function main() {
  const readOnlyAuthProbe = process.argv.includes("--read-only-auth-probe");
  const qualificationOnly = process.argv.includes("--qualification-only");
  const live = process.argv.includes("--live");
  if (!readOnlyAuthProbe && qualificationOnly === live) {
    process.stdout.write("mode: preflight\ndispatchAuthorized: no\n");
    return;
  }
  if (live && process.env.SCRY_VITRACT_CREATE_LIVE_AUTHORIZATION !== "explicit")
    throw new Error("LIVE_CREATE_EXPLICIT_AUTHORIZATION_REQUIRED");
  const authority = await resolveCanonicalCreateScope();
  const context = await loadDurableContext(authority);
  const policy = executionPolicySchema.parse(context.policy);
  for (const contract of ["opaque_operation_token", "nested_client_order_json"]) {
    if (
      !executionPolicyAllowsProtectedSyntheticInput(policy, {
        contract,
        version: 1,
        purpose: "test_order_qualification",
        resourceKind: "order",
        operation: "create",
      })
    )
      throw new Error("SYNTHETIC_PROTECTED_INPUT_POLICY_DENIED");
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const runner = app.get(MissionProtectedQualificationRunner);
    const runId = randomUUID();
    if (readOnlyAuthProbe) {
      const probe = await loadReadOnlyAuthProbe(context, runId, authority);
      const result = await runner.execute({
        principal: { kind: "service", subject: "scry-service" },
        session: {
          projectId: authority.projectId,
          environmentId: authority.environmentId,
          missionId: context.missionId,
          objectiveId: context.objectiveId,
          flowDraftId: context.flowDraftId,
          agentSessionId: context.agentSessionId,
          objective: "Probe current Vitract partner credential read-only",
          allowedOrigins: context.allowedOrigins,
          initialProtectedReferenceIds: context.credentialReferenceIds,
          turnBudgets: { maxOperations: 10, maxDurationMs: 120_000 },
          idempotencyKey: `vitract-read-auth-${runId}`,
        },
        preparation: probe.preparation,
        operation: probe.operation,
        disposition: "execute",
      });
      const completed = result.stage === "protected" && result.result.state === "completed";
      process.stdout.write(
        [
          `readOnlyAuthentication: ${completed ? "accepted" : "rejected"}`,
          "providerMutationCount: 0",
          "protectedPlaintextExposed: no",
        ].join("\n") + "\n",
      );
      return;
    }
    const intents = createIntents(context, runId);
    const result = await runner.execute({
      principal: { kind: "service", subject: "scry-service" },
      session: {
        projectId: authority.projectId,
        environmentId: authority.environmentId,
        missionId: context.missionId,
        objectiveId: context.objectiveId,
        flowDraftId: context.flowDraftId,
        agentSessionId: context.agentSessionId,
        objective: "Qualify one protected Vitract Test order creation",
        allowedOrigins: context.allowedOrigins,
        initialProtectedReferenceIds: context.credentialReferenceIds,
        turnBudgets: { maxOperations: 10, maxDurationMs: 120_000 },
        idempotencyKey: `vitract-create-${runId}`,
      },
      preparation: intents.preparation,
      operation: intents.operation,
      disposition: qualificationOnly ? "qualification_only" : "execute",
    });
    const qualificationWithheld =
      result.stage === "protected" &&
      result.result.state === "decision_required" &&
      result.result.completed.some(
        (entry) =>
          entry.reasonCode === "PROTECTED_DISPATCH_WITHHELD_BY_QUALIFICATION_POLICY" &&
          entry.mutationOutcome === "not_applied",
      );
    if (qualificationOnly && !qualificationWithheld)
      throw new Error("QUALIFICATION_READY_TO_DISPATCH_NOT_PROVEN");
    process.stdout.write(
      [
        `stage: ${result.stage}`,
        `terminalState: ${result.result.state}`,
        `readyToDispatchEvidence: ${qualificationWithheld ? "yes" : "not_applicable"}`,
        `dispatchWithheld: ${qualificationWithheld ? "yes" : "no"}`,
        "protectedPlaintextExposed: no",
      ].join("\n") + "\n",
    );
  } finally {
    await app.close();
  }
}

async function loadReadOnlyAuthProbe(
  context: DurableContext,
  runId: string,
  authority: { projectId: string; environmentId: string },
) {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry",
  });
  try {
    const result = await pool.query<{
      operation: MissionAuthoringIntent;
      preparation: MissionAuthoringIntent[];
    }>(
      `WITH candidate AS (
         SELECT operation.authoring_session_id,adaptive.authoring_intent AS operation
           FROM protected_operations operation
           JOIN adaptive_operations adaptive
             ON adaptive.session_id=operation.authoring_session_id
            AND adaptive.operation_id=operation.operation_id
          WHERE operation.project_id=$1 AND operation.environment_id=$2
            AND operation.state='completed' AND operation.dispatch_semantics='read_only'
            AND operation.persistence_state='committed'
            AND lower(adaptive.authoring_intent->>'intentId') LIKE '%list%'
          ORDER BY operation.completed_at DESC LIMIT 1
       )
       SELECT candidate.operation,
              COALESCE(jsonb_agg(resolved.intent ORDER BY declared.ordinality),'[]'::jsonb) AS preparation
         FROM candidate
         CROSS JOIN LATERAL jsonb_array_elements_text(candidate.operation->'action'->'preparationIntentIds')
           WITH ORDINALITY declared(intent_id,ordinality)
         CROSS JOIN LATERAL (
           SELECT intent.value AS intent
             FROM mission_authoring_turns turn
             CROSS JOIN LATERAL jsonb_array_elements(turn.safe_input->'intents') intent(value)
            WHERE turn.session_id=candidate.authoring_session_id
              AND intent.value->>'intentId'=declared.intent_id
            LIMIT 1
         ) resolved
        GROUP BY candidate.operation`,
      [authority.projectId, authority.environmentId],
    );
    if (result.rowCount !== 1) throw new Error("READ_ONLY_AUTH_PROBE_UNAVAILABLE");
    const source = result.rows[0]!;
    if (source.operation.action.kind !== "acquire_protected_outputs")
      throw new Error("READ_ONLY_AUTH_PROBE_INVALID");
    const remapped = new Map<string, string>();
    const preparation = source.preparation.map((intent, index) => {
      const intentId = `read-auth-prep-${index}-${runId}`;
      remapped.set(intent.intentId, intentId);
      if (intent.action.kind !== "fill" || !intent.action.protectedReferenceId)
        return { ...intent, intentId };
      const concept =
        `${intent.action.target.concept} ${intent.action.target.name ?? ""} ${intent.action.target.label ?? ""}`.toLowerCase();
      const protectedReferenceId = concept.includes("client secret")
        ? context.credentialReferenceIds[1]
        : concept.includes("client id")
          ? context.credentialReferenceIds[0]
          : undefined;
      if (!protectedReferenceId) throw new Error("READ_ONLY_AUTH_CREDENTIAL_ROLE_AMBIGUOUS");
      return {
        ...intent,
        intentId,
        action: { ...intent.action, protectedReferenceId },
        protectedInputReferences: [protectedReferenceId],
      };
    });
    const operation = {
      ...source.operation,
      intentId: `read-auth-operation-${runId}`,
      action: {
        ...source.operation.action,
        preparationIntentIds: source.operation.action.preparationIntentIds.map((id) =>
          remapped.get(id)!,
        ),
      },
    };
    const credentialRefs = new Set(
      preparation.flatMap((intent) =>
        intent.action.kind === "fill" && intent.action.protectedReferenceId
          ? [intent.action.protectedReferenceId]
          : [],
      ),
    );
    if (
      credentialRefs.size !== 2 ||
      context.credentialReferenceIds.some((id) => !credentialRefs.has(id))
    )
      throw new Error("READ_ONLY_AUTH_CREDENTIAL_PAIR_MISMATCH");
    const navigation: MissionAuthoringIntent = {
      intentId: `read-auth-nav-${runId}`,
      objectiveId: context.objectiveId,
      flowDraftId: context.flowDraftId,
      action: { kind: "navigate", url: context.entryUrl.replace(/#.*$/, "#listPartnerOrders") },
      expectedEffect: {
        kind: "navigation",
        url: context.entryUrl.replace(/#.*$/, "#listPartnerOrders"),
        match: "exact",
      },
      constraints: { timeoutMs: 30_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    };
    return { preparation: [navigation, ...preparation], operation };
  } finally {
    await pool.end();
  }
}

export async function loadDurableContext(authority: {
  projectId: string;
  environmentId: string;
  credentialReferenceIds?: [string, string];
}): Promise<DurableContext> {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry",
  });
  try {
    const credentialPairs = authority.credentialReferenceIds
      ? undefined
      : await pool.query<CredentialPairCandidate>(
          `WITH candidates AS (
         SELECT operation.id,operation.authoring_session_id,operation.project_id,operation.environment_id,
                operation.state,operation.persistence_state,operation.safe_diagnostics,
                adaptive.authoring_intent AS operation
           FROM protected_operations operation
           JOIN adaptive_operations adaptive
             ON adaptive.session_id=operation.authoring_session_id
            AND adaptive.operation_id=operation.operation_id
          WHERE operation.project_id=$1 AND operation.environment_id=$2
            AND operation.state='completed' AND operation.dispatch_semantics='read_only'
            AND operation.persistence_state='committed'
            AND lower(adaptive.authoring_intent->>'intentId') LIKE '%list%'
       ), resolved AS (
         SELECT candidate.*,intent.value AS intent
           FROM candidates candidate
           CROSS JOIN LATERAL jsonb_array_elements_text(candidate.operation->'action'->'preparationIntentIds') declared(intent_id)
           CROSS JOIN mission_authoring_turns turn
           CROSS JOIN LATERAL jsonb_array_elements(turn.safe_input->'intents') intent(value)
          WHERE turn.session_id=candidate.authoring_session_id
            AND intent.value->>'intentId'=declared.intent_id
            AND intent.value->'action'->>'kind'='fill'
       ), semantic AS (
         SELECT resolved.id,resolved.project_id,resolved.environment_id,resolved.state,resolved.persistence_state,
                resolved.safe_diagnostics,
                max(intent->'action'->>'protectedReferenceId') FILTER (
                  WHERE lower(concat_ws(' ',intent->'action'->'target'->>'concept',intent->'action'->'target'->>'name',intent->'action'->'target'->>'label')) LIKE '%client id%'
                    AND lower(concat_ws(' ',intent->'action'->'target'->>'concept',intent->'action'->'target'->>'name',intent->'action'->'target'->>'label')) NOT LIKE '%secret%'
                ) AS client_id,
                max(intent->'action'->>'protectedReferenceId') FILTER (
                  WHERE lower(concat_ws(' ',intent->'action'->'target'->>'concept',intent->'action'->'target'->>'name',intent->'action'->'target'->>'label')) LIKE '%client secret%'
                ) AS client_secret
           FROM resolved
          GROUP BY resolved.id,resolved.project_id,resolved.environment_id,resolved.state,
                   resolved.persistence_state,resolved.safe_diagnostics
       ), provenance AS (
         SELECT semantic.*,client_id.origin_protected_operation_id AS issuance_id,
                issuance.state AS issuance_state,issuance.persistence_state AS issuance_persistence_state,
                issuance.mutation_outcome AS issuance_mutation_outcome,
                issuance.persisted_references,issuance.safe_output_manifest,
                environment.base_origin,
                client_id.security_status AS client_id_status,client_secret.security_status AS client_secret_status,
                client_id.deleted_at AS client_id_deleted_at,client_secret.deleted_at AS client_secret_deleted_at,
                (environment.secret_refs ? semantic.client_id AND environment.secret_refs ? semantic.client_secret) AS environment_bound
           FROM semantic
           JOIN environments environment ON environment.id=semantic.environment_id AND environment.project_id=semantic.project_id
           JOIN project_credentials client_id ON client_id.id=semantic.client_id::uuid AND client_id.project_id=semantic.project_id
           JOIN project_credentials client_secret ON client_secret.id=semantic.client_secret::uuid AND client_secret.project_id=semantic.project_id
             AND client_secret.origin_protected_operation_id=client_id.origin_protected_operation_id
           JOIN protected_operations issuance ON issuance.id=client_id.origin_protected_operation_id
             AND issuance.project_id=semantic.project_id AND issuance.environment_id=semantic.environment_id
       )
       SELECT client_id AS "clientIdReferenceId",client_secret AS "clientSecretReferenceId",
              project_id::text AS "projectId",environment_id::text AS "environmentId",
              issuance_id::text AS "issuanceOperationId",'https://preview-api.vitract.com'::text AS "providerOrigin",
              safe_diagnostics->'mutation'->'request'->>'method' AS "listRequestMethod",
              state='completed' AS "listOperationCompleted",persistence_state='committed' AS "listPersistenceCommitted",
              issuance_state='completed' AS "issuanceCompleted",
              issuance_persistence_state='committed' AS "issuancePersistenceCommitted",
              issuance_mutation_outcome='applied' AS "issuanceApplied",
              'partner_api_client_id'::text AS "clientIdRole",
              'partner_api_client_secret'::text AS "clientSecretRole",
              client_id_status='active' AND client_secret_status='active'
                AND client_id_deleted_at IS NULL AND client_secret_deleted_at IS NULL AS "pairActive",
              environment_bound AS "pairEnvironmentBound",
              EXISTS (SELECT 1 FROM jsonb_each(persisted_references) entry
                       WHERE entry.value->>'credentialId'=client_id)
                AND EXISTS (SELECT 1 FROM jsonb_each(persisted_references) entry
                            WHERE entry.value->>'credentialId'=client_secret)
                AND jsonb_array_length(safe_output_manifest)=2 AS "pairAtomicallyPersisted"
         FROM provenance`,
          [authority.projectId, authority.environmentId],
        );
    const credentialReferenceIds =
      authority.credentialReferenceIds ??
      selectAuthoritativeCredentialPair(credentialPairs!.rows, {
        projectId: authority.projectId,
        environmentId: authority.environmentId,
        providerOrigin: VITRACT_CREATE_QUALIFICATION.providerOrigin,
      });
    const result = await pool.query<any>(
      `SELECT session.mission_id AS "missionId",session.active_objective_id AS "objectiveId",
      session.active_flow_draft_id AS "flowDraftId",session.agent_session_id AS "agentSessionId",
      operation.authorization_id AS "authorizationId",environment.policy->'allowedOrigins' AS "allowedOrigins",environment.policy,
      regexp_replace(observation.safe_summary->>'url', '#.*$', '') || '#createPartnerOrder' AS "entryUrl"
      FROM adaptive_sessions session JOIN environments environment ON environment.id=session.environment_id
      JOIN protected_operations operation ON operation.authoring_session_id=session.id AND operation.state='completed'
      JOIN LATERAL (
        SELECT safe_summary
          FROM adaptive_observations
         WHERE session_id IN (
           SELECT id FROM adaptive_sessions WHERE mission_id=session.mission_id
         )
           AND safe_summary->>'url' LIKE 'https://preview-api.vitract.com/api/docs/partner-api%'
         ORDER BY created_at DESC
         LIMIT 1
      ) observation ON true
      WHERE session.project_id=$1 AND session.environment_id=$2 AND jsonb_array_length(session.protected_reference_allowlist)=2
      ORDER BY operation.completed_at DESC LIMIT 1`,
      [authority.projectId, authority.environmentId],
    );
    if (result.rowCount !== 1) throw new Error("CREATE_DURABLE_CONTEXT_UNAVAILABLE");
    return { ...result.rows[0], credentialReferenceIds };
  } finally {
    await pool.end();
  }
}

async function resolveCanonicalCreateScope() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry",
  });
  try {
    const result = await pool.query<{ projectId: string; environmentId: string }>(
      `SELECT project_id::text AS "projectId",environment_id::text AS "environmentId"
         FROM q5_canonical_scope_designations
        WHERE qualification_key='m6-q5-authoritative'`,
    );
    if (result.rowCount !== 1) throw new Error("Q5_CANONICAL_SCOPE_NOT_PREPARED");
    return result.rows[0]!;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
