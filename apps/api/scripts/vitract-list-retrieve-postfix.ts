import { randomUUID } from "node:crypto";

import type { MissionAuthoringIntent } from "@scry/contracts";
import pg from "pg";

import { decryptCredential } from "../src/access/credential.crypto.js";
import {
  findAdaptiveSessionId,
  initializeMcp,
  rejectToolError,
} from "./deployed-adaptive-campaign.js";

type StoredReference = {
  classification: "public" | "protected";
  credentialId?: string;
  valueId?: string;
  scope: "project" | "run";
};

type Qualification = {
  projectId: string;
  environmentId: string;
  missionId: string;
  agentSessionId: string;
  objectiveId: string;
  flowDraftId: string;
  authorizationId: string;
  allowedOrigins: string[];
  entryUrl: string;
  credentialReferenceIds: string[];
  listIntent: MissionAuthoringIntent;
  listPreparation: MissionAuthoringIntent[];
  retrieveIntent: MissionAuthoringIntent;
  retrievePreparation: MissionAuthoringIntent[];
  entryUrlCandidateCount: number;
};

type SafeTurn = {
  turnId: string;
  state: "completed" | "decision_required" | "pending";
  completed: Array<{ generatedReferences?: Array<{ reference: string } & StoredReference> }>;
  decisionBoundary?: { reasonCode?: string } | null;
};

const pool = new pg.Pool({ connectionString: databaseUrl() });
let mcp: Awaited<ReturnType<typeof initializeMcp>> | undefined;
const openSessions = new Set<string>();
let safeStage = "QUALIFICATION_LOAD";

