import { randomUUID } from "node:crypto";
import { missionAuthoringIntentSchema, type MissionAuthoringIntent } from "@scry/contracts";
import {
  persistAcquiredProtectedOutputs,
  type AcquiredProtectedOutputSet,
  type ProtectedTransactionDependencies,
} from "@scry/executor";

import { AdaptiveSessionRepository, interruptedOperationTruth } from "../../src/adaptive-sessions/adaptive-session.repository.js";
import { compileMissionAuthoringProtectedTransaction } from "../../src/adaptive-sessions/mission-authoring-protected-transaction.js";
import { Database } from "../../src/infrastructure/database.js";
import { ProtectedOutputPersistenceRepository } from "../../src/runtime/repositories/protected-output-persistence.repository.js";

const runId = process.env.SCRY_LAB_RUN_ID;
const sessionId = process.env.SCRY_LAB_PRAXIS_SESSION_ID;
const intentId = process.env.SCRY_LAB_INTENT_ID;

type Summary = Record<
  "PREPARATION" | "AUTHORIZATION" | "ADMISSION" | "DISPATCH" | "MUTATION" |
  "ACQUISITION" | "PERSISTENCE" | "PRIVACY" | "RESULT" | "REASON",
  string
>;

if (!runId || !sessionId || !intentId) {
  console.error("Usage: SCRY_LAB_RUN_ID=<uuid> SCRY_LAB_PRAXIS_SESSION_ID=<uuid> SCRY_LAB_INTENT_ID=<id> pnpm qualify:live protected-interaction");
  process.exitCode = 2;
} else {
  const database = new Database();
  const repository = new AdaptiveSessionRepository(database);
  try {
    const fixture = await loadFixture(database, runId, sessionId, intentId);
    const intent = missionAuthoringIntentSchema.parse(fixture.intent);
    if (intent.action.kind !== "acquire_protected_outputs") throw coded("INTENT_NOT_PROTECTED_ACQUISITION");
    if (intent.objectiveId !== fixture.objectiveId || intent.flowDraftId !== fixture.flowDraftId)
      throw coded("RUN_OPERATION_SCOPE_MISMATCH");
    const scenarios: Array<[string, () => Promise<Summary>]> = [
      ["durable-happy-preflight", () => happyPreflight(database, repository, sessionId, fixture.entryUrl, intent)],
      ["authorization-wrong-praxis", () => rejectedAuthorization(database, randomUUID(), intent)],
      ["authorization-wrong-operation", () => rejectedAuthorization(database, sessionId, { ...intent, intentId: `${intent.intentId}:wrong` })],
      ["preparation-missing-history", () => rejectedPreparation(repository, sessionId, fixture.entryUrl, intent)],
      ["post-dispatch-unknown", async () => postDispatchUnknown()],
      ["persistence-failure", () => persistenceFailure(fixture.entryUrl, intent)],
    ];
    for (const [name, execute] of scenarios) print(name, await execute());
  } catch (error) {
    print("fixture-load", { ...baseSummary(), RESULT: "fail", REASON: errorCode(error) });
    process.exitCode = 1;
  } finally {
    await database.onModuleDestroy();
  }
}

function postDispatchUnknown(): Summary {
  const truth = interruptedOperationTruth("acknowledged");
  return {
    ...baseSummary(), PREPARATION: "pass", AUTHORIZATION: "pass", ADMISSION: "pass",
    DISPATCH: "acknowledged", MUTATION: truth.mutationOutcome,
    ACQUISITION: "not_started", PERSISTENCE: "not_started",
    RESULT: truth.mutationOutcome === "unknown" ? "expected-safe-failure" : "fail",
    REASON: truth.reasonCode,
  };
}

