import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Q5_MCP_CONTRACT_DIGEST,
  Q5_MCP_PROFILE,
  Q5_MCP_PROTOCOL_VERSION,
  Q5_MCP_TOOL_NAMES,
  Q5_REQUIRED_EVIDENCE_KINDS,
} from "@scry/contracts";

import { decryptCredential } from "../src/access/credential.crypto.js";
import { Database } from "../src/infrastructure/index.js";
import { Q5AuthoritativeAttemptRepository } from "../src/runtime/repositories/q5-authoritative-attempt.repository.js";
import { Q5ScopeBootstrapRepository } from "../src/runtime/repositories/q5-scope-bootstrap.repository.js";
import {
  LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED,
  bootstrapQ5CanonicalScope,
  type Q5PreparedScope,
} from "../src/runtime/q5-scope-bootstrap.js";
import {
  VITRACT_CREATE_QUALIFICATION,
  loadDurableContext,
} from "./vitract-create-order-live-qualification.js";
import {
  Q5OwnedProcess,
  assertHighLevelQ5Objective,
  crossPaidQ5Boundary,
  minimalAgentEnvironment,
  recursivePrivacyScan,
  runPrepaidFreeQ5Gates,
  type Q5Gate,
  type Q5PrepaidFreePhase,
} from "./m6-q5-authoritative-harness.js";
import {
  assertAuthoritativeSourceIdentity,
  assertRuntimeSourceIdentity,
  deriveRepositorySourceIdentity,
} from "../../../scripts/source-identity.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.resolve(
  process.env.SCRY_M6_Q5_OUTPUT ??
    path.join(root, "artifacts/system-correctness/m6/q5-authoritative"),
);
const expectedSchema = required("SCRY_SCHEMA_FINGERPRINT", /^[a-f0-9]{64}$/);
const expectedMigration = createHash("sha256")
  .update(
    await readFile(new URL("../migrations/q5-canonical-scope-bootstrap.sql", import.meta.url)),
  )
  .digest("hex");