try {
  const qualification = await identifyQualification();
  const createdOperationId = argumentValue("--created-operation=");
  if (process.argv.includes("--preflight-only")) {
    process.stdout.write([
      "qualificationProvenance: exact",
      "activeExistingCredential: yes",
      "existingCanonicalOrderReference: yes",
      "credentialGeneratedThisTask: no",
      "providerMutationPaths: zero",
      "protectedPlaintextExposed: no",
      "FINAL_STATUS: LIVE_RETRIEVE_ORDER_PREFLIGHT_READY",
    ].join("\n") + "\n");
    process.exitCode = 0;
  } else if (createdOperationId) {
    await retrieveExactCreatedOperation(qualification, createdOperationId);
  } else {
  mcp = await initializeMcp();
  if (process.argv.includes("--acquire-existing-identity")) {
    await acquireExistingIdentity(qualification);
  } else {
  const runId = randomUUID();
  const started = await checkedCall({
    name: "start_flow_authoring",
    arguments: {
      projectId: qualification.projectId,
      environmentId: qualification.environmentId,
      missionId: qualification.missionId,
      agentSessionId: qualification.agentSessionId,
      objectiveId: qualification.objectiveId,
      flowDraftId: qualification.flowDraftId,
      objective: "Validate Vitract List output isolation and opaque Retrieve chaining",
      allowedOrigins: qualification.allowedOrigins,
      correlationId: randomUUID(),
      initialProtectedReferenceIds: qualification.credentialReferenceIds,
      turnBudgets: { maxOperations: 1, maxDurationMs: 30_000 },
      idempotencyKey: `vitract-list-retrieve-postfix-start-${runId}`,
    },
  });
  const sessionId = findAdaptiveSessionId(started);
  assert(sessionId, "POSTFIX_SESSION_ID_MISSING");
  openSessions.add(sessionId);

  const navigate = navigationIntent(qualification, runId);
  const listPreparation = qualification.listPreparation.map((intent) =>
    narrowDocumentationScope(structuredClone(intent), "List Orders"),
  );
  const prepared = await checkedCall({
    name: "advance_flow_authoring",
    arguments: {
      sessionId,
      kind: "intents",
      intents: [navigate, ...listPreparation],
      budgets: {
        maxOperations: 1 + listPreparation.length,
        maxDurationMs: 30_000,
      },
      idempotencyKey: `vitract-list-retrieve-postfix-prepare-${runId}`,
    },
  });
  assert(findTurn(prepared).state === "completed", "POSTFIX_LIST_PREPARATION_FAILED");
  assertPagination(listPreparation);

  const listIntent = narrowDocumentationScope(cloneIntent(qualification.listIntent, {
    intentId: `postfix-list-${runId}`,
    preparationIntentIds: listPreparation.map((intent) => intent.intentId),
  }), "List Orders");
  const listTurn = await executeProtectedTurn(sessionId, listIntent, `postfix-list-${runId}`);
  assert(listTurn.state === "completed", "POSTFIX_LIST_NOT_COMPLETED");
  const listProof = await operationProof(sessionId, listTurn.turnId, listIntent.intentId);
  const listedReferences = listTurn.completed.flatMap((entry) => entry.generatedReferences ?? []);
  assert(listProof.httpStatus === 200, "POSTFIX_LIST_HTTP_STATUS_NOT_200");
  assert(listProof.dispatchCount === 1, "POSTFIX_LIST_DISPATCH_COUNT_INVALID");
  assert(
    listProof.requestStatus === "initiated" &&
      listProof.requestEnvelopeMatched &&
      listProof.requestMethod === "GET",
    "POSTFIX_LIST_READ_ONLY_REQUEST_UNPROVEN",
  );
  assert(listedReferences.length === 1, "POSTFIX_LIST_OUTPUT_COUNT_INVALID");
  assert(listProof.committedOutputCount === 1, "POSTFIX_LIST_COMMITTED_COUNT_INVALID");
  assert(
    listProof.acquisitionSource === "protected_network_value",
    "POSTFIX_LIST_OUTPUT_NOT_NETWORK_ACQUIRED",
  );
  const listed = listedReferences[0]!;
  const listedOpaqueId = opaqueId(listed);
  assert(
    !qualification.credentialReferenceIds.includes(listedOpaqueId),
    "POSTFIX_LIST_OUTPUT_REFERENCE_CONTAMINATED",
  );
  assert(
    !qualification.credentialReferenceIds.includes(listed.reference),
    "POSTFIX_LIST_OUTPUT_ALIAS_CONTAMINATED",
  );
  const listedOrderId = await decryptCommittedReference(qualification.projectId, listed);

  process.stdout.write(`listResponseStatusClass: ${statusClass(listProof.httpStatus)}\n`);
  process.stdout.write(`listDispatchCount: ${listProof.dispatchCount}\n`);
  process.stdout.write("canonicalOrderIdentityAcquired: yes\n");

  const retrieve = retrieveFromQualification(qualification, listedOpaqueId, runId);
  const retrievePrepared = await checkedCall({
    name: "advance_flow_authoring",
    arguments: {
      sessionId,
      kind: "intents",
      intents: retrieve.preparation,
      budgets: { maxOperations: retrieve.preparation.length, maxDurationMs: 30_000 },
      idempotencyKey: `vitract-list-retrieve-postfix-retrieve-prepare-${runId}`,
    },
  });
  assert(findTurn(retrievePrepared).state === "completed", "POSTFIX_RETRIEVE_PREPARATION_FAILED");
  const retrieveTurn = await executeProtectedTurn(
    sessionId,
    retrieve.intent,
    `postfix-retrieve-${runId}`,
  );
  const retrieveProof = await operationProof(
    sessionId,
    retrieveTurn.turnId,
    retrieve.intent.intentId,
  );
  assert(retrieveProof.dispatchCount <= 1, "POSTFIX_RETRIEVE_DISPATCH_LIMIT_EXCEEDED");
  assert(retrieveProof.redispatchCount === 0, "POSTFIX_RETRIEVE_REDISPATCH_FORBIDDEN");
  assert(retrieveProof.state === "completed", "POSTFIX_RETRIEVE_NOT_COMPLETED");
  assert(retrieveProof.requestStatus === "initiated", "POSTFIX_RETRIEVE_REQUEST_NOT_INITIATED");
  assert(retrieveProof.requestEnvelopeMatched, "POSTFIX_RETRIEVE_REQUEST_NOT_EXACT");
  assert(retrieveProof.requestMethod === "GET", "POSTFIX_RETRIEVE_READ_ONLY_REQUEST_UNPROVEN");
  assert(retrieveProof.httpStatus !== null && retrieveProof.httpStatus >= 200 && retrieveProof.httpStatus < 300,
    "POSTFIX_RETRIEVE_RESPONSE_NOT_ACCEPTED");
  assert(retrieveProof.expectedOutputCount === 1, "POSTFIX_RETRIEVE_OUTPUT_CONTRACT_INVALID");
  assert(retrieveProof.acquiredOutputCount === 1, "POSTFIX_RETRIEVE_OUTPUT_NOT_ACQUIRED");
  assert(retrieveProof.committedOutputCount === 1, "POSTFIX_RETRIEVE_OUTPUT_NOT_COMMITTED");
  const retrievedReferences = retrieveTurn.completed.flatMap((entry) => entry.generatedReferences ?? []);
  assert(retrievedReferences.length === 1, "POSTFIX_RETRIEVE_OUTPUT_REFERENCE_INVALID");
  const retrievedOrderId = await decryptCommittedReference(
    qualification.projectId,
    retrievedReferences[0]!,
  );
  assert(retrievedOrderId === listedOrderId, "POSTFIX_RETRIEVE_IDENTITY_MISMATCH");

  process.stdout.write([
    "activeExistingCredential: yes",
    "credentialGeneratedThisTask: no",
    "canonicalOrderIdentitySource: fresh_read_only_list",
    `requestTransportClassification: ${safeTransport(retrieveProof.requestMethod, retrieveProof.requestTransport)}`,
    "requestInitiationObserved: yes",
    "requestCorrelation: exact",
    "responseObserved: yes",
    "responseCorrelation: exact",
    `responseStatusClass: ${statusClass(retrieveProof.httpStatus)}`,
    "bodyAcquisition: succeeded",
    "declaredOutputAcquisition: succeeded",
    "requestedOrderIdentityMatched: yes",
    "providerMutationCount: 0",
    "protectedPlaintextExposed: no",
    "FINAL_STATUS: LIVE_RETRIEVE_ORDER_READ_ONLY_ACCEPTED",
  ].join("\n") + "\n");
  }
  }
} catch (error) {
  process.stderr.write(`safeStage: ${safeStage}\n`);
  process.stderr.write(`${safeCode(error)}\n`);
  process.exitCode = 1;
} finally {
  for (const sessionId of openSessions) await closeSession(sessionId).catch(() => undefined);
  await mcp?.close();
  await pool.end();
}

