import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ProjectConfigurationRepository } from "../src/access/repositories/project-configuration.repository.js";
import { MissionFlowAuthoringService } from "../src/adaptive-sessions/mission-flow-authoring.service.js";
import { VitractCredentialIssuancePreparationService } from "../src/adaptive-sessions/services/vitract-credential-issuance-preparation.js";
import { VitractObservedOperationContractProvider } from "../src/adaptive-sessions/vitract-observed-operation-contract.provider.js";
import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { PreparedProtectedOperationRepository } from "../src/adaptive-sessions/repositories/prepared-protected-operation.repository.js";
import { Database } from "../src/infrastructure/index.js";
import { OrchestrationService } from "../src/orchestration/index.js";
import { ProtectedOperationRepository } from "../src/runtime/repositories/protected-operation.repository.js";
import { ProtectedOutputPersistenceRepository } from "../src/runtime/repositories/protected-output-persistence.repository.js";
import { Q5ScopeBootstrapRepository } from "../src/runtime/repositories/q5-scope-bootstrap.repository.js";
import { bootstrapQ5CanonicalScope } from "../src/runtime/q5-scope-bootstrap.js";

const databaseUrl = process.env.SCRY_VITRACT_COMPOSITION_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("exact production Vitract/Q5 composition", () => {
  let database: Database;
  afterAll(async () => database?.onModuleDestroy());

  it("composes generated scope through typed issuance outputs into the actual Q5 prepared scope", async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'Vitract C2',$2)`, [
      workspaceId,
      `vitract-c2-${workspaceId}`,
    ]);
    await database.query(
      `INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$1,$2)`,
      [userId, `vitract-c2-${userId}@example.test`],
    );
    await database.query(
      `INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')`,
      [workspaceId, userId],
    );
    const facts = {
      sourceCommit: "a".repeat(40),
      sourceManifest: "b".repeat(64),
      schemaFingerprint: "c".repeat(64),
      migrationIdentity: "d".repeat(64),
    };
    const store = new Q5ScopeBootstrapRepository(database, workspaceId);
    const empty = await bootstrapQ5CanonicalScope(store, facts);
    expect(empty.status).toBe("credential_issuance_required");
    if (empty.status !== "credential_issuance_required") throw new Error("expected empty scope");
    const principal = {
      kind: "user" as const,
      subject: userId,
      userId,
      email: `vitract-c2-${userId}@example.test`,
      workspaceId,
      role: "owner" as const,
    };
    const configuration = new ProjectConfigurationRepository(database);
    const email = await configuration.createCredential(principal, empty.projectId, {
      name: `Vitract login email ${randomUUID()}`,
      value: "deterministic-email@example.test",
    });
    const password = await configuration.createCredential(principal, empty.projectId, {
      name: `Vitract login password ${randomUUID()}`,
      value: "deterministic-password",
    });
    const sessions = new AdaptiveSessionRepository(database);
    const prepared = new PreparedProtectedOperationRepository(database);
    const protectedOperations = new ProtectedOperationRepository(database);
    const outputs = new ProtectedOutputPersistenceRepository(database);
    const ownerId = randomUUID();
    const runner: any = {
      initialize: async (sessionId: string) => {
        await sessions.claimRuntimeLease({ sessionId, ownerId, leaseDurationMs: 120_000 });
      },
      close: vi.fn().mockResolvedValue(undefined),
      observe: vi.fn(async (sessionId: string) => observation(sessionId)),
      observeOperationContracts: vi.fn().mockResolvedValue([]),
      execute: vi.fn(async (sessionId: string, operation: { operationId: string }) => {
        await executeDeterministicIssuance({
          database,
          protectedOperations,
          outputs,
          sessionId,
          operationId: operation.operationId,
        });
        return {};
      }),
    };
    const authoring = new MissionFlowAuthoringService(
      sessions,
      runner,
      { assertAcceptingWork: vi.fn().mockResolvedValue(undefined) } as never,
      undefined,
      undefined,
      prepared,
      new VitractObservedOperationContractProvider(),
    );
    const composition = new VitractCredentialIssuancePreparationService(database, authoring);
    const lifecycle = await composition.createLifecycle(principal, {
      projectId: empty.projectId,
      environmentId: empty.environmentId,
      loginEmailReferenceId: email.id,
      loginPasswordReferenceId: password.id,
      applicationResourceScope: "vtr_app_deterministic",
      credentialName: "Scry deterministic Q5",
      idempotencyKey: `vitract-c2-${randomUUID()}`,
      distinctMissionReason: "Generated clean-state deterministic production composition.",
      distinctMissionAuthority: {
        confirmedUserAuthorized: true,
        selection: "start_distinct_mission",
        source: "current_request_explicit",
      },
    });
    expect(lifecycle).toMatchObject({ authoringReady: true, environmentId: empty.environmentId });
    const reserved = await composition.reserveObserved(principal, {
      lifecycle,
      credentialName: "Scry deterministic Q5",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const authorization = await new OrchestrationService(database).grantAuthorization(
      principal,
      lifecycle.missionId,
      {
        missionId: lifecycle.missionId,
        objectiveId: lifecycle.objectiveId,
        environmentId: lifecycle.environmentId,
        agentSessionId: lifecycle.agentSessionId,
        kind: "protected_mutation",
        reason: "Deterministic production composition",
        confirmedUserAuthorized: true,
        expiresAt: reserved.expiresAt,
        operationId: reserved.publicOperationId,
        praxisSessionId: lifecycle.authoringSessionId,
        preparedOperation: {
          protectedOperationId: reserved.protectedOperationId,
          publicOperationId: reserved.publicOperationId,
          contractDigest: reserved.contractDigest,
        },
      },
    );
    expect(authorization.status).toBe("approved");
    await composition.executeAuthorized(principal, lifecycle, reserved.immutableResume);
    await waitForCompleted(database, reserved.protectedOperationId);
    const preparedScope = await bootstrapQ5CanonicalScope(
      new Q5ScopeBootstrapRepository(database, workspaceId),
      facts,
    );
    expect(preparedScope.status).toBe("prepared");
    if (preparedScope.status !== "prepared") throw new Error("expected prepared Q5 scope");
    expect(preparedScope.scope).toMatchObject({
      projectId: empty.projectId,
      environmentId: empty.environmentId,
      issuanceOperationId: reserved.protectedOperationId,
      credentialProvenance: "supported_protected_issuance",
    });
    const pair = await database.query<any>(
      `SELECT value.reference AS "clientIdReference",credential.origin_protected_operation_id::text AS "secretProducer",
              operation.persisted_references AS "references",environment.secret_refs AS "secretRefs",
              scope.client_id_public_value_id::text AS "clientIdValueId",
              scope.client_secret_reference_id::text AS "clientSecretReferenceId"
         FROM q5_prepared_scopes scope
         JOIN generated_public_values value ON value.id=scope.client_id_public_value_id
         JOIN project_credentials credential ON credential.id=scope.client_secret_reference_id
         JOIN protected_operations operation ON operation.id=scope.issuance_operation_id
         JOIN environments environment ON environment.id=scope.environment_id`,
    );
    expect(pair.rows[0]).toMatchObject({
      clientIdReference: "clientId",
      secretProducer: reserved.protectedOperationId,
      references: {
        credentialRecordId: expect.objectContaining({ classification: "public" }),
        clientId: expect.objectContaining({ classification: "public" }),
        clientSecret: expect.objectContaining({ classification: "protected" }),
      },
    });
    expect(new Set(pair.rows[0].secretRefs)).toEqual(new Set([email.id, password.id]));
    expect(pair.rows[0].secretRefs).not.toContain(pair.rows[0].clientIdValueId);
    expect(pair.rows[0].secretRefs).not.toContain(pair.rows[0].clientSecretReferenceId);
  }, 30_000);
});