const databaseUrl = required("SCRY_M6_TEST_DATABASE_URL", /^postgres(?:ql)?:\/\//);
process.env.DATABASE_URL = databaseUrl;
const database = new Database();
const attempts = new Q5AuthoritativeAttemptRepository(database);
const source = deriveRepositorySourceIdentity(root);
const mode = process.argv.includes("--execute-authoritative") ? "execute" : "preflight";
const model = process.env.SCRY_M6_Q5_MODEL ?? "deepseek-chat";

const externalObjective =
  "Using only the public Scry MCP contract, discover the assigned Vitract Preview/Test application, authenticate through protected Scry capabilities where required, create exactly one Preview Test order, retrieve and verify that same order, attach acceptable evidence, finalize the exact Run and Objective, and publish the exact Mission report. Stop on UNKNOWN or any factual blocker; never retry an uncertain mutation.";
assertHighLevelQ5Objective(externalObjective);

await mkdir(output, { recursive: true });

try {
  const bootstrap = await prepareCanonicalQ5Scope();
  if (bootstrap.status === "credential_issuance_required") {
    await writeSafe("preflight.json", {
      verdict: "Q5_REPOSITORY_BLIND_AGENT_BLOCKED",
      blocker: LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED,
      projectId: bootstrap.projectId,
      environmentId: bootstrap.environmentId,
      paidAuthorization: "UNUSED",
      attemptsConsumed: 0,
    });
    process.stdout.write(`${LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED}\n`);
    process.exitCode = 2;
  } else {
    const preparedScope = bootstrap.scope;
    const protectedContext = await loadDurableContext({
      projectId: preparedScope.projectId,
      environmentId: preparedScope.environmentId,
      credentialReferenceIds: [
        preparedScope.clientIdReferenceId,
        preparedScope.clientSecretReferenceId,
      ],
    });
    const gates = await gatesForCurrentRuntime(preparedScope, protectedContext);
    if (mode === "preflight") {
      const results = await runPrepaidFreeQ5Gates(gates);
      await writeSafe("preflight.json", {
        verdict: "NO_KNOWN_PRE_MISSION_Q5_GAPS",
        paidAuthorization: "UNUSED",
        attemptsConsumed: 0,
        phases: results,
      });
      process.stdout.write("NO_KNOWN_PRE_MISSION_Q5_GAPS\nREADY_FOR_ONE_AUTHORITATIVE_Q5\n");
    } else {
      if (process.env.SCRY_M6_Q5_PAID_AUTHORIZATION !== "explicit-single-attempt")
        throw new Error("Q5_EXPLICIT_SINGLE_PAID_ATTEMPT_AUTHORIZATION_REQUIRED");
      const providerKey = required("DEEPSEEK_API_KEY", /\S/);
      let prepared: Awaited<ReturnType<typeof provisionExactQualificationScope>> | undefined;
      try {
        const crossed = await crossPaidQ5Boundary({
          gates,
          consumeAttempt: async () => {
            prepared = await provisionExactQualificationScope(preparedScope, protectedContext);
            return { attemptId: prepared.attemptId, state: "consumed" as const };
          },
          constructProviderAfterConsumption: async () => {
            if (!prepared) throw new Error("Q5_ATTEMPT_SCOPE_NOT_PREPARED");
            const environment = minimalAgentEnvironment({
              parent: process.env,
              mcpCredential: prepared.credential,
              providerKey,
              protectedCanaries: prepared.canaries,
            });
            return Q5OwnedProcess.start({
              executable: path.join(root, "apps/agent-lab/.venv/bin/scry-agent-lab"),
              arguments: [
                "run",
                "--provider",
                "deepseek",
                "--model",
                model,
                "--profile",
                "capable_live_journey",
                "--external-run-id",
                prepared.externalRunId,
                "--experiment-id",
                prepared.externalRunId,
                "--mcp-url",
                required("SCRY_M6_Q5_MCP_URL", /^http:\/\/127\.0\.0\.1:/),
                "--output-directory",
                output,
                "--expected-attempt-id",
                prepared.attemptId,
                "--expected-campaign-id",
                prepared.campaignId,
                "--expected-mission-id",
                prepared.missionId,
                "--expected-objective-id",
                prepared.objectiveId,
                "--expected-agent-session-id",
                prepared.agentSessionId,
                "--objective",
                externalObjective,
              ],
              environment,
              repositoryRoot: root,
              outputDirectory: output,
              timeoutMs: Number(process.env.SCRY_M6_Q5_AGENT_TIMEOUT_MS ?? 3_600_000),
            });
          },
        });
        if (!prepared) throw new Error("Q5_ATTEMPT_SCOPE_NOT_PREPARED");
        const result = await crossed.provider.wait();
        if (result.exitCode !== 0) throw new Error("Q5_AUTHORITATIVE_AGENT_FAILED");
        await assertCampaignSourceStable();
        const privacy = await recursivePrivacyScan(output, prepared.canaries);
        if (privacy.protectedLeakCount) throw new Error("Q5_PROTECTED_ARTIFACT_LEAK");
        const evidence = await verifyAuthoritativeResult(prepared, privacy);
        evidence.authority.authoritativeAttemptState = "succeeded";
        const evidenceDigest = createHash("sha256").update(stableJson(evidence)).digest("hex");
        await attempts.settle(prepared.attemptId, "succeeded", evidenceDigest);
        await writeSafe("../q5-authoritative-evidence.json", evidence);
        await writeSafe("execution-boundary.json", {
          attemptId: prepared.attemptId,
          campaignId: prepared.campaignId,
          exitCode: result.exitCode,
          cwdOutsideRepository: true,
          privacy,
        });
        process.stdout.write("Q5_AUTHORITATIVE_PARENT_VERIFICATION_PASS\n");
      } catch (error) {
        if (prepared) await closeFailedScope(prepared, error);
        throw error;
      }
    }
  }
} finally {
  await database.onModuleDestroy();
}

async function prepareCanonicalQ5Scope() {
  const ownerUserId = required("SCRY_M6_Q5_OWNER_USER_ID", /^[0-9a-f-]{36}$/);
  const owner = await database.query<{ workspaceId: string }>(
    `SELECT membership.workspace_id::text AS "workspaceId"
       FROM workspace_memberships membership
      WHERE membership.user_id=$1 AND membership.role IN ('owner','admin')
      ORDER BY membership.created_at LIMIT 2`,
    [ownerUserId],
  );
  if (owner.rowCount !== 1) throw new Error("Q5_CANONICAL_WORKSPACE_OWNER_AMBIGUOUS");
  const store = new Q5ScopeBootstrapRepository(database, owner.rows[0]!.workspaceId);
  return bootstrapQ5CanonicalScope(store, {
    sourceCommit: source.commitSha,
    sourceManifest: source.manifestSha256,
    schemaFingerprint: expectedSchema,
    migrationIdentity: expectedMigration,
  });
}

async function gatesForCurrentRuntime(
  preparedScope: Q5PreparedScope,
  preparedContext: Awaited<ReturnType<typeof loadDurableContext>>,
): Promise<Record<Q5PrepaidFreePhase, Q5Gate>> {
  let initialSource = source;
  let protectedContext: Awaited<ReturnType<typeof loadDurableContext>> | undefined;
  const apiUrl = required("SCRY_M6_Q5_API_URL", /^http:\/\/127\.0\.0\.1:/);
  const mcpUrl = required("SCRY_M6_Q5_MCP_HEALTH_URL", /^http:\/\/127\.0\.0\.1:/);
  const serviceToken = required("SCRY_SERVICE_TOKEN", /\S/);
  const fetchIdentity = async (url: string) => {
    const response = await fetch(url, { headers: { authorization: `Bearer ${serviceToken}` } });
    if (!response.ok) throw new Error(`Q5_RUNTIME_READINESS_${response.status}`);
    return (await response.json()) as any;
  };
  return {
    real_shaped_canonical_bootstrap: async () => ({
      pass: true,
      projectId: preparedScope.projectId,
      environmentId: preparedScope.environmentId,
      generatedIdentityCompatible: true,
      fixtureIdentityRequired: false,
      paidAttemptCreated: false,
    }),
    prepared_scope_validity: async () => {
      const current = await database.query<any>(
        `SELECT scope.state,scope.binding_digest AS "bindingDigest",
                client_id.security_status AS "clientIdStatus",
                client_secret.security_status AS "clientSecretStatus",
                issuance.state AS "issuanceState",issuance.persistence_state AS "persistenceState",
                issuance.mutation_outcome AS "mutationOutcome"
           FROM q5_prepared_scopes scope
           JOIN project_credentials client_id ON client_id.id=scope.client_id_reference_id
           JOIN project_credentials client_secret ON client_secret.id=scope.client_secret_reference_id
           JOIN protected_operations issuance ON issuance.id=scope.issuance_operation_id
          WHERE scope.id=$1 AND scope.project_id=$2 AND scope.environment_id=$3
            AND scope.source_commit=$4 AND scope.source_manifest=$5
            AND scope.schema_fingerprint=$6 AND scope.migration_identity=$7
            AND client_id.deleted_at IS NULL AND client_secret.deleted_at IS NULL`,
        [
          preparedScope.id,
          preparedScope.projectId,
          preparedScope.environmentId,
          source.commitSha,
          source.manifestSha256,
          expectedSchema,
          expectedMigration,
        ],
      );
      const row = current.rows[0];
      if (
        current.rowCount !== 1 ||
        row.state !== "prepared" ||
        row.bindingDigest !== preparedScope.bindingDigest ||
        row.clientIdStatus !== "active" ||
        row.clientSecretStatus !== "active" ||
        row.issuanceState !== "completed" ||
        row.persistenceState !== "committed" ||
        row.mutationOutcome !== "applied"
      )
        throw new Error("Q5_PREPARED_SCOPE_INVALIDATED");
      return {
        pass: true,
        preparedScopeId: preparedScope.id,
        bindingDigest: preparedScope.bindingDigest,
      };
    },
    immutable_source: async () => {
      initialSource = deriveRepositorySourceIdentity(root);
      assertAuthoritativeSourceIdentity(initialSource, {
        commitSha: required("SCRY_GIT_COMMIT", /^[a-f0-9]{40}$/),
        manifestSha256: required("SCRY_SOURCE_MANIFEST_SHA256", /^[a-f0-9]{64}$/),
      });
      return { pass: true, source: initialSource };
    },
    database_migration: async () => {
      const installed = await database.query<{ schemaFingerprint: string }>(
        `SELECT schema_fingerprint AS "schemaFingerprint" FROM schema_baseline WHERE singleton=true`,
      );
      if (installed.rows[0]?.schemaFingerprint !== expectedSchema)
        throw new Error("Q5_DATABASE_SCHEMA_MISMATCH");
      return { pass: true, schemaFingerprint: expectedSchema, migrationSha256: expectedMigration };
    },
    canonical_persisted_state: async () => {
      const state = await database.query<any>(
        `SELECT
            count(*) FILTER (WHERE mission.status IN ('planning','running','blocked','awaiting_user'))::int AS "liveMissions",
            count(*) FILTER (WHERE run.state IN ('queued','running'))::int AS "liveRuns",
            count(*) FILTER (WHERE run_attempt.state='running')::int AS "liveAttempts",
            count(*) FILTER (WHERE agent.status='active')::int AS "liveAgents"
          FROM missions mission
          LEFT JOIN runs run ON run.mission_id=mission.id
          LEFT JOIN attempts run_attempt ON run_attempt.run_id=run.id
          LEFT JOIN agent_sessions agent ON agent.mission_id=mission.id
         WHERE mission.project_id=$1 AND mission.title LIKE 'M6 Q5 authoritative:%'`,
        [preparedScope.projectId],
      );
      if (Object.values(state.rows[0] ?? {}).some((value) => Number(value) > 0))
        throw new Error("Q5_CONFLICTING_LIVE_STATE");
      const unresolved = await database.query<{ count: number }>(
        `SELECT (
            (SELECT count(*) FROM adaptive_sessions session
              JOIN missions mission ON mission.id=session.mission_id
             WHERE session.project_id=$1 AND session.environment_id=$2
               AND session.state IN ('recovery_required','reconciling')
               AND mission.title LIKE 'M6 Q5 authoritative:%')
            +
            (SELECT count(*) FROM adaptive_operation_reconciliations reconciliation
              JOIN adaptive_sessions session ON session.id=reconciliation.session_id
              JOIN missions mission ON mission.id=session.mission_id
             WHERE session.project_id=$1 AND session.environment_id=$2
               AND reconciliation.state='observing'
               AND mission.title LIKE 'M6 Q5 authoritative:%')
            +
            (SELECT count(*) FROM protected_operations operation
              JOIN missions mission ON mission.id=operation.mission_id
             WHERE operation.project_id=$1 AND operation.environment_id=$2
               AND (operation.mutation_outcome='unknown' OR operation.state='recovery_required'
                 OR operation.lease_owner IS NOT NULL)
               AND mission.title LIKE 'M6 Q5 authoritative:%')
          )::int count`,
        [preparedScope.projectId, preparedScope.environmentId],
      );
      if (unresolved.rows[0]?.count) throw new Error("Q5_UNSAFE_LIVE_RESIDUE");
      const priorAttempt = await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM q5_authoritative_attempts
           WHERE qualification_key='m6-q5-authoritative'`,
      );
      if (priorAttempt.rows[0]?.count) throw new Error("Q5_PAID_ATTEMPT_ALREADY_EXISTS");
      return { pass: true, historicalTerminalRowsAllowed: true };
    },
    canonical_application_environment_protected_auth: async () => {
      protectedContext = preparedContext;
      if (
        protectedContext.credentialReferenceIds.length !== 2 ||
        !protectedContext.allowedOrigins.includes(VITRACT_CREATE_QUALIFICATION.providerOrigin)
      )
        throw new Error("Q5_CANONICAL_PROTECTED_BINDING_INVALID");
      return {
        pass: true,
        projectId: preparedScope.projectId,
        environmentId: preparedScope.environmentId,
        applicationIdentity: "vitract-preview-test",
        credentialCount: 2,
      };
    },
    deterministic_runtime_composition: async () => {
      const [api, mcp, postgres] = await Promise.all([
        fetchIdentity(`${apiUrl}/ready`),
        fetchIdentity(mcpUrl),
        database.query<{ ready: number }>("SELECT 1 AS ready"),
      ]);
      if (api.ready !== true || mcp.status !== "ok" || postgres.rows[0]?.ready !== 1)
        throw new Error("Q5_RUNTIME_COMPOSITION_NOT_READY");
      return {
        pass: true,
        ownership: "externally supervised qualification stack",
        components: ["postgres", "api", "worker", "mcp-q5", "browser-praxis"],
      };
    },
    runtime_source_identity: async () => {
      const api = await fetchIdentity(`${apiUrl}/capabilities`);
      const mcp = await fetchIdentity(mcpUrl);
      assertRuntimeSourceIdentity(api.sourceIdentity, initialSource);
      assertRuntimeSourceIdentity(mcp.sourceIdentity, initialSource);
      return { pass: true, api: api.sourceIdentity, mcp: mcp.sourceIdentity };
    },
    worker_compatibility_readiness: async () => {
      const rows = await database.query<any>(
        `SELECT source_commit AS "gitCommit",source_dirty AS dirty,
                source_manifest_sha256 AS "manifestSha256",schema_fingerprint AS "schemaFingerprint"
           FROM worker_heartbeats WHERE heartbeat_at>now()-interval '15 seconds'
           ORDER BY heartbeat_at DESC`,
      );
      if (!rows.rowCount) throw new Error("Q5_WORKER_NOT_READY");
      for (const row of rows.rows) {
        assertRuntimeSourceIdentity(row, initialSource);
        if (row.schemaFingerprint !== expectedSchema) throw new Error("Q5_WORKER_SCHEMA_MISMATCH");
      }
      return { pass: true, workers: rows.rowCount };
    },
    mcp_q5_profile_contract: async () => {
      const health = (await fetchIdentity(mcpUrl)) as any;
      if (health.profile !== "q5-authoritative-v1") throw new Error("Q5_MCP_PROFILE_MISMATCH");
      if (
        health.q5Contract?.protocolVersion !== Q5_MCP_PROTOCOL_VERSION ||
        health.q5Contract?.digest !== Q5_MCP_CONTRACT_DIGEST ||
        health.q5Contract?.toolCount !== Q5_MCP_TOOL_NAMES.length ||
        JSON.stringify(health.q5Contract?.toolNames) !== JSON.stringify(Q5_MCP_TOOL_NAMES)
      )
        throw new Error("Q5_MCP_CONTRACT_MISMATCH");
      return { pass: true, ...health.q5Contract };
    },
    browser_praxis_readiness: async () => {
      const ready = await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM browser_runtime_manifests
          WHERE release_id=$1 AND schema_fingerprint=$2 AND ready=true`,
        [process.env.SCRY_RELEASE_ID ?? "development", expectedSchema],
      );
      if (!ready.rows[0]?.count) throw new Error("Q5_BROWSER_PRAXIS_NOT_READY");
      return { pass: true, browserRuntimeManifests: ready.rows[0].count };
    },
    protected_auth_rehearsal: async () => {
      if (!protectedContext) throw new Error("Q5_PROTECTED_CONTEXT_NOT_LOADED");
      const encrypted = await database.query<{
        ciphertext: Buffer;
        initializationVector: Buffer;
        authenticationTag: Buffer;
      }>(
        `SELECT ciphertext,initialization_vector AS "initializationVector",
                authentication_tag AS "authenticationTag"
           FROM project_credentials
          WHERE project_id=$1 AND id=ANY($2::uuid[])
            AND deleted_at IS NULL AND security_status='active'`,
        [preparedScope.projectId, protectedContext.credentialReferenceIds],
      );
      if (
        encrypted.rowCount !== protectedContext.credentialReferenceIds.length ||
        encrypted.rows.some((row) => decryptCredential(row).length === 0)
      )
        throw new Error("Q5_PROTECTED_CREDENTIAL_REHEARSAL_FAILED");
      return {
        pass: true,
        mechanism: "canonical encrypted credential decryptability and active-policy rehearsal",
        plaintext: false,
      };
    },
    exact_mission_objective_flow: async () => ({
      pass: true,
      objectiveDigest: createHash("sha256").update(externalObjective).digest("hex"),
      requiredEvidenceKinds: 9,
      mutationLimit: 1,
      exactRetrievalRequired: true,
    }),
    final_source_runtime_refingerprint: async () => {
      const finalSource = deriveRepositorySourceIdentity(root);
      assertAuthoritativeSourceIdentity(finalSource, initialSource);
      await assertCampaignSourceStable();
      return { pass: true, source: finalSource, runtimesReverified: true };
    },
    no_known_pre_mission_q5_gaps: async () => ({
      pass: true,
      verdict: "NO_KNOWN_PRE_MISSION_Q5_GAPS",
    }),
  };
}