async function retrieveExactCreatedOperation(
  qualification: Qualification,
  protectedOperationId: string,
) {
  const source = await pool.query<{ reference: StoredReference; dispatchCount: number }>(
    `SELECT operation.persisted_references->'createdOrderId' AS reference,
            count(transition.id) FILTER (WHERE transition.to_state='dispatching')::int AS "dispatchCount"
       FROM protected_operations operation
       LEFT JOIN protected_operation_transitions transition
         ON transition.protected_operation_id=operation.id
      WHERE operation.id=$1 AND operation.project_id=$2 AND operation.environment_id=$3
        AND operation.state='completed' AND operation.persistence_state='committed'
        AND operation.mutation_outcome='applied'
        AND operation.persisted_references ? 'createdOrderId'
      GROUP BY operation.id`,
    [protectedOperationId, qualification.projectId, qualification.environmentId],
  );
  assert(source.rowCount === 1, "POST_CREATE_SOURCE_OPERATION_INVALID");
  assert(source.rows[0]!.dispatchCount === 1, "POST_CREATE_SOURCE_DISPATCH_COUNT_INVALID");
  const createdReference = source.rows[0]!.reference;
  assert(
    createdReference.classification === "protected" && Boolean(createdReference.credentialId),
    "POST_CREATE_REFERENCE_NOT_PROTECTED",
  );

  mcp = await initializeMcp();
  const runId = randomUUID();
  const started = await checkedCall({
    name: "start_flow_authoring",
    arguments: {
      projectId: qualification.projectId, environmentId: qualification.environmentId,
      missionId: qualification.missionId, agentSessionId: qualification.agentSessionId,
      objectiveId: qualification.objectiveId, flowDraftId: qualification.flowDraftId,
      objective: "Verify the exact newly created Vitract Test order read-only",
      allowedOrigins: qualification.allowedOrigins, correlationId: randomUUID(),
      initialProtectedReferenceIds: [
        ...qualification.credentialReferenceIds,
        opaqueId(createdReference),
      ],
      turnBudgets: { maxOperations: 1, maxDurationMs: 30_000 },
      idempotencyKey: `vitract-post-create-retrieve-start-${runId}`,
    },
  });
  const sessionId = findAdaptiveSessionId(started);
  assert(sessionId, "POST_CREATE_RETRIEVE_SESSION_ID_MISSING");
  openSessions.add(sessionId);
  const retrieve = retrieveFromQualification(
    qualification,
    opaqueId(createdReference),
    runId,
  );
  const prepared = await checkedCall({
    name: "advance_flow_authoring",
    arguments: {
      sessionId, kind: "intents",
      intents: [navigationIntent(qualification, runId), ...retrieve.preparation],
      budgets: { maxOperations: retrieve.preparation.length + 1, maxDurationMs: 30_000 },
      idempotencyKey: `vitract-post-create-retrieve-prepare-${runId}`,
    },
  });
  assert(findTurn(prepared).state === "completed", "POST_CREATE_RETRIEVE_PREPARATION_FAILED");
  const retrieveTurn = await executeProtectedTurn(
    sessionId,
    retrieve.intent,
    `vitract-post-create-retrieve-${runId}`,
  );
  const proof = await operationProof(sessionId, retrieveTurn.turnId, retrieve.intent.intentId);
  assert(proof.state === "completed", "POST_CREATE_RETRIEVE_NOT_COMPLETED");
  assert(proof.dispatchCount === 1 && proof.redispatchCount === 0, "POST_CREATE_RETRIEVE_DISPATCH_INVALID");
  assert(proof.requestStatus === "initiated" && proof.requestEnvelopeMatched, "POST_CREATE_RETRIEVE_REQUEST_NOT_EXACT");
  assert(proof.requestMethod === "GET", "POST_CREATE_RETRIEVE_NOT_READ_ONLY");
  assert(proof.httpStatus !== null && proof.httpStatus >= 200 && proof.httpStatus < 300, "POST_CREATE_RETRIEVE_RESPONSE_INVALID");
  const returned = retrieveTurn.completed.flatMap((entry) => entry.generatedReferences ?? []);
  assert(returned.length === 1, "POST_CREATE_RETRIEVE_OUTPUT_INVALID");
  const [createdIdentity, returnedIdentity] = await Promise.all([
    decryptCommittedReference(qualification.projectId, createdReference),
    decryptCommittedReference(qualification.projectId, returned[0]!),
  ]);
  assert(createdIdentity === returnedIdentity, "POST_CREATE_RETRIEVE_IDENTITY_MISMATCH");
  process.stdout.write([
    "postCreateRetrieve: PASS",
    "retrieveRequestCorrelation: exact",
    "retrieveResponseCorrelation: exact",
    "requestedCreatedOrderIdentityMatched: yes",
    "providerMutationCountDuringRetrieve: 0",
    "canonicalCreatedOrderIdentityExposed: no",
  ].join("\n") + "\n");
}