async function executeDeterministicIssuance(input: {
  database: Database;
  protectedOperations: ProtectedOperationRepository;
  outputs: ProtectedOutputPersistenceRepository;
  sessionId: string;
  operationId: string;
}) {
  const row = (
    await input.database.query<any>(
      `SELECT id::text,project_id::text AS "projectId",environment_id::text AS "environmentId",
              mission_id::text AS "missionId",objective_id::text AS "objectiveId",
              agent_session_id::text AS "agentSessionId",flow_draft_id::text AS "flowDraftId",
              authorization_id::text AS "authorizationId",program_digest AS "programDigest",
              mutation_identity AS "mutationIdentity",dispatch_semantics AS "dispatchSemantics",
              safe_output_manifest AS "safeOutputManifest"
         FROM protected_operations WHERE authoring_session_id=$1 AND operation_id=$2`,
      [input.sessionId, input.operationId],
    )
  ).rows[0];
  const leaseOwner = `deterministic-vitract-${randomUUID()}`;
  let state = await input.protectedOperations.claim({
    ownerKind: "authoring_session",
    ownerId: input.sessionId,
    operationId: input.operationId,
    leaseOwner,
    leaseDurationMs: 120_000,
    binding: {
      projectId: row.projectId,
      environmentId: row.environmentId,
      missionId: row.missionId,
      objectiveId: row.objectiveId,
      agentSessionId: row.agentSessionId,
      flowDraftId: row.flowDraftId,
      authorizationId: row.authorizationId,
      mutationIdentity: row.mutationIdentity,
      dispatchSemantics: row.dispatchSemantics,
      programDigest: row.programDigest,
      safeOutputManifest: row.safeOutputManifest,
    },
  });
  for (const [next, phase] of [
    ["preparing", "preparing"],
    ["ready_to_dispatch", "ready_to_dispatch"],
    ["dispatching", "dispatching"],
    ["dispatched", "dispatched"],
    ["acquiring", "acquiring"],
    ["persisting", "persisting"],
  ] as const) {
    state = await input.protectedOperations.transition({
      id: row.id,
      leaseOwner,
      fencingToken: state.fencingToken,
      version: state.version,
      expected: state.state,
      next,
      phase,
    });
    if (next === "dispatched")
      state = await input.protectedOperations.settleMutationOutcome({
        id: row.id,
        leaseOwner,
        fencingToken: state.fencingToken,
        version: state.version,
        outcome: "applied",
      });
  }
  const persisted = await input.outputs.persistOutputsAtomically(
    {
      protectedOperationId: row.id,
      projectId: row.projectId,
      environmentId: row.environmentId,
      missionId: row.missionId,
      objectiveId: row.objectiveId,
      agentSessionId: row.agentSessionId,
      ownerKind: "authoring_session",
      ownerId: input.sessionId,
      operationId: input.operationId,
      leaseOwner,
      fencingToken: state.fencingToken,
      version: state.version,
    },
    [
      { reference: "credentialRecordId", classification: "public", storageName: "Vitract credential record", value: `record-${randomUUID()}`, scope: "project" },
      { reference: "clientId", classification: "public", storageName: "Vitract client ID", value: `client-${randomUUID()}`, scope: "project" },
      { reference: "clientSecret", classification: "protected", storageName: "Vitract client secret", value: `secret-${randomUUID()}`, scope: "project" },
    ],
    [{
      status: "active",
      provider: "vitract",
      resourceKind: "credential_record",
      resourceScope: "vtr_app_deterministic",
      identityContractVersion: 1,
      requiredForDestructiveLifecycle: true,
      identityReference: "credentialRecordId",
      identitySource: "response",
    }],
  );
  const reconciling = await input.protectedOperations.transition({
    id: row.id,
    leaseOwner,
    fencingToken: persisted.claim.fencingToken,
    version: persisted.claim.version,
    expected: "persisted",
    next: "reconciling",
    phase: "reconciling",
  });
  await input.protectedOperations.transition({
    id: row.id,
    leaseOwner,
    fencingToken: reconciling.fencingToken,
    version: reconciling.version,
    expected: "reconciling",
    next: "completed",
    phase: "completed",
  });
}

function observation(sessionId: string): any {
  const url = "https://preview.vitract.com/partner/developer/applications/vtr_app_deterministic/credentials";
  return {
    sessionId,
    documentEpoch: 0,
    url,
    semanticPageContext: {
      schemaVersion: 2,
      authority: { pageId: "vitract-c2", documentEpoch: 0, url, title: "Credentials", readiness: "stable" },
      completeness: { kind: "bounded", observed: 2, returned: 2, truncated: false },
      controls: [
        { reference: `context-control-${"1".repeat(32)}`, role: "button", name: "Add credential", group: "form", capabilities: ["activate"] },
        { reference: `context-control-${"2".repeat(32)}`, role: "textbox", name: "Name", group: "form", capabilities: ["enter_text"] },
      ],
      readableValues: [],
    },
  };
}

async function waitForCompleted(database: Database, id: string) {
  for (let poll = 0; poll < 100; poll += 1) {
    const result = await database.query<{ state: string }>(
      `SELECT state FROM protected_operations WHERE id=$1`,
      [id],
    );
    if (result.rows[0]?.state === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("DETERMINISTIC_ISSUANCE_DID_NOT_SETTLE");
}
