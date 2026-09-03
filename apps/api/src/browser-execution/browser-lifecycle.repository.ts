import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type {
  BrowserProtectionSink,
  CreateBrowserEnvironmentV2Input,
  CreateBrowserFlowV2Input,
  CreateBrowserObjectiveV2Input,
  PublishBrowserMissionReportV2Input,
  StartBrowserMissionV2Input,
  StartBrowserRunV2Input,
} from "@scry/contracts";
import { browserProtectionSinkSchema } from "@scry/contracts";
import { ProtectionAuthority } from "@scry/browser-runtime";
import type { PoolClient, QueryResultRow } from "pg";

import { Database } from "../infrastructure/database.js";
import {
  BrowserProtectedValueCipher,
  type EncryptedProtectedValue,
} from "./protected-value-cipher.js";
import { BROWSER_RUNTIME_CAPABILITY_VERSION } from "./browser-runtime-capability.js";

interface IdRow extends QueryResultRow {
  id: string;
}

@Injectable()
export class BrowserLifecycleRepository {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(BrowserProtectedValueCipher)
    private readonly cipher: BrowserProtectedValueCipher = new BrowserProtectedValueCipher(),
  ) {}

  async createEnvironment(
    workspaceId: string | undefined,
    input: CreateBrowserEnvironmentV2Input,
  ) {
    return this.database.transaction(async (client) => {
      await this.requireProject(client, workspaceId, input.projectId);
      const existing = await client.query<{
        id: string;
        name: string;
        base_origin: string;
        allowed_service_origins: string[];
        disclosure_mode: string;
      }>(
        `SELECT id,name,base_origin,allowed_service_origins,disclosure_mode FROM environments
         WHERE project_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.projectId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.name !== input.name ||
          row.base_origin !== input.baseOrigin ||
          JSON.stringify(row.allowed_service_origins) !== JSON.stringify(input.allowedServiceOrigins) ||
          row.disclosure_mode !== input.disclosureMode
        )
          throw new Error("BROWSER_V2_ENVIRONMENT_IDEMPOTENCY_CONFLICT");
        return { environmentId: row.id, replay: true };
      }
      const environmentId = randomUUID();
      await client.query(
        `INSERT INTO environments(
           id,project_id,name,base_origin,allowed_service_origins,disclosure_mode,idempotency_key)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [
          environmentId,
          input.projectId,
          input.name,
          input.baseOrigin,
          JSON.stringify(input.allowedServiceOrigins),
          input.disclosureMode,
          input.idempotencyKey,
        ],
      );
      return { environmentId, replay: false };
    });
  }

  async startMission(workspaceId: string | undefined, input: StartBrowserMissionV2Input) {
    return this.database.transaction(async (client) => {
      await this.requireProject(client, workspaceId, input.projectId);
      const existing = await client.query<{
        missionId: string;
        agentSessionId: string;
      }>(
        `SELECT m.id AS "missionId",s.id AS "agentSessionId" FROM missions m
         JOIN agent_sessions s ON s.mission_id=m.id AND s.idempotency_key=$3
         WHERE m.project_id=$1 AND m.idempotency_key=$2 FOR UPDATE`,
        [input.projectId, input.idempotencyKey, `mission-agent:${input.idempotencyKey}`],
      );
      if (existing.rows[0]) {
        return {
          missionId: existing.rows[0].missionId,
          agentSessionId: existing.rows[0].agentSessionId,
          replay: true,
        };
      }
      const missionId = randomUUID();
      const agentSessionId = randomUUID();
      await client.query(
        `INSERT INTO missions(id,project_id,title,original_instruction,idempotency_key,state)
         VALUES($1,$2,$3,$4,$5,'planning')`,
        [missionId, input.projectId, input.title, input.instruction, input.idempotencyKey],
      );
      await client.query(
        `INSERT INTO agent_sessions(id,mission_id,project_id,provider,model,settings,instruction_snapshot,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          agentSessionId,
          missionId,
          input.projectId,
          input.provider,
          input.model ?? null,
          JSON.stringify(input.settings),
          input.instruction,
          `mission-agent:${input.idempotencyKey}`,
        ],
      );
      return { missionId, agentSessionId, replay: false };
    });
  }

  async createObjective(
    workspaceId: string | undefined,
    missionId: string,
    input: CreateBrowserObjectiveV2Input,
  ) {
    return this.database.transaction(async (client) => {
      const mission = await this.requireMissionAgent(
        client,
        workspaceId,
        missionId,
        input.agentSessionId,
      );
      const existing = await client.query<IdRow>(
        "SELECT id FROM mission_objectives WHERE mission_id=$1 AND idempotency_key=$2 FOR UPDATE",
        [missionId, input.idempotencyKey],
      );
      if (existing.rows[0]) return { objectiveId: existing.rows[0].id, replay: true };
      const objectiveId = randomUUID();
      await client.query(
        `INSERT INTO mission_objectives(id,mission_id,project_id,title,description,completion_criteria,objective_order,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          objectiveId,
          missionId,
          mission.projectId,
          input.title,
          input.description,
          JSON.stringify(input.completionCriteria),
          input.objectiveOrder,
          input.idempotencyKey,
        ],
      );
      return { objectiveId, replay: false };
    });
  }

  async createFlow(
    workspaceId: string | undefined,
    missionId: string,
    input: CreateBrowserFlowV2Input,
  ) {
    return this.database.transaction(async (client) => {
      const mission = await this.requireMissionAgent(
        client,
        workspaceId,
        missionId,
        input.agentSessionId,
      );
      const existing = await client.query<{ flowId: string; flowRevisionId: string }>(
        `SELECT f.id AS "flowId",r.id AS "flowRevisionId" FROM flows f
         JOIN flow_revisions r ON r.flow_id=f.id AND r.state='active'
         WHERE f.mission_id=$1 AND f.idempotency_key=$2 FOR UPDATE`,
        [missionId, input.idempotencyKey],
      );
      if (existing.rows[0]) return { ...existing.rows[0], replay: true };
      const flowId = randomUUID();
      const flowRevisionId = randomUUID();
      await client.query(
        `INSERT INTO flows(id,project_id,mission_id,created_by_agent_session_id,name,purpose,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          flowId,
          mission.projectId,
          missionId,
          input.agentSessionId,
          input.name,
          input.purpose,
          input.idempotencyKey,
        ],
      );
      await client.query(
        `INSERT INTO flow_revisions(id,flow_id,mission_id,project_id,revision,state,definition,created_by_agent_session_id,activated_at)
         VALUES($1,$2,$3,$4,1,'active',$5::jsonb,$6,now())`,
        [
          flowRevisionId,
          flowId,
          missionId,
          mission.projectId,
          JSON.stringify(input.definition),
          input.agentSessionId,
        ],
      );
      return { flowId, flowRevisionId, replay: false };
    });
  }

  async startRun(workspaceId: string | undefined, input: StartBrowserRunV2Input) {
    return this.database.transaction(async (client) => {
      await this.requireMissionAgent(
        client,
        workspaceId,
        input.missionId,
        input.agentSessionId,
        input.projectId,
      );
      const existing = await client.query<{ runId: string; browserSessionId: string }>(
        `SELECT r.id AS "runId",s.id AS "browserSessionId" FROM runs r
         JOIN browser_execution_sessions s ON s.run_id=r.id
         WHERE r.mission_id=$1 AND r.idempotency_key=$2 FOR UPDATE`,
        [input.missionId, input.idempotencyKey],
      );
      if (existing.rows[0]) return { ...existing.rows[0], replay: true };
      const environment = await client.query<{
        base_origin: string;
        allowed_service_origins: unknown;
        disclosure_mode: "confidential" | "trusted_application_output";
      }>(
        "SELECT base_origin,allowed_service_origins,disclosure_mode FROM environments WHERE id=$1 AND project_id=$2 AND state='active'",
        [input.environmentId, input.projectId],
      );
      if (!environment.rows[0]) throw new Error("BROWSER_V2_ENVIRONMENT_NOT_FOUND");
      const protectedInputIds = [...new Set(input.protectedInputIds)];
      if (protectedInputIds.length !== input.protectedInputIds.length)
        throw new Error("BROWSER_V2_PROTECTED_INPUT_DUPLICATE");
      if (protectedInputIds.length > 0) {
        const available = await client.query<{ id: string }>(
          `SELECT id FROM protected_values
           WHERE id=ANY($1::uuid[]) AND project_id=$2 AND source_kind='user_input' AND state='active'
             AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE`,
          [protectedInputIds, input.projectId],
        );
        if (available.rowCount !== protectedInputIds.length)
          throw new Error("BROWSER_V2_PROTECTED_INPUT_UNAVAILABLE");
      }
      const runId = randomUUID();
      const browserSessionId = randomUUID();
      await client.query(
        `INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,flow_id,flow_revision_id,environment_id,idempotency_key,state,started_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',now())`,
        [
          runId,
          input.projectId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          input.flowId,
          input.flowRevisionId,
          input.environmentId,
          input.idempotencyKey,
        ],
      );
      await client.query(
        `INSERT INTO browser_execution_sessions(id,run_id,project_id,mission_id,objective_id,environment_id,agent_session_id,
           state,authentication_commit_limit,business_commit_limit,allowed_first_party_origins,allowed_service_origins,
           runtime_capability_version,protection_key_version,disclosure_mode,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)`,
        [
          browserSessionId,
          runId,
          input.projectId,
          input.missionId,
          input.objectiveId,
          input.environmentId,
          input.agentSessionId,
          input.authenticationCommitLimit,
          input.businessCommitLimit,
          JSON.stringify([environment.rows[0].base_origin]),
          JSON.stringify(environment.rows[0].allowed_service_origins),
          BROWSER_RUNTIME_CAPABILITY_VERSION,
          this.cipher.activeKeyVersion(),
          environment.rows[0].disclosure_mode,
          `browser:${input.idempotencyKey}`,
        ],
      );
      await client.query(
        "INSERT INTO browser_execution_outbox(session_id,runtime_capability_version) VALUES($1,$2)",
        [browserSessionId, BROWSER_RUNTIME_CAPABILITY_VERSION],
      );
      for (const protectedValueId of protectedInputIds) {
        await client.query(
          "INSERT INTO browser_session_protected_inputs(session_id,protected_value_id,project_id) VALUES($1,$2,$3)",
          [browserSessionId, protectedValueId, input.projectId],
        );
      }
      await client.query(
        "UPDATE missions SET state='running',updated_at=now(),revision=revision+1,current_objective_id=$2 WHERE id=$1",
        [input.missionId, input.objectiveId],
      );
      await client.query(
        "UPDATE mission_objectives SET state='running',updated_at=now() WHERE id=$1 AND state='pending'",
        [input.objectiveId],
      );
      return { runId, browserSessionId, replay: false };
    });
  }

  async observeMission(workspaceId: string | undefined, missionId: string) {
    const mission = await this.database.query(
      `SELECT m.id,m.project_id AS "projectId",m.title,m.original_instruction AS instruction,m.state,m.revision,
         m.current_objective_id AS "currentObjectiveId",m.final_report_id AS "finalReportId",
         m.created_at AS "createdAt",m.updated_at AS "updatedAt"
       FROM missions m JOIN projects p ON p.id=m.project_id
       WHERE m.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [missionId, workspaceId ?? null],
    );
    if (!mission.rows[0]) throw new Error("BROWSER_V2_MISSION_NOT_FOUND");
    const [objectives, flows, runs] = await Promise.all([
      this.database.query(
        'SELECT id,title,description,state,completion_criteria AS "completionCriteria",objective_order AS "objectiveOrder",conclusion FROM mission_objectives WHERE mission_id=$1 ORDER BY objective_order',
        [missionId],
      ),
      this.database.query(
        `SELECT f.id,f.name,f.purpose,f.state,r.id AS "activeRevisionId",r.revision,r.definition FROM flows f LEFT JOIN flow_revisions r ON r.flow_id=f.id AND r.state='active' WHERE f.mission_id=$1 ORDER BY f.created_at`,
        [missionId],
      ),
      this.database.query(
        `SELECT r.id,r.flow_id AS "flowId",r.flow_revision_id AS "flowRevisionId",r.objective_id AS "objectiveId",r.state,r.outcome_classification AS "outcomeClassification",s.id AS "browserSessionId",s.active_owner_generation AS "activeOwnerGeneration",s.disclosure_mode AS "disclosureMode" FROM runs r LEFT JOIN browser_execution_sessions s ON s.run_id=r.id WHERE r.mission_id=$1 ORDER BY r.created_at`,
        [missionId],
      ),
    ]);
    return {
      ...mission.rows[0],
      objectives: objectives.rows,
      flows: flows.rows,
      runs: runs.rows,
    };
  }

  async listMissions(workspaceId: string | undefined, projectId: string) {
    const result = await this.database.query(
      `SELECT m.id,m.project_id AS "projectId",m.title,
         m.original_instruction AS "originalInstruction",m.state,m.state AS status,m.revision,
         (SELECT count(*)::integer FROM mission_objectives o WHERE o.mission_id=m.id) AS "objectiveCount",
         (SELECT count(*)::integer FROM mission_objectives o WHERE o.mission_id=m.id AND o.state IN ('passed','failed','skipped')) AS "terminalObjectiveCount",
         (SELECT count(*)::integer FROM browser_evidence_streams es JOIN runs r ON r.id=es.run_id WHERE r.mission_id=m.id AND es.state='complete') AS "acceptedEvidenceCount",
         m.updated_at AS "lastMeaningfulActivity",m.current_objective_id AS "currentObjectiveId",
         m.final_report_id AS "finalReportId",s.id AS "activeAgentSessionId",m.created_at AS "createdAt",m.updated_at AS "updatedAt"
       FROM missions m JOIN projects p ON p.id=m.project_id
       LEFT JOIN agent_sessions s ON s.mission_id=m.id AND s.state='active'
       WHERE m.project_id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)
       ORDER BY m.updated_at DESC,m.created_at DESC LIMIT 100`,
      [projectId, workspaceId ?? null],
    );
    return result.rows;
  }

  async markRunTerminal(
    workspaceId: string | undefined,
    runId: string,
    outcome: string,
    conclusion: string,
  ) {
    return this.database.transaction(async (client) => {
      const run = await client.query<{ mission_id: string; objective_id: string; state: string }>(
        `SELECT r.mission_id,r.objective_id,r.state FROM runs r JOIN projects p ON p.id=r.project_id
         WHERE r.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2) FOR UPDATE`,
        [runId, workspaceId ?? null],
      );
      const row = run.rows[0];
      if (!row) throw new Error("BROWSER_V2_RUN_NOT_FOUND");
      if (["passed", "failed", "cancelled", "infrastructure_error"].includes(row.state))
        return { replay: true };
      const state =
        outcome === "passed" ? "passed" : outcome === "cancelled" ? "cancelled" : "failed";
      await client.query(
        "UPDATE runs SET state=$2,outcome_classification=$3,completed_at=now(),updated_at=now() WHERE id=$1",
        [runId, state, outcome],
      );
      await client.query(
        "UPDATE mission_objectives SET state=$2,conclusion=$3,updated_at=now() WHERE id=$1",
        [row.objective_id, outcome === "passed" ? "passed" : "failed", conclusion],
      );
      return { replay: false };
    });
  }

  async executionSessionForRun(
    workspaceId: string | undefined,
    runId: string,
  ): Promise<{ id: string }> {
    const result = await this.database.query<{ id: string }>(
      `SELECT s.id FROM browser_execution_sessions s JOIN runs r ON r.id=s.run_id
       JOIN projects p ON p.id=r.project_id WHERE r.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [runId, workspaceId ?? null],
    );
    if (!result.rows[0]) throw new Error("BROWSER_V2_RUN_NOT_FOUND");
    return result.rows[0];
  }

  async publishReport(
    workspaceId: string | undefined,
    missionId: string,
    input: PublishBrowserMissionReportV2Input,
  ) {
    return this.database.transaction(async (client) => {
      await this.requireMissionAgent(client, workspaceId, missionId, input.agentSessionId);
      const existing = await client.query<IdRow>(
        "SELECT id FROM mission_reports WHERE mission_id=$1 FOR UPDATE",
        [missionId],
      );
      if (existing.rows[0]) return { reportId: existing.rows[0].id, replay: true };
      const incomplete = await client.query(
        `SELECT 1 FROM mission_objectives WHERE mission_id=$1 AND state NOT IN ('passed','failed','skipped')
         UNION ALL SELECT 1 FROM runs WHERE mission_id=$1 AND state NOT IN ('passed','failed','cancelled','infrastructure_error')
         UNION ALL SELECT 1 FROM browser_effects WHERE mission_id=$1 AND mutation_outcome='pending' LIMIT 1`,
        [missionId],
      );
      if (incomplete.rowCount) throw new Error("BROWSER_V2_MISSION_NOT_REPORTABLE");
      const evidence = await client.query<{ chain_head: string }>(
        `SELECT e.chain_head FROM browser_evidence_streams e JOIN runs r ON r.id=e.run_id
         WHERE r.mission_id=$1 AND e.state='complete' ORDER BY r.created_at,e.id`,
        [missionId],
      );
      if (evidence.rows.length === 0 || evidence.rows.some((row) => !row.chain_head))
        throw new Error("BROWSER_V2_MISSION_EVIDENCE_INCOMPLETE");
      const evidenceDigest = createHash("sha256")
        .update(JSON.stringify(evidence.rows.map((row) => row.chain_head)))
        .digest("hex");
      const protection = await this.reportProtectionAuthority(client, missionId);
      const summary = protection.sanitize(input.summary, "report");
      const safeReport = protection.sanitizeValue(input.safeReport, "", "report");
      const reportId = randomUUID();
      await client.query(
        `INSERT INTO mission_reports(id,mission_id,state,summary,safe_report,evidence_digest,finalized_at)
         VALUES($1,$2,'final',$3,$4::jsonb,$5,now())`,
        [reportId, missionId, summary, JSON.stringify(safeReport), evidenceDigest],
      );
      await client.query(
        "UPDATE missions SET state='completed',final_report_id=$2,completed_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1",
        [missionId, reportId],
      );
      await client.query(
        "UPDATE agent_sessions SET state='completed',ended_at=now() WHERE id=$1 AND state='active'",
        [input.agentSessionId],
      );
      return { reportId, replay: false };
    });
  }

  private async reportProtectionAuthority(
    client: PoolClient,
    missionId: string,
  ): Promise<ProtectionAuthority> {
    const mission = await client.query<{ project_id: string }>(
      "SELECT project_id FROM missions WHERE id=$1",
      [missionId],
    );
    const projectId = mission.rows[0]?.project_id;
    if (!projectId) throw new Error("BROWSER_V2_MISSION_NOT_FOUND");
    const generated = await client.query<{
      id: string;
      display_name: string;
      ciphertext: Buffer;
      nonce: Buffer;
      authentication_tag: Buffer;
      value_digest: string;
      key_version: string;
      run_id: string;
      source_effect_id: string;
    }>(
      `SELECT v.id,v.display_name,v.ciphertext,v.nonce,v.authentication_tag,v.value_digest,v.key_version,
              v.run_id,v.source_effect_id
       FROM protected_values v
       JOIN browser_outputs o ON o.protected_value_id=v.id
       WHERE v.mission_id=$1 AND v.project_id=$2 AND v.source_kind='generated' AND v.state='active'`,
      [missionId, projectId],
    );
    const boundInputs = await client.query<{
      id: string;
      display_name: string;
      ciphertext: Buffer;
      nonce: Buffer;
      authentication_tag: Buffer;
      value_digest: string;
      key_version: string;
    }>(
      `SELECT DISTINCT v.id,v.display_name,v.ciphertext,v.nonce,v.authentication_tag,
              v.value_digest,v.key_version
       FROM protected_values v
       JOIN browser_session_protected_inputs i ON i.protected_value_id=v.id
       JOIN browser_execution_sessions s ON s.id=i.session_id
       WHERE s.mission_id=$1 AND v.project_id=$2 AND v.source_kind='user_input' AND v.state='active'`,
      [missionId, projectId],
    );
    const protectedValues: Record<string, string> = {};
    for (const row of generated.rows) {
      protectedValues[`generated_${row.id}`] = this.cipher.decrypt(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authenticationTag: row.authentication_tag,
          valueDigest: row.value_digest,
          keyVersion: row.key_version,
        } satisfies EncryptedProtectedValue,
        {
          projectId,
          missionId,
          runId: row.run_id,
          effectId: row.source_effect_id,
          canonicalName: row.display_name,
        },
      );
    }
    for (const row of boundInputs.rows)
      protectedValues[`input_${row.id}`] = this.cipher.decrypt(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authenticationTag: row.authentication_tag,
          valueDigest: row.value_digest,
          keyVersion: row.key_version,
        } satisfies EncryptedProtectedValue,
        {
          projectId,
          protectedValueId: row.id,
          canonicalName: row.display_name,
          sourceKind: "user_input",
        },
      );
    const released = await client.query<{ public_value: unknown; allowed_sinks: string[] }>(
      `SELECT o.public_value,d.allowed_sinks
       FROM browser_outputs o
       JOIN browser_publications p ON p.id=o.publication_id
       JOIN browser_execution_sessions s ON s.id=p.session_id
       JOIN browser_protection_decisions d
         ON d.capture_id=p.capture_id AND d.canonical_name=o.canonical_name
       WHERE s.mission_id=$1 AND o.classification='public' AND d.label='public'`,
      [missionId],
    );
    const restoredPublicValues = released.rows
      .filter(
        (row): row is { public_value: string; allowed_sinks: string[] } =>
          typeof row.public_value === "string",
      )
      .map((row) => ({
        value: row.public_value,
        allowedSinks: row.allowed_sinks.map((sink) =>
          browserProtectionSinkSchema.parse(sink),
        ) as BrowserProtectionSink[],
      }));
    return new ProtectionAuthority({
      scope: {
        projectId,
        missionId,
        runId: `report:${missionId}`,
        sessionId: `report:${missionId}`,
        origin: `report://${missionId}`,
      },
      protectedValues,
      restoredPublicValues,
    });
  }

  private async requireProject(
    client: PoolClient,
    workspaceId: string | undefined,
    projectId: string,
  ): Promise<void> {
    const result = await client.query(
      "SELECT 1 FROM projects WHERE id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)",
      [projectId, workspaceId ?? null],
    );
    if (!result.rowCount) throw new Error("BROWSER_V2_PROJECT_NOT_FOUND");
  }

  private async requireMissionAgent(
    client: PoolClient,
    workspaceId: string | undefined,
    missionId: string,
    agentSessionId: string,
    projectId?: string,
  ): Promise<{ projectId: string }> {
    const result = await client.query<{ projectId: string }>(
      `SELECT m.project_id AS "projectId" FROM missions m JOIN projects p ON p.id=m.project_id
       JOIN agent_sessions s ON s.mission_id=m.id AND s.project_id=m.project_id
       WHERE m.id=$1 AND s.id=$2 AND s.state='active' AND ($3::uuid IS NULL OR p.workspace_id=$3)
         AND ($4::uuid IS NULL OR m.project_id=$4)`,
      [missionId, agentSessionId, workspaceId ?? null, projectId ?? null],
    );
    if (!result.rows[0]) throw new Error("BROWSER_V2_MISSION_AGENT_CONTEXT_INVALID");
    return result.rows[0];
  }
}