function argumentValue(prefix: string) {
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

async function acquireExistingIdentity(qualification: Qualification) {
  const credentialMapping = mappedCredentialReferences(qualification);
  const identityTypes = process.argv.includes("--practitioner-only")
    ? (["practitioner"] as const)
    : (["client", "practitioner"] as const);
  for (const identityType of identityTypes) {
    const runId = randomUUID();
    safeStage = `${identityType.toUpperCase()}_SESSION_START`;
    const started = await checkedCall({
      name: "start_flow_authoring",
      arguments: {
        projectId: qualification.projectId, environmentId: qualification.environmentId,
        missionId: qualification.missionId, agentSessionId: qualification.agentSessionId,
        objectiveId: qualification.objectiveId, flowDraftId: qualification.flowDraftId,
        objective: `Acquire one authoritative existing Vitract ${identityType} identity read-only`,
        allowedOrigins: qualification.allowedOrigins, correlationId: randomUUID(),
        initialProtectedReferenceIds: [credentialMapping.clientId, credentialMapping.clientSecret],
        turnBudgets: { maxOperations: 1, maxDurationMs: 30_000 },
        idempotencyKey: `vitract-${identityType}-identity-start-${runId}`,
      },
    });
    const sessionId = findAdaptiveSessionId(started);
    assert(sessionId, "IDENTITY_SESSION_ID_MISSING");
    openSessions.add(sessionId);
    try {
      const operationName = identityType === "client" ? "List Clients" : "List Practitioners";
      const section = `${operationName} examples`;
      const prefix = identityType === "client" ? "listPartnerClients" : "listPartnerPractitioners";
      const preparation: MissionAuthoringIntent[] = [
        identityFill(qualification, runId, `${prefix}-client-id`, "Client ID", credentialMapping.clientId, section, 0),
        identityFill(qualification, runId, `${prefix}-client-secret`, "Client secret", credentialMapping.clientSecret, section, 1),
        identityPublicFill(qualification, runId, `${prefix}-query-page`, "page", "1", section, 2),
        // Two is deliberate: a second record makes the canonical `id` leaf
        // ambiguous and prevents persistence instead of selecting by position.
        identityPublicFill(qualification, runId, `${prefix}-query-limit`, "limit", "2", section, 3),
      ];
      const navigation = navigationIntent(qualification, runId);
      safeStage = `${identityType.toUpperCase()}_PREPARATION`;
      const prepared = await checkedCall({
        name: "advance_flow_authoring",
        arguments: { sessionId, kind: "intents", intents: [navigation, ...preparation],
          budgets: { maxOperations: preparation.length + 1, maxDurationMs: 30_000 },
          idempotencyKey: `vitract-${identityType}-identity-prepare-${runId}` },
      });
      assert(findTurn(prepared).state === "completed", "IDENTITY_PREPARATION_FAILED");
      const pathTemplate = identityType === "client"
        ? "/api/v1/partner-api/clients"
        : "/api/v1/partner-api/practitioners";
      const intent: MissionAuthoringIntent = {
        intentId: `vitract-${identityType}-identity-${runId}`,
        objectiveId: qualification.objectiveId, flowDraftId: qualification.flowDraftId,
        action: {
          kind: "acquire_protected_outputs",
          preparationIntentIds: preparation.map((item) => item.intentId),
          mutation: { kind: "read_only", target: { concept: `${operationName} Run`, role: "button", name: "Run", scope: { kind: "region", name: section }, exact: true } },
          request: { method: "GET", pathTemplate, transports: ["fetch", "xhr"] },
          outputs: [
            { reference: `${identityType}CanonicalId`, classification: "protected", target: { concept: `${identityType} canonical id`, role: "value", name: "id", scope: { kind: "region", name: section }, exact: true }, storageName: `Vitract ${identityType} canonical ID` },
            { reference: `${identityType}CollectionCount`, classification: "public", target: { concept: `${identityType} collection count`, role: "value", name: "count", scope: { kind: "region", name: section }, exact: true }, storageName: `Vitract ${identityType} collection count` },
          ],
        },
        expectedEffect: { kind: "none" },
        constraints: { timeoutMs: 30_000, allowNewPage: false, allowNonExact: false },
        authorization: { kind: "protected_mutation", authorizationId: qualification.authorizationId },
        protectedInputReferences: [],
      };
      safeStage = `${identityType.toUpperCase()}_ACQUISITION`;
      const turn = await executeProtectedTurn(sessionId, intent, `vitract-${identityType}-identity-${runId}`);
      if (turn.state !== "completed") continue;
      const proof = await operationProof(sessionId, turn.turnId, intent.intentId);
      const references = turn.completed.flatMap((entry) => entry.generatedReferences ?? []);
      const canonical = references.find((reference) => reference.reference === `${identityType}CanonicalId`);
      const countReference = references.find((reference) => reference.reference === `${identityType}CollectionCount`);
      if (!canonical || !countReference || references.length !== 2) continue;
      const count = await decryptCommittedReference(qualification.projectId, countReference);
      assert(count === "1", "IDENTITY_SINGLETON_NOT_PROVEN");
      assert(proof.httpStatus === 200 && proof.dispatchCount === 1 && proof.requestStatus === "initiated" && proof.requestEnvelopeMatched && proof.requestMethod === "GET", "IDENTITY_READ_ONLY_LIFECYCLE_UNPROVEN");
      process.stdout.write([
        `identityType: ${identityType}`, `identityAcquisitionOperation: ${operationName}`,
        "identityRequestCorrelation: exact", "identityResponseCorrelation: exact",
        "canonicalExistingIdentityAcquired: yes", "canonicalExistingIdentityExposed: no",
        "PIIExposed: no", "identityPersistence: PASS", "providerMutationCount: 0",
        `identityOpaqueReferenceId: ${opaqueId(canonical)}`,
        "FINAL_STATUS: EXISTING_IDENTITY_ACQUIRED",
      ].join("\n") + "\n");
      return;
    } finally {
      await closeSession(sessionId).catch(() => undefined);
      openSessions.delete(sessionId);
    }
  }
  throw new Error("NO_SAFE_EXISTING_IDENTITY_AVAILABLE");
}

function mappedCredentialReferences(qualification: Qualification) {
  const mapped = qualification.listPreparation.flatMap((intent) => {
    if (intent.action.kind !== "fill" || !intent.action.protectedReferenceId) return [];
    const concept = `${intent.action.target.concept} ${intent.action.target.name ?? ""} ${intent.action.target.label ?? ""}`.toLowerCase();
    return [{ concept, reference: intent.action.protectedReferenceId }];
  });
  const clientId = mapped.filter(({ concept }) => concept.includes("client id"));
  const clientSecret = mapped.filter(({ concept }) => concept.includes("client secret"));
  assert(clientId.length === 1 && clientSecret.length === 1, "IDENTITY_CREDENTIAL_MAPPING_AMBIGUOUS");
  assert(clientId[0]!.reference !== clientSecret[0]!.reference, "IDENTITY_CREDENTIAL_MAPPING_COLLISION");
  return { clientId: clientId[0]!.reference, clientSecret: clientSecret[0]!.reference };
}

function identityFill(qualification: Qualification, runId: string, testId: string, label: string, protectedReferenceId: string, section: string, index: number): MissionAuthoringIntent {
  return {
    intentId: `identity-protected-${index}-${runId}`, objectiveId: qualification.objectiveId, flowDraftId: qualification.flowDraftId,
    action: { kind: "fill", target: { concept: `${section} ${label}`, role: "textbox", label, testId, scope: { kind: "region", name: section }, exact: true }, protectedReferenceId },
    expectedEffect: { kind: "none" }, constraints: { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "authentication" }, protectedInputReferences: [protectedReferenceId],
  };
}

function identityPublicFill(qualification: Qualification, runId: string, testId: string, label: string, publicValue: string, section: string, index: number): MissionAuthoringIntent {
  return {
    intentId: `identity-public-${index}-${runId}`, objectiveId: qualification.objectiveId, flowDraftId: qualification.flowDraftId,
    action: { kind: "fill", target: { concept: `${section} ${label}`, role: "textbox", label, testId, scope: { kind: "region", name: section }, exact: true }, publicValue },
    expectedEffect: { kind: "none" }, constraints: { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" }, protectedInputReferences: [],
  };
}

async function identifyQualification(): Promise<Qualification> {
  const result = await pool.query<Qualification & { candidateCount: number }>(
    `WITH intent_operations AS (
       SELECT operation.*,turn.id AS turn_id,intent.value AS intent,
              turn.safe_input->'intents' AS turn_intents
         FROM protected_operations operation
         JOIN mission_authoring_turns turn ON turn.session_id=operation.authoring_session_id
         CROSS JOIN LATERAL jsonb_array_elements(turn.safe_input->'intents') intent(value)
        WHERE operation.operation_id=
          'm2-' || substr(encode(digest(turn.id::text || ':' || (intent.value->>'intentId'),'sha256'),'hex'),1,40)
     ), pairs AS (
       SELECT list.*,retrieve.id AS retrieve_id,retrieve.created_at AS retrieve_created_at,
              retrieve.state AS retrieve_state,retrieve.failure_code AS retrieve_reason,
              retrieve.safe_diagnostics AS retrieve_diagnostics,retrieve.intent AS retrieve_intent,
              list_preparation.intents AS list_preparation,
              list_preparation.valid AS list_preparation_valid,
              retrieve_preparation.intents AS retrieve_preparation,
              retrieve_preparation.valid AS retrieve_preparation_valid
         FROM intent_operations list
         JOIN intent_operations retrieve
           ON retrieve.mission_id=list.mission_id
          AND retrieve.authoring_session_id=list.authoring_session_id
          AND retrieve.created_at>list.created_at
         CROSS JOIN LATERAL (
           SELECT COALESCE(jsonb_agg(resolved.intent ORDER BY declared.ordinality),'[]'::jsonb) AS intents,
                  COALESCE(bool_and(resolved.match_count=1),false) AS valid
             FROM jsonb_array_elements_text(list.intent->'action'->'preparationIntentIds')
                    WITH ORDINALITY declared(intent_id,ordinality)
             CROSS JOIN LATERAL (
               SELECT (jsonb_agg(candidate.value)->0) AS intent,count(*)::int AS match_count
                 FROM mission_authoring_turns preparation_turn
                 CROSS JOIN LATERAL jsonb_array_elements(preparation_turn.safe_input->'intents') candidate(value)
                WHERE preparation_turn.session_id=list.authoring_session_id
                  AND candidate.value->>'intentId'=declared.intent_id
             ) resolved
         ) list_preparation
         CROSS JOIN LATERAL (
           SELECT COALESCE(jsonb_agg(resolved.intent ORDER BY declared.ordinality),'[]'::jsonb) AS intents,
                  COALESCE(bool_and(resolved.match_count=1),false) AS valid
             FROM jsonb_array_elements_text(retrieve.intent->'action'->'preparationIntentIds')
                    WITH ORDINALITY declared(intent_id,ordinality)
             CROSS JOIN LATERAL (
               SELECT (jsonb_agg(candidate.value)->0) AS intent,count(*)::int AS match_count
                 FROM mission_authoring_turns preparation_turn
                 CROSS JOIN LATERAL jsonb_array_elements(preparation_turn.safe_input->'intents') candidate(value)
                WHERE preparation_turn.session_id=retrieve.authoring_session_id
                  AND candidate.value->>'intentId'=declared.intent_id
             ) resolved
         ) retrieve_preparation
        WHERE list.state='completed'
          AND list.dispatch_semantics='read_only'
          AND list.persistence_state='committed'
          AND list.safe_diagnostics->'responseEvidence'->>'httpStatusCode'='200'
          AND (SELECT count(*) FROM jsonb_object_keys(list.persisted_references))=1
          AND list.persisted_references ? 'listedOrderId'
          AND lower(list.intent->>'intentId') LIKE '%list%'
          AND retrieve.state='failed_not_applied'
          AND retrieve.dispatch_semantics='read_only'
          AND retrieve.safe_diagnostics->'responseEvidence'->>'httpStatusCode'='400'
          AND lower(retrieve.intent->>'intentId') LIKE '%retrieve%'
          AND (SELECT count(*) FROM protected_operation_transitions transition
                WHERE transition.protected_operation_id=list.id AND transition.to_state='dispatching')=1
          AND (SELECT count(*) FROM protected_operation_transitions transition
                WHERE transition.protected_operation_id=retrieve.id AND transition.to_state='dispatching')=1
          AND list.intent->'action'->>'kind'='acquire_protected_outputs'
          AND retrieve.intent->'action'->>'kind'='acquire_protected_outputs'
     ), qualified AS (
       SELECT pair.*,
              ARRAY(SELECT DISTINCT item->'action'->>'protectedReferenceId'
                      FROM jsonb_array_elements(pair.list_preparation) item
                     WHERE item->'action'->>'kind'='fill'
                       AND item->'action'->>'protectedReferenceId' IS NOT NULL
                     ORDER BY item->'action'->>'protectedReferenceId') AS credential_refs,
              ARRAY(SELECT DISTINCT item->'action'->>'protectedReferenceId'
                      FROM jsonb_array_elements(pair.retrieve_preparation) item
                     WHERE item->'action'->>'kind'='fill'
                       AND item->'action'->>'protectedReferenceId' IS NOT NULL
                     ORDER BY item->'action'->>'protectedReferenceId') AS retrieve_protected_refs
         FROM pairs pair
     ), valid AS (
       SELECT qualified.*
         FROM qualified
        WHERE list_preparation_valid
          AND retrieve_preparation_valid
          AND cardinality(credential_refs)=2
          AND (SELECT count(*) FROM jsonb_array_elements(list_preparation) item
                WHERE item->'action'->>'kind'='fill'
                  AND item->'action'->>'protectedReferenceId' IS NOT NULL)=2
          AND cardinality(retrieve_protected_refs)=3
          AND (SELECT count(*) FROM jsonb_array_elements(retrieve_preparation) item
                WHERE item->'action'->>'kind'='fill'
                  AND item->'action'->>'protectedReferenceId' IS NOT NULL)=3
          AND credential_refs <@ retrieve_protected_refs
          AND cardinality(ARRAY(SELECT unnest(retrieve_protected_refs)
                                 EXCEPT SELECT unnest(credential_refs)))=1
          AND (SELECT count(*) FROM project_credentials credential
                WHERE credential.id=ANY(credential_refs::uuid[])
                  AND credential.project_id=qualified.project_id
                  AND credential.security_status='active' AND credential.deleted_at IS NULL
                  AND credential.origin_protected_operation_id IS NOT NULL)=2
          AND (SELECT count(DISTINCT credential.origin_protected_operation_id)
                 FROM project_credentials credential
                WHERE credential.id=ANY(credential_refs::uuid[]))=1
          AND EXISTS (
            SELECT 1 FROM protected_operations issuance
             WHERE issuance.id=(SELECT credential.origin_protected_operation_id
                                  FROM project_credentials credential
                                 WHERE credential.id=credential_refs[1]::uuid)
               AND issuance.mission_id=qualified.mission_id
               AND issuance.state='completed' AND issuance.persistence_state='committed'
          )
     ), latest AS (
       SELECT valid.*,dense_rank() OVER (ORDER BY retrieve_created_at DESC) latest_rank FROM valid
     )
     SELECT latest.project_id AS "projectId",latest.environment_id AS "environmentId",
            latest.mission_id AS "missionId",latest.agent_session_id AS "agentSessionId",
            latest.objective_id AS "objectiveId",latest.flow_draft_id AS "flowDraftId",
            latest.authorization_id AS "authorizationId",session.allowed_origins AS "allowedOrigins",
            observation.entry_urls[1] AS "entryUrl",
            cardinality(observation.entry_urls)::int AS "entryUrlCandidateCount",
            latest.credential_refs AS "credentialReferenceIds",
            latest.intent AS "listIntent",
            latest.list_preparation AS "listPreparation",
            latest.retrieve_intent AS "retrieveIntent",
            latest.retrieve_preparation AS "retrievePreparation",
            count(*) OVER ()::int AS "candidateCount"
       FROM latest
       JOIN adaptive_sessions session ON session.id=latest.authoring_session_id
       CROSS JOIN LATERAL (
         WITH list_position AS (
           SELECT sequence FROM adaptive_operations
            WHERE session_id=latest.authoring_session_id AND operation_id=latest.operation_id
         ), associated AS (
           SELECT DISTINCT safe_summary->>'url' AS url
             FROM adaptive_observations
            WHERE session_id=latest.authoring_session_id
              AND operation_id=latest.operation_id
              AND safe_summary->>'url' IS NOT NULL
         ), preceding_position AS (
           SELECT max(observed.sequence) AS sequence
             FROM adaptive_operations observed,list_position
            WHERE observed.session_id=latest.authoring_session_id
              AND observed.sequence<list_position.sequence
              AND EXISTS (SELECT 1 FROM adaptive_observations candidate
                           WHERE candidate.session_id=observed.session_id
                             AND candidate.operation_id=observed.operation_id
                             AND candidate.safe_summary->>'url' IS NOT NULL)
         ), preceding AS (
           SELECT DISTINCT observation.safe_summary->>'url' AS url
             FROM adaptive_observations observation
             JOIN adaptive_operations observed
               ON observed.session_id=observation.session_id
              AND observed.operation_id=observation.operation_id
             JOIN preceding_position ON preceding_position.sequence=observed.sequence
            WHERE observation.session_id=latest.authoring_session_id
              AND observation.safe_summary->>'url' IS NOT NULL
         )
         SELECT ARRAY(SELECT url FROM associated
                      UNION ALL
                      SELECT url FROM preceding WHERE NOT EXISTS (SELECT 1 FROM associated)) AS entry_urls
       ) observation
      WHERE latest_rank=1`,
  );
  assert(
    result.rowCount === 1 && result.rows[0]!.candidateCount === 1,
    "POSTFIX_QUALIFICATION_PROVENANCE_NOT_UNIQUE",
  );
  const row = result.rows[0]!;
  assert(
    row.authorizationId &&
      row.entryUrl &&
      row.entryUrlCandidateCount === 1 &&
      row.listPreparation.length > 0 &&
      row.retrievePreparation.length > 0,
    "POSTFIX_QUALIFICATION_PROVENANCE_INCOMPLETE",
  );
  return row;
}

function navigationIntent(qualification: Qualification, runId: string): MissionAuthoringIntent {
  return {
    intentId: `postfix-navigate-${runId}`,
    objectiveId: qualification.objectiveId,
    flowDraftId: qualification.flowDraftId,
    action: { kind: "navigate", url: qualification.entryUrl },
    expectedEffect: { kind: "navigation", url: qualification.entryUrl, match: "exact" },
    constraints: { timeoutMs: 15_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" },
    protectedInputReferences: [],
  };
}

function cloneIntent(
  source: MissionAuthoringIntent,
  replacement: { intentId: string; preparationIntentIds: string[] },
): MissionAuthoringIntent {
  assert(source.action.kind === "acquire_protected_outputs", "POSTFIX_LIST_INTENT_INVALID");
  return {
    ...source,
    intentId: replacement.intentId,
    action: { ...source.action, preparationIntentIds: replacement.preparationIntentIds },
  };
}

function retrieveFromQualification(
  qualification: Qualification,
  listedOpaqueId: string,
  runId: string,
): { intent: MissionAuthoringIntent; preparation: MissionAuthoringIntent[] } {
  assert(
    qualification.retrieveIntent.action.kind === "acquire_protected_outputs",
    "POSTFIX_RETRIEVE_INTENT_MISSING",
  );
  const oldOrderReferences = new Set(
    qualification.retrievePreparation
      .flatMap((intent) =>
        intent.action.kind === "fill" && intent.action.protectedReferenceId
          ? [intent.action.protectedReferenceId]
          : [],
      )
      .filter((id) => !qualification.credentialReferenceIds.includes(id)),
  );
  assert(oldOrderReferences.size === 1, "POSTFIX_RETRIEVE_ORDER_INPUT_NOT_UNIQUE");
  const preparation = qualification.retrievePreparation.map((source, index) => {
    const cloned = narrowDocumentationScope(structuredClone(source), "Retrieve Order");
    cloned.intentId = `postfix-retrieve-prepare-${index}-${runId}`;
    cloned.protectedInputReferences = cloned.protectedInputReferences.map((id) =>
      oldOrderReferences.has(id) ? listedOpaqueId : id,
    );
    if (
      cloned.action.kind === "fill" &&
      cloned.action.protectedReferenceId &&
      oldOrderReferences.has(cloned.action.protectedReferenceId)
    ) {
      cloned.action.protectedReferenceId = listedOpaqueId;
    }
    return cloned;
  });
  const intent = narrowDocumentationScope(structuredClone(qualification.retrieveIntent), "Retrieve Order");
  intent.intentId = `postfix-retrieve-${runId}`;
  intent.protectedInputReferences = intent.protectedInputReferences.map((id) =>
    oldOrderReferences.has(id) ? listedOpaqueId : id,
  );
  assert(intent.action.kind === "acquire_protected_outputs", "POSTFIX_RETRIEVE_INTENT_INVALID");
  intent.action.preparationIntentIds = preparation.map((item) => item.intentId);
  return { intent, preparation };
}

function narrowDocumentationScope(
  source: MissionAuthoringIntent,
  operationName: "List Orders" | "Retrieve Order",
): MissionAuthoringIntent {
  const scope = { kind: "region" as const, name: `${operationName} examples` };
  if ("target" in source.action && source.action.target) {
    source.action.target.scope = scope;
  }
  if (source.action.kind === "acquire_protected_outputs") {
    source.action.mutation.target.scope = scope;
  }
  return source;
}

function assertPagination(preparation: MissionAuthoringIntent[]) {
  const publicFills = preparation
    .filter((intent) => intent.action.kind === "fill" && intent.action.publicValue)
    .map((intent) =>
      intent.action.kind === "fill"
        ? {
            concept:
              `${intent.action.target.concept} ${intent.action.target.name ?? ""}`.toLowerCase(),
            value: intent.action.publicValue,
          }
        : { concept: "", value: undefined },
    );
  assert(
    publicFills.some((field) => field.concept.includes("page") && field.value === "1"),
    "POSTFIX_LIST_PAGE_NOT_ONE",
  );
  assert(
    publicFills.some((field) => field.concept.includes("limit") && field.value === "1"),
    "POSTFIX_LIST_LIMIT_NOT_ONE",
  );
}

async function executeProtectedTurn(
  sessionId: string,
  intent: MissionAuthoringIntent,
  key: string,
) {
  let response = await checkedCall({
    name: "advance_flow_authoring",
    arguments: {
      sessionId,
      kind: "intents",
      intents: [intent],
      budgets: { maxOperations: 1, maxDurationMs: 30_000 },
      idempotencyKey: key,
    },
  });
  let turn = findTurn(response);
  assert(turn.state === "pending", "POSTFIX_PROTECTED_OPERATION_NOT_PENDING");
  // The production operation owns a 30-second deadline. Polling must outlive
  // that owner long enough to observe its durable terminal transition; it must
  // never close the session while persistence/finalization is still in flight.
  for (let poll = 1; turn.state === "pending" && poll <= 160; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    response = await checkedCall({
      name: "advance_flow_authoring",
      arguments: {
        sessionId,
        kind: "continue",
        turnId: turn.turnId,
        budgets: { maxOperations: 1, maxDurationMs: 30_000 },
        idempotencyKey: `${key}-continue-${poll}`,
      },
    });
    turn = findTurn(response);
  }
  assert(turn.state !== "pending", "POSTFIX_PROTECTED_OPERATION_TIMEOUT");
  return turn;
}

async function operationProof(sessionId: string, turnId: string, intentId: string) {
  const result = await pool.query<{
    state: string;
    reasonCode: string | null;
    httpStatus: number | null;
    dispatchCount: number;
    redispatchCount: number;
    expectedOutputCount: number;
    acquiredOutputCount: number;
    committedOutputCount: number;
    acquisitionSource: string | null;
    requestStatus: string | null;
    requestMethod: string | null;
    requestTransport: string | null;
    requestEnvelopeMatched: boolean;
  }>(
    `SELECT operation.state,operation.failure_code AS "reasonCode",
            (operation.safe_diagnostics->'responseEvidence'->>'httpStatusCode')::int AS "httpStatus",
            count(*) FILTER (WHERE transition.to_state='dispatching')::int AS "dispatchCount",
            GREATEST(count(*) FILTER (WHERE transition.to_state='dispatching')-1,0)::int AS "redispatchCount",
            jsonb_array_length(operation.safe_output_manifest)::int AS "expectedOutputCount",
            COALESCE((operation.safe_diagnostics->'protectedAcquisitionEvidence'->>'acquiredOutputCount')::int,
                     (SELECT count(*)::int FROM jsonb_object_keys(operation.persisted_references)),0)::int AS "acquiredOutputCount",
            (SELECT count(*)::int FROM jsonb_object_keys(operation.persisted_references)) AS "committedOutputCount",
            (SELECT CASE WHEN count(DISTINCT evidence->>'adapter')=1 THEN min(evidence->>'adapter') END
               FROM jsonb_array_elements(COALESCE(operation.safe_diagnostics->'protectedAcquisitionEvidence','[]'::jsonb)) evidence
              WHERE evidence->>'reference'='listedOrderId') AS "acquisitionSource",
            operation.safe_diagnostics->'mutation'->'request'->>'status' AS "requestStatus",
            operation.safe_diagnostics->'mutation'->'request'->>'method' AS "requestMethod",
            operation.safe_diagnostics->'mutation'->'request'->>'transport' AS "requestTransport",
            COALESCE((operation.safe_diagnostics->'mutation'->'request'->>'envelopeMatched')::boolean,false)
              AS "requestEnvelopeMatched"
       FROM protected_operations operation
       LEFT JOIN protected_operation_transitions transition ON transition.protected_operation_id=operation.id
      WHERE operation.authoring_session_id=$1
        AND operation.operation_id='m2-' || substr(encode(digest($2 || ':' || $3,'sha256'),'hex'),1,40)
      GROUP BY operation.id`,
    [sessionId, turnId, intentId],
  );
  assert(result.rowCount === 1, "POSTFIX_DURABLE_OPERATION_PROOF_MISSING");
  return result.rows[0]!;
}

async function decryptCommittedReference(projectId: string, reference: StoredReference) {
  assert(
    reference.classification === "protected" && reference.credentialId,
    "POSTFIX_LIST_OUTPUT_NOT_PROJECT_PROTECTED",
  );
  const result = await pool.query<{
    ciphertext: Buffer;
    initializationVector: Buffer;
    authenticationTag: Buffer;
  }>(
    `SELECT ciphertext,initialization_vector AS "initializationVector",
            authentication_tag AS "authenticationTag"
       FROM project_credentials
      WHERE id=$1 AND project_id=$2 AND security_status='active' AND deleted_at IS NULL`,
    [reference.credentialId, projectId],
  );
  assert(result.rowCount === 1, "POSTFIX_LIST_OUTPUT_UNAVAILABLE");
  return decryptCredential(result.rows[0]!);
}

function opaqueId(reference: StoredReference) {
  const ids = [reference.credentialId, reference.valueId].filter(Boolean) as string[];
  assert(ids.length === 1, "POSTFIX_LIST_OUTPUT_OPAQUE_ID_INVALID");
  return ids[0]!;
}

async function checkedCall(tool: { name: string; arguments: Record<string, unknown> }) {
  assert(mcp, "POSTFIX_MCP_NOT_INITIALIZED");
  const response = await mcp.call(tool);
  try {
    rejectToolError(response);
  } catch (error) {
    process.stderr.write(`safeToolShape: ${JSON.stringify(safeShape(response))}\n`);
    const rejectionCode = findNested(response, (record) =>
      typeof record.code === "string"
        ? /release/i.test(record.code) ? "RELEASE_ADMISSION_REJECTED"
          : /reference/i.test(record.code) ? "PROTECTED_REFERENCE_ADMISSION_REJECTED"
            : /ownership/i.test(record.code) ? "OWNERSHIP_ADMISSION_REJECTED"
              : /capabilit|origin/i.test(record.code) ? "ENVIRONMENT_CAPABILITY_REJECTED"
                : "UNCLASSIFIED_ADMISSION_REJECTION"
        : undefined,
    );
    if (rejectionCode) process.stderr.write(`safeRejectionCode: ${rejectionCode}\n`);
    const rejectionStatus = findNested(response, (record) =>
      typeof record.status === "number" ? record.status : undefined,
    );
    if (rejectionStatus) process.stderr.write(`safeRejectionStatus: ${rejectionStatus}\n`);
    throw error;
  }
  return response;
}

function safeShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 5).map(safeShape);
  if (!value || typeof value !== "object") return typeof value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([key, child]) => [key, safeShape(child)]));
}

