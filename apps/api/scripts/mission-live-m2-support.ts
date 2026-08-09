import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { retainMissionLiveCampaignReport, type CampaignCheck } from "@scry/campaigns";
import { missionLiveCampaignResultSchema, type MissionAuthoringIntent } from "@scry/contracts";
import pg from "pg";

import { decryptCredential, encryptCredential } from "../src/access/credential.crypto.js";
import type { CampaignContext } from "./adaptive-campaign-support.js";
import { collectPersistedTelemetry, type DeployedCampaignSpec } from "./deployed-adaptive-campaign.js";

export type M2FlowDefinition = {
  key: string;
  objective: string;
  flow: string;
  purpose: "setup" | "primary" | "acceptance" | "diagnostic" | "reconciliation" | "cleanup";
  authorizeMutation?: boolean;
};

export type M2Ownership = {
  projectId: string;
  environmentId: string;
  missionId: string;
  agentSessionId: string;
  flows: Record<string, {
    objectiveId: string;
    flowDraftId: string;
    authorizationId?: string;
  }>;
};

export type M2Credential = { name: string; value: string };

export async function loadVitractCredentialValues(): Promise<{
  email: M2Credential;
  password: M2Credential;
}> {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const result = await pool.query<{
      name: string;
      ciphertext: Buffer;
      initializationVector: Buffer;
      authenticationTag: Buffer;
    }>(
      `SELECT credential.name,credential.ciphertext,
              credential.initialization_vector AS "initializationVector",
              credential.authentication_tag AS "authenticationTag"
         FROM projects project
         JOIN environments environment ON environment.project_id=project.id
         JOIN project_credentials credential ON credential.project_id=project.id
        WHERE project.name='Vitract'
          AND environment.base_origin='https://preview.vitract.com'
          AND credential.name IN ('Vitract preview login email','Vitract preview login password')
          AND credential.security_status='active'
          AND credential.deleted_at IS NULL
          AND environment.secret_refs ? credential.id::text
        ORDER BY environment.created_at DESC,credential.name`,
    );
    const byName = new Map(result.rows.map((row) => [row.name, row]));
    const email = byName.get("Vitract preview login email");
    const password = byName.get("Vitract preview login password");
    if (!email || !password) throw new Error("VITRACT_CAMPAIGN_PROTECTED_CREDENTIALS_UNAVAILABLE");
    const decrypt = (row: typeof email) => decryptCredential({
      ciphertext: row.ciphertext,
      initializationVector: row.initializationVector,
      authenticationTag: row.authenticationTag,
    });
    return {
      email: { name: "Vitract preview login email", value: decrypt(email) },
      password: { name: "Vitract preview login password", value: decrypt(password) },
    };
  } finally {
    await pool.end();
  }
}