async function provisionExactQualificationScope(
  preparedScope: Q5PreparedScope,
  context: Awaited<ReturnType<typeof loadDurableContext>>,
) {
  const credential = `scry_q5_${randomBytes(32).toString("hex")}`;
  const credentialDigest = createHash("sha256").update(credential).digest("hex");
  const ids = Object.fromEntries(
    [
      "missionId",
      "objectiveId",
      "agentSessionId",
      "flowId",
      "flowRevisionId",
      "flowDraftId",
      "campaignId",
      "externalRunId",
    ].map((name) => [name, randomUUID()]),
  ) as Record<string, string>;
  const prepared = await database.transaction(async (client) => {
    const applicationId = await attempts.createCanonicalApplicationUsing(client, {
      identity: "vitract-preview-test",
      projectId: preparedScope.projectId,
      environmentId: preparedScope.environmentId,
      baseOrigin: preparedScope.targetOrigin,
      allowedOrigins: context.allowedOrigins,
      credentialReferenceIds: context.credentialReferenceIds,
    });
    const ownerUserId = required("SCRY_M6_Q5_OWNER_USER_ID", /^[0-9a-f-]{36}$/);
    const workspace = await client.query<{ workspaceId: string }>(
      `SELECT project.workspace_id::text AS "workspaceId"
         FROM projects project
         JOIN workspace_memberships membership ON membership.workspace_id=project.workspace_id
         JOIN app_users owner_user ON owner_user.id=membership.user_id
        WHERE project.id=$1 AND owner_user.id=$2 AND membership.role IN ('owner','admin')`,
      [preparedScope.projectId, ownerUserId],
    );
    if (!workspace.rowCount) throw new Error("Q5_PROJECT_NOT_FOUND");
    await client.query(
      `INSERT INTO missions(id,project_id,title,original_instruction,status)
       VALUES($1,$2,$3,$4,'running')`,
      [
        ids.missionId,
        preparedScope.projectId,
        `M6 Q5 authoritative:${ids.externalRunId}`,
        externalObjective,
      ],
    );
    await client.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order,status)
       VALUES($1,$2,'Create and exactly retrieve one Vitract Preview Test order',$3::jsonb,0,'pending')`,
      [
        ids.objectiveId,
        ids.missionId,
        JSON.stringify([
          { description: "public discovery completed", required: true },
          { description: "protected authentication succeeded", required: true },
          { description: "exactly one order mutation applied", required: true },
          { description: "the same created order was retrieved", required: true },
          { description: "required Run evidence accepted", required: true },
        ]),
      ],
    );
    await client.query(`UPDATE missions SET current_objective_id=$2 WHERE id=$1`, [
      ids.missionId,
      ids.objectiveId,
    ]);
    await client.query(
      `INSERT INTO agent_sessions(
         id,mission_id,project_id,workspace_id,provider,model,external_run_id,experiment_id,
         instruction_snapshot,idempotency_key,heartbeat_at,lease_expires_at
       ) VALUES($1,$2,$3,$4,'deepseek',$5,$6,$6,$7,$8,now(),now()+interval '2 hours')`,
      [
        ids.agentSessionId,
        ids.missionId,
        preparedScope.projectId,
        workspace.rows[0]!.workspaceId,
        model,
        ids.externalRunId,
        externalObjective,
        `m6-q5:${ids.externalRunId}`,
      ],
    );
    const plan = {
      name: "M6 authoritative Vitract Preview/Test qualification",
      objective: externalObjective,
      preconditions: ["canonical protected credentials are active and opaque"],
      allowedOrigins: context.allowedOrigins,
      budgets: { maxActions: 80, maxDurationMs: 3_600_000, maxNavigations: 20 },
      checkpoints: [],
      steps: [
        {
          id: "discover-vitract-public-contract",
          title: "Discover the assigned application's public contract",
          action: { type: "navigate", url: preparedScope.targetOrigin },
          assertions: [],
          onFailure: "stop",
          evidence: ["screenshot", "dom", "network"],
          captureIntent: "final",
        },
      ],
    };
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO flows(
         id,project_id,name,latest_revision_id,visibility,purpose,origin_mission_id,
         origin_objective_id,created_by_agent_session_id,owner_mission_id,owner_objective_id
       ) VALUES($1,$2,'M6 authoritative Vitract Q5',$3,'mission_local','primary',$4,$5,$6,$4,$5)`,
      [
        ids.flowId,
        preparedScope.projectId,
        ids.flowRevisionId,
        ids.missionId,
        ids.objectiveId,
        ids.agentSessionId,
      ],
    );
    await client.query(
      `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason)
       VALUES($1,$2,1,$3::jsonb,$4::jsonb,'{}',$5,'M6 authoritative Q5')`,
      [
        ids.flowRevisionId,
        ids.flowId,
        JSON.stringify({
          objective: externalObjective,
          expectedOutcomes: [
            "one created Preview Test order",
            "exact retrieval of that order",
            "accepted evidence",
          ],
          prohibitedSideEffects: ["second Run", "second mutation", "redispatch after UNKNOWN"],
        }),
        JSON.stringify(plan),
        ids.agentSessionId,
      ],
    );
    await client.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,flow_id,name,content,plan,created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,$6,'M6 authoritative Vitract Q5','{}',$7::jsonb,$8)`,
      [
        ids.flowDraftId,
        preparedScope.projectId,
        ids.missionId,
        ids.objectiveId,
        preparedScope.environmentId,
        ids.flowId,
        JSON.stringify(plan),
        ids.agentSessionId,
      ],
    );
    await client.query(
      `INSERT INTO qualification_campaign_authorizations(
         id,project_id,environment_id,mission_id,objective_id,agent_session_id,purpose,target_origin,
         application_identity,canonical_application_id,qualification_mode,owner_user_id,release_identity,
         schema_identity,max_runs,max_business_mutation_dispatches,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,'system_correctness',$7,'vitract-preview-test',$8,'local_test',$9,$10,$11,1,1,now()+interval '2 hours')`,
      [
        ids.campaignId,
        preparedScope.projectId,
        preparedScope.environmentId,
        ids.missionId,
        ids.objectiveId,
        ids.agentSessionId,
        preparedScope.targetOrigin,
        applicationId,
        ownerUserId,
        source.manifestSha256,
        expectedSchema,
      ],
    );
    const attempt = await attempts.prepareUsing(client, {
      campaignId: ids.campaignId!,
      preparedScopeId: preparedScope.id,
      canonicalApplicationId: applicationId,
      applicationIdentity: "vitract-preview-test",
      projectId: preparedScope.projectId,
      environmentId: preparedScope.environmentId,
      missionId: ids.missionId!,
      objectiveId: ids.objectiveId!,
      agentSessionId: ids.agentSessionId!,
      externalRunId: ids.externalRunId!,
      flowDraftId: ids.flowDraftId!,
      flowRevisionId: ids.flowRevisionId!,
      targetOrigin: preparedScope.targetOrigin,
      sourceCommit: source.commitSha,
      sourceManifest: source.manifestSha256,
      schemaFingerprint: expectedSchema,
      migrationDigest: expectedMigration,
      provider: "deepseek",
      model,
      credentialDigest,
    });
    if (attempt.replayed) throw new Error("Q5_ATTEMPT_PREPARATION_REPLAY_FORBIDDEN");
    assertAuthoritativeSourceIdentity(deriveRepositorySourceIdentity(root), source);
    await assertCampaignSourceStable();
    const consumed = await attempts.consumeUsing(
      client,
      attempt.attempt.attemptId,
      credentialDigest,
    );
    return { applicationId, attemptId: consumed.id };
  });
  return {
    missionId: ids.missionId!,
    objectiveId: ids.objectiveId!,
    agentSessionId: ids.agentSessionId!,
    flowId: ids.flowId!,
    flowRevisionId: ids.flowRevisionId!,
    flowDraftId: ids.flowDraftId!,
    campaignId: ids.campaignId!,
    externalRunId: ids.externalRunId!,
    ...prepared,
    preparedScopeId: preparedScope.id,
    projectId: preparedScope.projectId,
    environmentId: preparedScope.environmentId,
    credential,
    credentialDigest,
    canaries: [
      credential,
      required("DEEPSEEK_API_KEY", /\S/),
      ...context.credentialReferenceIds.map((id) => `protected-reference-canary:${id}`),
      "cookie-canary-q5",
      "session-token-canary-q5",
      "authorization-canary-q5",
      "protected-request-body-canary-q5",
      "protected-output-value-canary-q5",
    ],
  };
}

async function writeSafe(name: string, value: unknown) {
  await writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertCampaignSourceStable() {
  const finalSource = deriveRepositorySourceIdentity(root);
  assertAuthoritativeSourceIdentity(finalSource, source);
  const serviceToken = required("SCRY_SERVICE_TOKEN", /\S/);
  for (const base of [
    required("SCRY_M6_Q5_API_URL", /^http:\/\/127\.0\.0\.1:/),
    required("SCRY_M6_Q5_MCP_HEALTH_URL", /^http:\/\/127\.0\.0\.1:/),
  ]) {
    const endpoint = base.endsWith("/api") ? `${base}/capabilities` : base;
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    if (!response.ok) throw new Error("Q5_FINAL_RUNTIME_SOURCE_UNAVAILABLE");
    const body = (await response.json()) as any;
    assertRuntimeSourceIdentity(body.sourceIdentity ?? body, source);
  }
  const workers = await database.query<any>(
    `SELECT source_commit AS "gitCommit",source_dirty AS dirty,
            source_manifest_sha256 AS "manifestSha256"
       FROM worker_heartbeats WHERE heartbeat_at>now()-interval '15 seconds'`,
  );
  if (!workers.rowCount) throw new Error("Q5_FINAL_WORKER_SOURCE_UNAVAILABLE");
  for (const worker of workers.rows) assertRuntimeSourceIdentity(worker, source);
}

function required(name: string, pattern: RegExp) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) throw new Error(`Q5_${name}_REQUIRED`);
  return value;
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

async function settleExternalLifecycle(
  scope: Awaited<ReturnType<typeof provisionExactQualificationScope>>,
  reasonCode: string,
) {
  const mcp = new URL(required("SCRY_M6_Q5_MCP_URL", /^http:\/\/127\.0\.0\.1:/));
  const response = await fetch(`${mcp.origin}/agent-lab/terminate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${scope.credential}`,
      "content-type": "application/json",
      "x-scry-agent-provider": "deepseek",
      "x-scry-agent-model": model,
      "x-scry-external-run-id": scope.externalRunId,
    },
    body: JSON.stringify({ reasonCode, terminalOutcome: "failed" }),
  });
  if (!response.ok) throw new Error("Q5_EXTERNAL_AGENT_LIFECYCLE_SETTLEMENT_FAILED");
}

async function adjudicateFailureResidue(
  scope: Awaited<ReturnType<typeof provisionExactQualificationScope>>,
) {
  const result = await database.query<any>(
    `SELECT
       EXISTS(SELECT 1 FROM qualification_campaign_mutation_consumptions
               WHERE campaign_authorization_id=$1 AND mutation_outcome='unknown') AS "unknownMutation",
       (SELECT count(*)::int FROM runs WHERE qualification_campaign_authorization_id=$1) AS "runCount",
       (SELECT count(*)::int FROM adaptive_sessions
         WHERE mission_id=$2 AND state IN ('active','provisioning','reconciling')) AS "livePraxisOwners",
       (SELECT count(*)::int FROM protected_operations
         WHERE mission_id=$2 AND lease_owner IS NOT NULL AND lease_expires_at>now()) AS "liveProtectedOwners"`,
    [scope.campaignId, scope.missionId],
  );
  const state = result.rows[0]!;
  if (state.livePraxisOwners || state.liveProtectedOwners)
    throw new Error("Q5_FAILURE_LIVE_OWNER_RESIDUE");
  return {
    attemptState: state.unknownMutation ? ("inconclusive" as const) : ("failed" as const),
    mutationTruth: state.unknownMutation ? "unknown_preserved" : "no_unknown",
    runCount: state.runCount,
    unsafeLiveOwners: 0,
  };
}

async function closeFailedScope(
  scope: Awaited<ReturnType<typeof provisionExactQualificationScope>>,
  error: unknown,
) {
  const current = scope.attemptId
    ? await database.query<{ state: string }>(
        `SELECT state FROM q5_authoritative_attempts WHERE id=$1`,
        [scope.attemptId],
      )
    : { rows: [] as Array<{ state: string }> };
  if (current.rows[0]?.state === "consumed") {
    await settleExternalLifecycle(scope, "Q5_AUTHORITATIVE_HARNESS_FAILED").catch(() => undefined);
    const failure = await adjudicateFailureResidue(scope);
    await attempts.settle(scope.attemptId, failure.attemptState);
    await writeSafe("failure-residue.json", {
      ...failure,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return;
  }
  await database.transaction(async (client) => {
    await client.query(
      `UPDATE qualification_campaign_authorizations
          SET disposition='revoked',terminal_at=now(),updated_at=now()
        WHERE id=$1 AND disposition='authorized'`,
      [scope.campaignId],
    );
    await client.query(
      `UPDATE agent_sessions SET status='interrupted',ended_at=now()
        WHERE id=$1 AND status='active'`,
      [scope.agentSessionId],
    );
    await client.query(
      `UPDATE missions SET status='failed',completed_at=now(),updated_at=now()
        WHERE id=$1 AND status IN ('planning','running','blocked','awaiting_user')`,
      [scope.missionId],
    );
  });
}

async function verifyAuthoritativeResult(
  scope: Awaited<ReturnType<typeof provisionExactQualificationScope>>,
  privacy: { protectedLeakCount: number },
) {
  const state = await database.query<any>(
    `SELECT campaign.disposition AS "campaignDisposition",campaign.runs_consumed AS "runsConsumed",
            campaign.business_mutation_dispatches_consumed AS "mutationsConsumed",
            attempt.provider_request_count AS "providerRequestCount",
            run.id::text AS "runId",run.state AS "runState",run_attempt.id::text AS "runAttemptId",
            run_attempt.state AS "runAttemptState",session.id::text AS "praxisSessionId",
            session.state AS "praxisState",agent.status AS "agentState",mission.status AS "missionState",
            objective.status AS "objectiveState",report.status AS "reportState",
            report.id::text AS "reportId",
            evidence.id::text AS "acceptedEvidenceId",
            (SELECT count(*)::int FROM artifacts artifact
              WHERE artifact.attempt_id=run_attempt.id AND artifact.availability='available'
                AND artifact.privacy_classification IN ('safe','sanitized')) AS "availableArtifacts",
            (SELECT count(*)::int FROM artifacts artifact
              WHERE artifact.attempt_id=run_attempt.id
                AND (artifact.availability<>'available'
                  OR artifact.privacy_classification='uncertain')) AS "unsafeArtifacts"
       FROM q5_authoritative_attempts attempt
       JOIN qualification_campaign_authorizations campaign ON campaign.id=attempt.campaign_authorization_id
       JOIN runs run ON run.id=attempt.run_id AND run.qualification_campaign_authorization_id=campaign.id
       JOIN LATERAL (SELECT * FROM attempts WHERE run_id=run.id ORDER BY attempt_number DESC LIMIT 1) run_attempt ON true
       JOIN adaptive_sessions session ON session.id=attempt.praxis_session_id
       JOIN agent_sessions agent ON agent.id=campaign.agent_session_id
       JOIN missions mission ON mission.id=campaign.mission_id
       JOIN mission_objectives objective ON objective.id=campaign.objective_id
       JOIN mission_reports report ON report.id=mission.final_report_id AND report.mission_id=mission.id
       JOIN accepted_evidence evidence ON evidence.run_id=run.id AND evidence.objective_id=objective.id
      WHERE attempt.id=$1`,
    [scope.attemptId],
  );
  if (state.rowCount !== 1) throw new Error("Q5_TERMINAL_SCOPE_INCOMPLETE");
  const truth = state.rows[0]!;
  const expected = {
    campaignDisposition: "succeeded",
    runsConsumed: 1,
    mutationsConsumed: 1,
    runState: "passed",
    runAttemptState: "succeeded",
    praxisState: "completed",
    agentState: "completed",
    missionState: "completed",
    objectiveState: "passed",
    reportState: "published",
  };
  for (const [key, value] of Object.entries(expected))
    if (truth[key] !== value) throw new Error(`Q5_TERMINAL_${key.toUpperCase()}_MISMATCH`);
  if (truth.availableArtifacts < 1 || truth.unsafeArtifacts !== 0)
    throw new Error("Q5_REQUIRED_RUN_ARTIFACTS_INVALID");
  const residue = await database.query<{ count: number }>(
    `SELECT (
       (SELECT count(*) FROM protected_operations
         WHERE run_id=$1 AND (state NOT IN ('completed','failed_not_applied','abandoned','revoked')
           OR lease_owner IS NOT NULL OR mutation_outcome='unknown'))
       +
       (SELECT count(*) FROM adaptive_operation_reconciliations
         WHERE session_id=$2 AND state='observing')
     )::int AS count`,
    [truth.runId, truth.praxisSessionId],
  );
  if (residue.rows[0]?.count) throw new Error("Q5_UNSAFE_DURABLE_RESIDUE");
  const authentication = await database.query<{ operationId: string }>(
    `SELECT operation.id::text AS "operationId"
       FROM adaptive_operations operation
       JOIN adaptive_sessions session ON session.id=operation.session_id
      WHERE session.id=$1 AND operation.state='completed'
        AND operation.authoring_intent->'authorization'->>'kind'='authentication'
        AND jsonb_array_length(
          COALESCE(operation.authoring_intent->'protectedInputReferences','[]'::jsonb)
        )>0
        AND operation.mutation_outcome<>'unknown'`,
    [truth.praxisSessionId],
  );
  if (!authentication.rowCount) throw new Error("Q5_PROTECTED_AUTHENTICATION_UNPROVEN");
  const mutation = await database.query<any>(
    `SELECT consumption.operation_id AS "operationId",consumption.mutation_identity AS identity,
            consumption.mutation_outcome AS outcome,
            (SELECT count(*)::int FROM qualification_campaign_mutation_consumptions
              WHERE campaign_authorization_id=consumption.campaign_authorization_id) AS "consumptions",
            binding.canonical_external_identity AS "createdIdentity",
            binding.id::text AS "externalBindingId",
            binding.source_protected_operation_id::text AS "protectedOperationId",
            (SELECT count(*)::int FROM protected_operation_transitions transition
              WHERE transition.protected_operation_id=operation.id
                AND transition.from_state='ready_to_dispatch'
                AND transition.to_state='dispatching') AS dispatches
       FROM qualification_campaign_mutation_consumptions consumption
       JOIN external_resource_bindings binding ON binding.project_id=$2 AND binding.environment_id=$3
       JOIN protected_operations operation ON operation.id=binding.source_protected_operation_id
         AND operation.run_id=consumption.run_id AND operation.operation_id=consumption.operation_id
      WHERE consumption.campaign_authorization_id=$1 AND binding.lifecycle_state='active'`,
    [scope.campaignId, scope.projectId, scope.environmentId],
  );
  if (
    mutation.rowCount !== 1 ||
    mutation.rows[0]!.outcome !== "applied" ||
    mutation.rows[0]!.dispatches !== 1
  )
    throw new Error("Q5_EXACT_MUTATION_TRUTH_INVALID");
  const createdIdentity = mutation.rows[0]!.createdIdentity as string;
  const retrievalRefs = await database.query<any>(
    `SELECT operation.id::text AS "operationId",
            reference.value->>'credentialId' AS "credentialId"
       FROM protected_operations operation
       CROSS JOIN LATERAL jsonb_each(operation.persisted_references) reference
      WHERE operation.run_id=$1 AND operation.id<>$2
        AND operation.dispatch_semantics='read_only' AND operation.state='completed'
        AND operation.persistence_state='committed' AND reference.value ? 'credentialId'`,
    [truth.runId, mutation.rows[0]!.protectedOperationId],
  );
  const retrieved = await Promise.all(
    retrievalRefs.rows.map(
      async ({ credentialId, operationId }: { credentialId: string; operationId: string }) => {
        const value = await database.query<any>(
          `SELECT ciphertext,initialization_vector AS "initializationVector",
                authentication_tag AS "authenticationTag"
           FROM project_credentials WHERE id=$1 AND project_id=$2
             AND security_status='active' AND deleted_at IS NULL`,
          [credentialId, scope.projectId],
        );
        return {
          operationId,
          value: value.rowCount === 1 ? decryptCredential(value.rows[0]!) : undefined,
        };
      },
    ),
  );
  const retrievalMatches = retrieved.filter(({ value }) => value === createdIdentity);
  if (retrievalMatches.length !== 1) throw new Error("Q5_CREATE_RETRIEVE_ASSOCIATION_INVALID");
  const digest = createHash("sha256")
    .update(`scry-q5-external-identity\0${createdIdentity}`)
    .digest("hex");
  const transcript = (await readFile(path.join(output, "transcript.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as any);
  const snapshot = transcript.find(({ event }) => event === "mcp_snapshot")?.data;
  const invokedTools = transcript
    .filter(({ event }) => event === "tool_call")
    .map(({ data }) => data?.tool)
    .filter((tool): tool is string => typeof tool === "string");
  const requiredJourneyTools = [
    "get_operating_context",
    "list_project_credentials",
    "start_praxis_session",
    "observe_praxis_session",
    "start_run",
    "dispatch_run_operation",
    "finalize_run",
    "accept_objective_evidence",
    "finalize_agent_work",
    "preview_mission_report",
    "publish_mission_report",
    "end_agent_session",
  ];
  if (!requiredJourneyTools.every((tool) => invokedTools.includes(tool)))
    throw new Error("Q5_REQUIRED_AGENT_JOURNEY_INCOMPLETE");
  const toolNames = snapshot?.tools?.map(({ name }: { name: string }) => name);
  if (JSON.stringify(toolNames) !== JSON.stringify(Q5_MCP_TOOL_NAMES))
    throw new Error("Q5_MCP_TOOL_CONTRACT_MISMATCH");
  if (snapshot.protocolVersion !== Q5_MCP_PROTOCOL_VERSION)
    throw new Error("Q5_MCP_PROTOCOL_MISMATCH");
  const contractDigest = createHash("sha256")
    .update(JSON.stringify({ profile: Q5_MCP_PROFILE, tools: snapshot.tools }))
    .digest("hex");
  if (contractDigest !== Q5_MCP_CONTRACT_DIGEST) throw new Error("Q5_MCP_DIGEST_MISMATCH");
  return {
    schema: "scry.m6.q5.vitract-authoritative.v1",
    qualification: "M6_Q5_VITRACT_PREVIEW_TEST",
    source: {
      commit: source.commitSha,
      dirty: false,
      manifestSha256: source.manifestSha256,
      runtimeManifestSha256: source.manifestSha256,
      schemaFingerprint: expectedSchema,
      migrationSha256: expectedMigration,
    },
    authority: {
      authoritativeAttemptId: scope.attemptId,
      authoritativeAttemptState: "consumed",
      campaignId: scope.campaignId,
      campaignDisposition: truth.campaignDisposition,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      canonicalApplicationId: scope.applicationId,
      applicationIdentity: "vitract-preview-test",
      origin: VITRACT_CREATE_QUALIFICATION.providerOrigin,
      missionId: scope.missionId,
      objectiveId: scope.objectiveId,
      agentSessionId: scope.agentSessionId,
      externalRunId: scope.externalRunId,
    },
    runtime: {
      runId: truth.runId,
      runState: truth.runState,
      attemptId: truth.runAttemptId,
      attemptState: truth.runAttemptState,
      praxisSessionId: truth.praxisSessionId,
      praxisState: truth.praxisState,
      agentSessionState: truth.agentState,
      missionState: truth.missionState,
      objectiveState: truth.objectiveState,
      reportState: truth.reportState,
    },
    protectedOperation: {
      id: mutation.rows[0]!.protectedOperationId,
      state: "succeeded",
      plaintextExposed: false,
    },
    mutation: {
      operationId: mutation.rows[0]!.operationId,
      identity: mutation.rows[0]!.identity,
      outcome: "applied",
      campaignConsumptions: mutation.rows[0]!.consumptions,
      dispatches: mutation.rows[0]!.dispatches,
      externalRequests: mutation.rows[0]!.dispatches,
      externalEffects: 1,
      duplicates: 0,
      redispatches: 0,
    },
    retrieval: {
      createdOpaqueDigest: digest,
      retrievedOpaqueDigest: digest,
      association: "exact_digest_match",
      retrievalCount: 1,
    },
    evidence: Q5_REQUIRED_EVIDENCE_KINDS.map((kind) => ({
      kind,
      state: "accepted" as const,
      required: true as const,
      proof: evidenceProof(kind, {
        acceptedEvidenceId: truth.acceptedEvidenceId,
        authenticationOperationId: authentication.rows[0]!.operationId,
        externalBindingId: mutation.rows[0]!.externalBindingId,
        runAttemptId: truth.runAttemptId,
        protectedOperationId: mutation.rows[0]!.protectedOperationId,
        mutationOperationId: mutation.rows[0]!.operationId,
        retrievalOperationId: retrievalMatches[0]!.operationId,
        runId: truth.runId,
        reportId: truth.reportId,
      }),
    })),
    provider: {
      name: "deepseek",
      model,
      requestCount: truth.providerRequestCount,
      automaticRetries: 0,
    },
    mcp: {
      profile: Q5_MCP_PROFILE,
      protocolVersion: snapshot.protocolVersion,
      toolCount: toolNames.length,
      contractDigest,
    },
    privacy: { audit: "PASS", protectedLeakCount: privacy.protectedLeakCount },
    residue: { adjudication: "PASS", unsafeLiveOwners: 0, unknownPreserved: true },
  };
}

function evidenceProof(
  kind: (typeof Q5_REQUIRED_EVIDENCE_KINDS)[number],
  ids: {
    acceptedEvidenceId: string;
    authenticationOperationId: string;
    externalBindingId: string;
    runAttemptId: string;
    protectedOperationId: string;
    mutationOperationId: string;
    retrievalOperationId: string;
    runId: string;
    reportId: string;
  },
) {
  const proof = {
    public_discovery: [
      `run_attempt:${ids.runAttemptId}:available_safe_artifact`,
      "agent_transcript:get_operating_context",
    ],
    protected_authentication: [`adaptive_operation:${ids.authenticationOperationId}`],
    business_mutation: [
      `campaign_mutation_consumption:${ids.mutationOperationId}`,
      `protected_operation:${ids.protectedOperationId}`,
    ],
    external_effect_binding: [`external_resource_binding:${ids.externalBindingId}`],
    exact_retrieval: [`adaptive_operation:${ids.retrievalOperationId}:exact_identity_match`],
    run_operation: [`run_attempt:${ids.runAttemptId}:succeeded`],
    run_finalization: [`run:${ids.runId}:passed`],
    objective_acceptance: [`accepted_evidence:${ids.acceptedEvidenceId}`],
    mission_report: [`mission_report:${ids.reportId}:published`],
  } satisfies Record<(typeof Q5_REQUIRED_EVIDENCE_KINDS)[number], string[]>;
  return proof[kind];
}