async function persistenceFailure(entryUrl: string | null, intent: MissionAuthoringIntent): Promise<Summary> {
  if (!entryUrl || intent.action.kind !== "acquire_protected_outputs")
    return { ...baseSummary(), RESULT: "fail", REASON: "FIXTURE_INVALID" };
  const transaction = compileMissionAuthoringProtectedTransaction({
    operationId: "lab-persistence-failure", entryUrl,
    action: intent.action, preparation: [], timeoutMs: intent.constraints.timeoutMs,
  });
  transaction.extraction.externalResourceBindings = [{
    status: "unavailable", provider: "lab", resourceKind: "credential_record",
    resourceScope: "protected-interaction", identityContractVersion: 1,
    requiredForDestructiveLifecycle: true,
  }];
  const canary = "synthetic-protected-lab-canary";
  const acquired: AcquiredProtectedOutputSet = transaction.extraction.outputs.map((output, index) => ({
    output,
    value: output.classification === "protected" ? `${canary}-${index}` : `public-${index}`,
    adapter: "input_value" as const,
  }));
  const facts = {
    credentialReferences: {}, publicValueReferences: {}, protectedAcquisitionEvidence: [],
    protectedPersistence: "not_attempted", publicPersistence: "not_attempted",
    credentialSecurity: "not_applicable",
  };
  let atomicAttempts = 0;
  const committed: string[] = [];
  const sqlCalls: unknown[][] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      sqlCalls.push([sql, values]);
      if (sql.includes("SELECT state,safe_output_manifest")) return {
        rowCount: 1,
        rows: [{ state: "persisting", safeOutputManifest: acquired.map(({ output }) => ({
          reference: output.reference, classification: output.classification,
        })) }],
      };
      if (sql.includes("SELECT 1 FROM project_credentials")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO project_credentials")) committed.push("credential");
      if (sql.includes("INSERT INTO generated_public_values")) committed.push("public");
      if (sql.includes("INSERT INTO external_resource_bindings")) {
        committed.push("binding");
        throw new Error("INJECTED_ATOMIC_PERSISTENCE_FAILURE");
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const persistence = new ProtectedOutputPersistenceRepository({
    transaction: async (work: (transactionClient: typeof client) => Promise<unknown>) => {
      const before = [...committed];
      try { return await work(client); }
      catch (error) { committed.splice(0, committed.length, ...before); throw error; }
    },
  } as never);
  const persistOutputsAtomically: NonNullable<
    ProtectedTransactionDependencies["persistOutputsAtomically"]
  > = async (input) => {
    atomicAttempts += 1;
    return persistence.persistOutputsAtomically(
      {
        protectedOperationId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        environmentId: "33333333-3333-4333-8333-333333333333",
        missionId: "44444444-4444-4444-8444-444444444444",
        objectiveId: "55555555-5555-4555-8555-555555555555",
        agentSessionId: "66666666-6666-4666-8666-666666666666",
        ownerKind: "authoring_session", ownerId: "77777777-7777-4777-8777-777777777777",
        operationId: input.operationId, leaseOwner: "lab", fencingToken: 1, version: 1,
      },
      input.outputs.map((output) => ({ ...output, storageName: output.name })),
      input.externalResourceBindings,
    ) as never;
  };
  try {
    await persistAcquiredProtectedOutputs(
      transaction,
      { persistOutputsAtomically } as ProtectedTransactionDependencies,
      facts as never,
      acquired,
      { id: "lab-operation", state: "persisting", version: 1, fencingToken: 1, mutationOutcome: "unknown" },
    );
    return { ...baseSummary(), RESULT: "fail", REASON: "PERSISTENCE_FAILURE_NOT_OBSERVED" };
  } catch (error) {
    const reason = errorCode(error);
    const valuesCleared = acquired.every(({ value }) => value === "");
    const plaintextOpaque = !JSON.stringify(sqlCalls).includes(canary);
    const failClosed = reason === "ATOMIC_OUTPUT_PERSISTENCE_FAILED" && atomicAttempts === 1 &&
      committed.length === 0 && valuesCleared && plaintextOpaque;
    return {
      ...baseSummary(), PREPARATION: "pass", AUTHORIZATION: "pass", ADMISSION: "pass",
      DISPATCH: "acknowledged", MUTATION: "applied", ACQUISITION: "completed",
      PERSISTENCE: "failed", PRIVACY: valuesCleared ? "sealed" : "unverified",
      RESULT: failClosed ? "expected-safe-failure" : "fail", REASON: reason,
    };
  }
}

async function happyPreflight(database: Database, repository: AdaptiveSessionRepository, sessionId: string, entryUrl: string | null, intent: MissionAuthoringIntent) {
  const summary = baseSummary();
  try {
    await repository.validateIntentAdmission({ sessionId, intent });
    summary.ADMISSION = "pass";
    if (!(await authorizationMatches(database, sessionId, intent)))
      throw coded("MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID");
    summary.AUTHORIZATION = "pass";
    if (!entryUrl) throw coded("MISSION_AUTHORING_PROTECTED_ENTRY_UNAVAILABLE");
    if (intent.action.kind !== "acquire_protected_outputs") throw coded("INTENT_NOT_PROTECTED_ACQUISITION");
    const preparation = await repository.protectedPreparationFor({
      sessionId, objectiveId: intent.objectiveId, flowDraftId: intent.flowDraftId,
      intentIds: intent.action.preparationIntentIds, entryUrl,
    });
    compileMissionAuthoringProtectedTransaction({
      operationId: intent.intentId, entryUrl, action: intent.action, preparation,
      timeoutMs: intent.constraints.timeoutMs,
    });
    return { ...summary, PREPARATION: "pass", RESULT: "pass", REASON: "PREFLIGHT_COMPLETE" };
  } catch (error) {
    return { ...summary, RESULT: "fail", REASON: errorCode(error) };
  }
}

async function rejectedAuthorization(database: Database, candidateSessionId: string, intent: MissionAuthoringIntent) {
  const admitted = await authorizationMatches(database, candidateSessionId, intent);
  return {
    ...baseSummary(), PREPARATION: "not_run", ADMISSION: "pass",
    AUTHORIZATION: admitted ? "pass" : "fail",
    RESULT: admitted ? "fail" : "pass",
    REASON: admitted ? "UNEXPECTED_AUTHORIZATION" : "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID",
  };
}

async function rejectedPreparation(repository: AdaptiveSessionRepository, sessionId: string, entryUrl: string | null, intent: MissionAuthoringIntent) {
  if (!entryUrl || intent.action.kind !== "acquire_protected_outputs")
    return { ...baseSummary(), RESULT: "fail", REASON: "FIXTURE_INVALID" };
  try {
    await repository.protectedPreparationFor({
      sessionId, objectiveId: intent.objectiveId, flowDraftId: intent.flowDraftId,
      intentIds: ["characterization-missing-history"], entryUrl,
    });
    return { ...baseSummary(), ADMISSION: "pass", AUTHORIZATION: "pass", PREPARATION: "pass", RESULT: "fail", REASON: "MISSING_HISTORY_ADMITTED" };
  } catch (error) {
    const reason = errorCode(error);
    return {
      ...baseSummary(), ADMISSION: "pass", AUTHORIZATION: "pass", PREPARATION: "fail",
      RESULT: reason === "MISSION_AUTHORING_PREPARATION_INVALID" ? "pass" : "fail", REASON: reason,
    };
  }
}

function authorizationMatches(database: Database, candidateSessionId: string, intent: MissionAuthoringIntent) {
  return database.query(
    `SELECT 1 FROM mission_authorizations auth
      JOIN adaptive_sessions session ON session.id=$2
     WHERE auth.id=$1 AND auth.mission_id=session.mission_id
       AND auth.objective_id=$3 AND auth.environment_id=session.environment_id
       AND auth.kind='protected_mutation' AND auth.operation_id=$4
       AND auth.praxis_session_id=$2 AND auth.status='approved'
       AND (auth.expires_at IS NULL OR auth.expires_at>now())`,
    [intent.authorization.authorizationId, candidateSessionId, intent.objectiveId, intent.intentId],
  ).then((result) => Boolean(result.rowCount));
}

async function loadFixture(database: Database, runId: string, sessionId: string, intentId: string) {
  const fixture = await database.query<{ intent: unknown; entryUrl: string | null; objectiveId: string; flowDraftId: string }>(
    `SELECT turn_intent.value AS intent, observation.safe_summary->>'url' AS "entryUrl",
            session.active_objective_id AS "objectiveId", session.active_flow_draft_id AS "flowDraftId"
       FROM mission_authoring_turns turn
       JOIN adaptive_sessions session ON session.id=turn.session_id
       JOIN run_praxis_sessions binding ON binding.praxis_session_id=session.id
        AND binding.run_id=$3
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(turn.safe_input->'intents','[]'::jsonb)) turn_intent(value)
       LEFT JOIN LATERAL (SELECT safe_summary FROM adaptive_observations
        WHERE session_id=session.id ORDER BY id DESC LIMIT 1) observation ON true
      WHERE turn.session_id=$1 AND turn_intent.value->>'intentId'=$2
      ORDER BY turn.created_at DESC LIMIT 1`,
    [sessionId, intentId, runId],
  );
  if (!fixture.rowCount) throw coded("INTENT_NOT_FOUND");
  return fixture.rows[0]!;
}

function baseSummary(): Summary {
  return {
    PREPARATION: "not_run", AUTHORIZATION: "not_run", ADMISSION: "not_run",
    DISPATCH: "not_started", MUTATION: "not_applied", ACQUISITION: "not_started",
    PERSISTENCE: "not_started", PRIVACY: "unverified", RESULT: "fail", REASON: "NOT_RUN",
  };
}

function print(name: string, summary: Summary) {
  console.log([`SCENARIO      ${name}`, ...Object.entries(summary).map(([key, value]) => `${key.padEnd(13)} ${value}`), ""].join("\n"));
}

function coded(code: string) { return Object.assign(new Error(code), { code }); }
function errorCode(error: unknown) {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; response?: { code?: unknown } };
    if (typeof candidate.code === "string") return candidate.code;
    if (typeof candidate.response?.code === "string") return candidate.response.code;
  }
  return error instanceof Error ? error.message : "UNKNOWN_FAILURE";
}