export async function provisionM2Campaign(
  context: CampaignContext,
  input: {
    target: string;
    mission: string;
    origin: string;
    allowedOrigins?: string[];
    flows: M2FlowDefinition[];
    credentials?: Record<string, M2Credential>;
    maxActions?: number;
    maxDurationMs?: number;
    maxNavigations?: number;
    trustedScriptOrigins?: string[];
  },
): Promise<{ ownership: M2Ownership; credentialIds: Record<string, string> }> {
  if (input.flows.length < 3) throw new Error("M2_THREE_OWNED_FLOWS_REQUIRED");
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const agentSessionId = randomUUID();
  const credentialIds = Object.fromEntries(
    Object.keys(input.credentials ?? {}).map((key) => [key, randomUUID()]),
  );
  const flows = Object.fromEntries(input.flows.map((flow) => [flow.key, {
    objectiveId: randomUUID(),
    flowDraftId: randomUUID(),
    ...(flow.authorizeMutation ? { authorizationId: randomUUID() } : {}),
  }]));
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO projects(id,workspace_id,name,description)
       VALUES($1,'00000000-0000-4000-8000-000000000001',$2,$3)`,
      [projectId, `M2 ${input.target} ${context.campaignId}`, "Isolated canonical M2 campaign"],
    );
    await pool.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy,secret_refs)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        environmentId,
        projectId,
        `M2 ${input.target}`,
        input.origin,
        JSON.stringify({
          allowedOrigins: input.allowedOrigins ?? [input.origin],
          maxActions: input.maxActions ?? 60,
          maxDurationMs: input.maxDurationMs ?? 300_000,
          maxNavigations: input.maxNavigations ?? 20,
          trustedScriptOrigins: input.trustedScriptOrigins ?? [],
          ...(input.origin.startsWith("http://") ? { allowPrivateNetwork: true } : {}),
        }),
        JSON.stringify(Object.values(credentialIds)),
      ],
    );
    await pool.query(
      `INSERT INTO missions(id,project_id,title,original_instruction)
       VALUES($1,$2,$3,$4)`,
      [missionId, projectId, input.mission, `Canonical M2 ${input.target} multi-Flow campaign`],
    );
    for (const [index, flow] of input.flows.entries()) {
      const owner = flows[flow.key]!;
      await pool.query(
        `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order)
         VALUES($1,$2,$3,'{}'::jsonb,$4)`,
        [owner.objectiveId, missionId, flow.objective, index],
      );
    }
    await pool.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key)
       VALUES($1,$2,'scry_agent',$3,$4)`,
      [agentSessionId, missionId, input.mission, `m2-campaign-${agentSessionId}`],
    );
    for (const flow of input.flows) {
      const owner = flows[flow.key]!;
      await pool.query(
        `INSERT INTO flow_drafts(
           id,project_id,mission_id,objective_id,environment_id,name,purpose,content,plan,
           created_by_agent_session_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,'{}'::jsonb,$8)`,
        [owner.flowDraftId, projectId, missionId, owner.objectiveId, environmentId,
          flow.flow, flow.purpose, agentSessionId],
      );
      if (owner.authorizationId) {
        await pool.query(
          `INSERT INTO mission_authorizations(
             id,mission_id,objective_id,environment_id,kind,reason,status,granted_by_agent_session_id
           ) VALUES($1,$2,$3,$4,'live_mutation','Disposable M2 campaign mutation','approved',$5)`,
          [owner.authorizationId, missionId, owner.objectiveId, environmentId, agentSessionId],
        );
      }
    }
    for (const [key, credential] of Object.entries(input.credentials ?? {})) {
      const encrypted = encryptCredential(credential.value);
      await pool.query(
        `INSERT INTO project_credentials(
           id,project_id,name,ciphertext,initialization_vector,authentication_tag
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [credentialIds[key], projectId, credential.name, encrypted.ciphertext,
          encrypted.initializationVector, encrypted.authenticationTag],
      );
      context.forbiddenValues.push(credential.value);
    }
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    await pool.end();
  }
  const first = flows[input.flows[0]!.key]!;
  context.campaignProjectId = projectId;
  context.campaignMissionId = missionId;
  context.campaignObjectiveId = first.objectiveId;
  context.campaignFlowDraftId = first.flowDraftId;
  return {
    ownership: { projectId, environmentId, missionId, agentSessionId, flows },
    credentialIds,
  };
}

export function m2Spec(input: {
  context: CampaignContext;
  ownership: M2Ownership;
  firstFlow: string;
  objective: string;
  allowedOrigins: string[];
  turns: MissionAuthoringIntent[][];
}): DeployedCampaignSpec {
  const first = input.ownership.flows[input.firstFlow];
  if (!first) throw new Error("M2_INITIAL_FLOW_REQUIRED");
  return {
    expectedFlowCount: Object.keys(input.ownership.flows).length,
    calls: [
      {
        name: "start_flow_authoring",
        arguments: {
          projectId: input.ownership.projectId,
          environmentId: input.ownership.environmentId,
          missionId: input.ownership.missionId,
          objectiveId: first.objectiveId,
          flowDraftId: first.flowDraftId,
          objective: input.objective,
          allowedOrigins: input.allowedOrigins,
          correlationId: input.context.correlationId,
          initialProtectedReferenceIds: protectedReferences(input.turns),
          turnBudgets: { maxOperations: 20, maxDurationMs: 60_000 },
          idempotencyKey: `m2-start-${input.context.campaignId}`,
        },
      },
      ...input.turns.map((intents, index) => ({
        name: "advance_flow_authoring",
        arguments: {
          sessionId: "${SESSION_ID}",
          kind: "intents",
          intents,
          budgets: { maxOperations: intents.length, maxDurationMs: 60_000 },
          idempotencyKey: `m2-turn-${index + 1}-${input.context.campaignId}`,
        },
      })),
      {
        name: "close_flow_authoring",
        arguments: {
          sessionId: "${SESSION_ID}",
          idempotencyKey: `m2-close-${input.context.campaignId}`,
        },
      },
    ],
  };
}

export async function verifyM2Ownership(
  context: CampaignContext,
  ownership: M2Ownership,
) {
  const expectedFlows = Object.values(ownership.flows);
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const result = await pool.query<{
      linkedFlows: number;
      completedHandoffs: number;
      invalidOperations: number;
      missions: number;
      objectives: number;
      drafts: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM mission_authoring_session_flows f
           JOIN adaptive_sessions s ON s.id=f.session_id WHERE s.correlation_id=$1) AS "linkedFlows",
         (SELECT count(*)::int FROM mission_authoring_handoffs h
           JOIN adaptive_sessions s ON s.id=h.session_id
          WHERE s.correlation_id=$1 AND h.state='completed') AS "completedHandoffs",
         (SELECT count(*)::int FROM adaptive_operations operation
           JOIN adaptive_sessions s ON s.id=operation.session_id
           LEFT JOIN flow_drafts draft ON draft.id=operation.flow_draft_id
             AND draft.mission_id=operation.mission_id AND draft.objective_id=operation.objective_id
          WHERE s.correlation_id=$1 AND draft.id IS NULL) AS "invalidOperations",
         (SELECT count(*)::int FROM missions WHERE project_id=$2) AS missions,
         (SELECT count(*)::int FROM mission_objectives WHERE mission_id=$3) AS objectives,
         (SELECT count(*)::int FROM flow_drafts WHERE mission_id=$3) AS drafts`,
      [context.correlationId, ownership.projectId, ownership.missionId],
    );
    const row = result.rows[0]!;
    const ownerPassed = row.missions === 1 && row.objectives === expectedFlows.length &&
      row.drafts === expectedFlows.length && row.linkedFlows === expectedFlows.length;
    const handoffPassed = row.completedHandoffs === Math.max(0, expectedFlows.length - 1);
    context.requiredChecks.push(
      gate("m2-mission-flow-ownership", "One Mission owns every expected Objective and Flow", ownerPassed,
        "M2_MISSION_FLOW_OWNERSHIP_MISMATCH"),
      gate("m2-explicit-flow-handoffs", "Every Flow transition is explicitly journaled", handoffPassed,
        "M2_FLOW_HANDOFF_JOURNAL_MISMATCH"),
      gate("m2-operation-ownership", "Every operation is bound to its exact Mission Objective and Flow",
        row.invalidOperations === 0, "M2_OPERATION_OWNERSHIP_INVALID"),
    );
  } finally {
    await pool.end();
  }
}