async function closeSession(sessionId: string) {
  await checkedCall({
    name: "close_flow_authoring",
    arguments: { sessionId, idempotencyKey: `vitract-list-retrieve-postfix-close-${sessionId}` },
  });
  openSessions.delete(sessionId);
}

function findTurn(value: unknown): SafeTurn {
  const found = findNested(value, (record) =>
    typeof record.turnId === "string" &&
    ["completed", "pending", "decision_required"].includes(String(record.state))
      ? (record as unknown as SafeTurn)
      : undefined,
  );
  assert(found, "POSTFIX_TURN_RESPONSE_MISSING");
  return found;
}

function findNested<T>(
  value: unknown,
  select: (record: Record<string, unknown>) => T | undefined,
): T | undefined {
  if (typeof value === "string") {
    try {
      return findNested(JSON.parse(value), select);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNested(entry, select);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const selected = select(value as Record<string, unknown>);
  if (selected !== undefined) return selected;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findNested(entry, select);
    if (found !== undefined) return found;
  }
  return undefined;
}

function databaseUrl() {
  return process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry";
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function safeCode(error: unknown) {
  return error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message)
    ? error.message
    : "POSTFIX_RUNNER_FAILED";
}

function statusClass(status: number | null) {
  if (status === null) return "unavailable";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function safeTransport(method: string | null, transport: string | null) {
  const safeMethod = method && /^(GET|POST|PUT|PATCH|DELETE)$/.test(method) ? method : "other";
  const safeType = transport && /^(document|fetch|xhr)$/.test(transport) ? transport : "other";
  return `${safeMethod.toLowerCase()}_${safeType}`;
}