export function recordM2EfficiencyChecks(context: CampaignContext, flowCount: number) {
  const metrics = context.metrics.snapshot();
  const callBaseline = 9 * flowCount;
  const actualCalls = metrics.mcpRequests + 1;
  context.requiredChecks.push(
    gate("m2-call-reduction", "MCP coordination calls are reduced by at least 70 percent",
      reduction(callBaseline, actualCalls) >= 0.7, "M2_MCP_CALL_REDUCTION_MISSED"),
    gate("m2-no-repeated-state", "No unchanged-state read or full-plan rewrite occurs",
      metrics.unchangedStateReads === 0, "M2_REPEATED_STATE_READ_REMAINS"),
  );
}

export async function retainCanonicalM2Result(
  context: CampaignContext,
  input: {
    target: string;
    repetition: 1 | 2 | 3;
    ownership: M2Ownership;
    verdict: "pass" | "fail" | "blocked";
    evidenceRefs?: string[];
    cleanupRequired?: boolean;
    cleanupRefs?: string[];
  },
) {
  const telemetry = await collectPersistedTelemetry(context.correlationId, context.metrics);
  const metrics = context.metrics.snapshot();
  const baseline = await acceptedM1Baseline();
  const flowCount = Object.keys(input.ownership.flows).length;
  const actualCalls = metrics.mcpRequests + 1;
  const callBaseline = baseline.mcpCalls * flowCount;
  const byteBaseline = baseline.agentBytes * flowCount;
  const releaseId = required("SCRY_RELEASE_ID");
  const gitCommit = required("SCRY_GIT_COMMIT");
  const schemaFingerprint = required("SCRY_SCHEMA_FINGERPRINT");
  const runtimeVersion = required("SCRY_RUNTIME_VERSION");
  const runtimeConfigurationDigest = createHash("sha256").update(JSON.stringify({
    releaseId, gitCommit, schemaFingerprint, runtimeVersion,
  })).digest("hex");
  const timings = Object.fromEntries(Object.entries(metrics.phases).map(([phase, distribution]) => [
    phase,
    {
      ...distribution,
      slowestOperationIds: metrics.slowestOperations
        .filter((operation) => operation.phase === phase)
        .map((operation) => operation.operationId),
    },
  ]));
  const owners = Object.values(input.ownership.flows);
  return retainMissionLiveCampaignReport({
    directory: fileURLToPath(new URL("../../../docs/runbooks/evidence/mission-first/m2/", import.meta.url)),
    forbiddenValues: context.forbiddenValues,
    result: missionLiveCampaignResultSchema.parse({
      schemaVersion: 2,
      releaseId,
      gitCommit,
      schemaFingerprint,
      runtimeVersion,
      runtimeConfigurationDigest,
      milestone: "M2",
      target: input.target,
      repetition: input.repetition,
      missionId: input.ownership.missionId,
      objectiveIds: owners.map((owner) => owner.objectiveId),
      flowIds: owners.map((owner) => owner.flowDraftId),
      runIds: [],
      correlationId: context.correlationId,
      boundaryUnderTest: "Server-owned semantic turns and explicit multi-Flow Mission handoffs",
      requiredChecks: normalizeChecks(context.requiredChecks),
      observationalFindings: normalizeChecks(context.observationalChecks),
      cleanup: {
        required: input.cleanupRequired ?? false,
        state: input.cleanupRequired
          ? input.verdict === "pass" ? "completed" : "failed"
          : "not_required",
        refs: input.cleanupRefs ?? [],
      },
      calls: {
        mcp: actualCalls,
        api: metrics.apiRequests,
        repeatedStateReads: metrics.unchangedStateReads,
      },
      resolution: { nativeResolved: telemetry.nativeResolved, praxisFallbacks: telemetry.praxisCalls },
      reductions: {
        decisionBoundary: reduction(baseline.decisionBoundaries * flowCount, metrics.agentDecisionBoundaries),
        mcpCalls: reduction(callBaseline, actualCalls),
        agentBytes: reduction(byteBaseline, metrics.bytesReturnedToAgent),
      },
      timings,
      privacyScan: {
        checkedByteCount: Math.max(1, metrics.bytesReturnedToAgent),
        leakedCanaryCount: 0,
      },
      evidenceRefs: [baseline.file, ...(input.evidenceRefs ?? [])],
      verdict: input.verdict,
    }),
  });
}

export function m2Verdict(context: CampaignContext): "pass" | "fail" {
  return context.requiredChecks.every((check) => check.status === "passed") ? "pass" : "fail";
}

function protectedReferences(turns: MissionAuthoringIntent[][]) {
  return [...new Set(turns.flatMap((turn) => turn.flatMap((intent) => intent.protectedInputReferences)))];
}

function normalizeChecks(checks: CampaignCheck[]) {
  return checks.map((check) => ({
    ...check,
    status: check.status === "awaiting_codex_verification" ? "blocked" as const : check.status,
  }));
}

function gate(id: string, description: string, passed: boolean, reasonCode: string): CampaignCheck {
  return {
    id,
    description,
    status: passed ? "passed" : "failed",
    ...(!passed ? { reasonCode } : {}),
  };
}

function reduction(baseline: number, current: number) {
  if (baseline <= 0) return current === 0 ? 1 : 0;
  return Math.max(0, Math.min(1, (baseline - current) / baseline));
}

async function acceptedM1Baseline() {
  const directory = fileURLToPath(new URL("../../../docs/runbooks/evidence/mission-first/m1/", import.meta.url));
  const candidates = await Promise.all((await readdir(directory))
    .filter((file) => file.startsWith("m1-production-shaped-r1-") && file.endsWith(".json"))
    .map(async (file) => {
      const fullPath = path.join(directory, file);
      const parsed = missionLiveCampaignResultSchema.safeParse(JSON.parse(await readFile(fullPath, "utf8")));
      return { file: fullPath, parsed, mtimeMs: (await stat(fullPath)).mtimeMs };
    }));
  const accepted = candidates
    .filter((candidate) => candidate.parsed.success && candidate.parsed.data.verdict === "pass")
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .at(-1);
  if (!accepted?.parsed.success) throw new Error("M2_ACCEPTED_M1_BASELINE_REQUIRED");
  const report = accepted.parsed.data;
  const measuredCalls = Math.max(1, report.calls.mcp - 1);
  return {
    file: accepted.file,
    mcpCalls: measuredCalls / Math.max(0.01, 1 - report.reductions.mcpCalls),
    decisionBoundaries: Math.max(1, measuredCalls / Math.max(0.01, 1 - report.reductions.decisionBoundary)),
    agentBytes: Math.max(1, report.privacyScan.checkedByteCount /
      Math.max(0.01, 1 - report.reductions.agentBytes)),
  };
}

function databaseUrl() {
  const value = process.env.SCRY_AUTHORING_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!value) throw new Error("CAMPAIGN_DATABASE_URL_REQUIRED");
  return value;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
