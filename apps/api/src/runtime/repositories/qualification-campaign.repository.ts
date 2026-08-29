import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CreateQualificationCampaignInput, QualificationCampaign } from "@scry/contracts";
import type { PoolClient } from "pg";

import type { Principal } from "../../auth/index.js";
import { Database } from "../../infrastructure/index.js";

type CampaignRow = {
  id: string;
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  purpose: "system_correctness";
  targetOrigin: string;
  applicationIdentity: string;
  qualificationMode: "local_test";
  ownerUserId: string;
  releaseIdentity: string;
  schemaIdentity: string;
  maxRuns: 1;
  maxBusinessMutationDispatches: 1;
  runsConsumed: number;
  businessMutationDispatchesConsumed: number;
  disposition: QualificationCampaign["disposition"];
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  terminalAt: Date | null;
};

const projection = `
  campaign.id,campaign.project_id AS "projectId",campaign.environment_id AS "environmentId",
  campaign.mission_id AS "missionId",campaign.objective_id AS "objectiveId",
  campaign.agent_session_id AS "agentSessionId",campaign.purpose,
  campaign.target_origin AS "targetOrigin",campaign.application_identity AS "applicationIdentity",
  campaign.qualification_mode AS "qualificationMode",campaign.owner_user_id AS "ownerUserId",
  campaign.release_identity AS "releaseIdentity",campaign.schema_identity AS "schemaIdentity",
  campaign.max_runs AS "maxRuns",
  campaign.max_business_mutation_dispatches AS "maxBusinessMutationDispatches",
  campaign.runs_consumed AS "runsConsumed",
  campaign.business_mutation_dispatches_consumed AS "businessMutationDispatchesConsumed",
  campaign.disposition,campaign.expires_at AS "expiresAt",campaign.created_at AS "createdAt",
  campaign.updated_at AS "updatedAt",campaign.terminal_at AS "terminalAt"`;

@Injectable()
export class QualificationCampaignRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async create(principal: Principal, projectId: string, input: CreateQualificationCampaignInput) {
    if (principal.kind !== "user")
      throw new ForbiddenException({ code: "QUALIFICATION_CAMPAIGN_HUMAN_OWNER_REQUIRED" });
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= Date.now())
      throw new ConflictException({ code: "QUALIFICATION_CAMPAIGN_ALREADY_EXPIRED" });
    return this.database.transaction(async (client) => {
      const scope = await client.query<{ baseOrigin: string }>(
        `SELECT environment.base_origin AS "baseOrigin"
           FROM projects project
           JOIN environments environment ON environment.project_id=project.id
           JOIN missions mission ON mission.project_id=project.id
           JOIN mission_objectives objective ON objective.mission_id=mission.id
           JOIN agent_sessions agent ON agent.mission_id=mission.id
          WHERE project.id=$1 AND project.workspace_id=$2 AND environment.id=$3
            AND mission.id=$4 AND objective.id=$5 AND agent.id=$6`,
        [
          projectId,
          principal.workspaceId,
          input.environmentId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
        ],
      );
      if (!scope.rowCount) throw new NotFoundException({ code: "QUALIFICATION_SCOPE_NOT_FOUND" });
      if (new URL(scope.rows[0]!.baseOrigin).origin !== input.targetOrigin)
        throw new ConflictException({ code: "QUALIFICATION_TARGET_ORIGIN_MISMATCH" });
      requireConfiguredIdentity(
        "SCRY_SOURCE_MANIFEST_SHA256",
        input.releaseIdentity,
        "QUALIFICATION_RELEASE_IDENTITY_MISMATCH",
      );
      requireConfiguredIdentity(
        "SCRY_SCHEMA_FINGERPRINT",
        input.schemaIdentity,
        "QUALIFICATION_SCHEMA_IDENTITY_MISMATCH",
      );
      const created = await client.query<CampaignRow>(
        `INSERT INTO qualification_campaign_authorizations AS campaign(
           project_id,environment_id,mission_id,objective_id,agent_session_id,purpose,
           target_origin,application_identity,qualification_mode,owner_user_id,
           release_identity,schema_identity,max_runs,max_business_mutation_dispatches,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING ${projection}`,
        [
          projectId,
          input.environmentId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          input.purpose,
          input.targetOrigin,
          input.applicationIdentity,
          input.qualificationMode,
          principal.userId,
          input.releaseIdentity,
          input.schemaIdentity,
          input.maxRuns,
          input.maxBusinessMutationDispatches,
          expiresAt,
        ],
      );
      return present(created.rows[0]!);
    });
  }

  async get(principal: Principal, campaignId: string) {
    const result = await this.database.query<CampaignRow>(
      `SELECT ${projection} FROM qualification_campaign_authorizations campaign
       JOIN projects project ON project.id=campaign.project_id
       WHERE campaign.id=$1 AND ($2::uuid IS NULL OR project.workspace_id=$2)`,
      [campaignId, principal.kind === "user" ? principal.workspaceId : null],
    );
    if (!result.rowCount) throw new NotFoundException({ code: "QUALIFICATION_CAMPAIGN_NOT_FOUND" });
    return present(result.rows[0]!);
  }

  async consumeRun(
    client: PoolClient,
    input: {
      campaignId?: string;
      projectId: string;
      environmentId: string;
      missionId: string;
      objectiveId: string;
      agentSessionId: string;
    },
  ) {
    if (!input.campaignId) {
      const scoped = await client.query(
        `SELECT 1 FROM qualification_campaign_authorizations
          WHERE project_id=$1 AND environment_id=$2 AND mission_id=$3
            AND objective_id=$4 AND agent_session_id=$5 LIMIT 1`,
        [
          input.projectId,
          input.environmentId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
        ],
      );
      if (scoped.rowCount)
        throw new ConflictException({ code: "QUALIFICATION_CAMPAIGN_AUTHORIZATION_REQUIRED" });
      return undefined;
    }
    const result = await client.query<CampaignRow & { environmentOrigin: string }>(
      `SELECT ${projection},environment.base_origin AS "environmentOrigin"
         FROM qualification_campaign_authorizations campaign
         JOIN environments environment ON environment.id=campaign.environment_id
        WHERE campaign.id=$1 FOR UPDATE OF campaign`,
      [input.campaignId],
    );
    const campaign = result.rows[0];
    if (!campaign) throw new ConflictException({ code: "QUALIFICATION_CAMPAIGN_INVALID" });
    if (
      campaign.projectId !== input.projectId ||
      campaign.environmentId !== input.environmentId ||
      campaign.missionId !== input.missionId ||
      campaign.objectiveId !== input.objectiveId ||
      campaign.agentSessionId !== input.agentSessionId ||
      new URL(campaign.environmentOrigin).origin !== campaign.targetOrigin
    )
      throw new ConflictException({ code: "QUALIFICATION_CAMPAIGN_SCOPE_MISMATCH" });
    if (campaign.expiresAt.getTime() <= Date.now()) {
      await client.query(
        `UPDATE qualification_campaign_authorizations SET disposition='expired',terminal_at=now(),updated_at=now()
          WHERE id=$1 AND disposition='authorized'`,
        [campaign.id],
      );
      throw new ConflictException({ code: "QUALIFICATION_CAMPAIGN_EXPIRED" });
    }
    const consumed = await client.query(
      `UPDATE qualification_campaign_authorizations
          SET runs_consumed=runs_consumed+1,updated_at=now()
        WHERE id=$1 AND disposition='authorized' AND expires_at>now() AND runs_consumed<max_runs
        RETURNING id`,
      [campaign.id],
    );
    if (!consumed.rowCount)
      throw new ConflictException({ code: "QUALIFICATION_RUN_CAPABILITY_CONSUMED" });
    return campaign.id;
  }

  async consumeBusinessMutation(input: {
    runId: string;
    operationId: string;
    mutationIdentity: string;
  }) {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        campaignId: string;
        disposition: QualificationCampaign["disposition"];
        expiresAt: Date;
      }>(
        `SELECT campaign.id AS "campaignId",campaign.disposition,campaign.expires_at AS "expiresAt"
           FROM runs run
           JOIN qualification_campaign_authorizations campaign
             ON campaign.id=run.qualification_campaign_authorization_id
          WHERE run.id=$1 FOR UPDATE OF campaign`,
        [input.runId],
      );
      if (!result.rowCount) return { campaignBound: false, replayed: false } as const;
      const campaign = result.rows[0]!;
      const existing = await client.query(
        `SELECT 1 FROM qualification_campaign_mutation_consumptions
          WHERE campaign_authorization_id=$1 AND operation_id=$2 AND mutation_identity=$3`,
        [campaign.campaignId, input.operationId, input.mutationIdentity],
      );
      if (existing.rowCount) return { campaignBound: true, replayed: true } as const;
      if (campaign.expiresAt.getTime() <= Date.now()) {
        await client.query(
          `UPDATE qualification_campaign_authorizations SET disposition='expired',terminal_at=now(),updated_at=now()
            WHERE id=$1 AND disposition='authorized'`,
          [campaign.campaignId],
        );
        throw new ConflictException({ code: "QUALIFICATION_CAMPAIGN_EXPIRED" });
      }
      const consumed = await client.query(
        `UPDATE qualification_campaign_authorizations
            SET business_mutation_dispatches_consumed=business_mutation_dispatches_consumed+1,
                updated_at=now()
          WHERE id=$1 AND disposition='authorized' AND expires_at>now()
            AND business_mutation_dispatches_consumed<max_business_mutation_dispatches
          RETURNING id`,
        [campaign.campaignId],
      );
      if (!consumed.rowCount)
        throw new ConflictException({ code: "QUALIFICATION_MUTATION_CAPABILITY_CONSUMED" });
      await client.query(
        `INSERT INTO qualification_campaign_mutation_consumptions(
           campaign_authorization_id,run_id,operation_id,mutation_identity
         ) VALUES($1,$2,$3,$4)`,
        [campaign.campaignId, input.runId, input.operationId, input.mutationIdentity],
      );
      return { campaignBound: true, replayed: false } as const;
    });
  }

  async refuseCampaignBoundMutationOutsideRun(sessionId: string) {
    const scoped = await this.database.query(
      `SELECT 1
         FROM adaptive_sessions session
         JOIN qualification_campaign_authorizations campaign
           ON campaign.project_id=session.project_id
          AND campaign.environment_id=session.environment_id
          AND campaign.mission_id=session.mission_id
          AND campaign.objective_id=session.objective_id
          AND campaign.agent_session_id=session.agent_session_id
        WHERE session.id=$1
        LIMIT 1`,
      [sessionId],
    );
    if (scoped.rowCount)
      throw new ConflictException({ code: "QUALIFICATION_MUTATION_REQUIRES_BOUND_RUN" });
  }

  async settleMutation(
    runId: string,
    operationId: string,
    outcome: "applied" | "not_applied" | "unknown",
  ) {
    await this.database.transaction(async (client) => {
      const settled = await client.query<{ campaignId: string }>(
        `UPDATE qualification_campaign_mutation_consumptions consumption
            SET mutation_outcome=$3,settled_at=now()
           FROM runs run
          WHERE consumption.run_id=run.id AND run.id=$1 AND consumption.operation_id=$2
          RETURNING consumption.campaign_authorization_id AS "campaignId"`,
        [runId, operationId, outcome],
      );
      if (outcome === "unknown" && settled.rowCount)
        await client.query(
          `UPDATE qualification_campaign_authorizations
              SET disposition='inconclusive',terminal_at=now(),updated_at=now()
            WHERE id=$1 AND disposition='authorized'`,
          [settled.rows[0]!.campaignId],
        );
    });
  }

  async settleRun(runId: string, disposition: "succeeded" | "failed" | "inconclusive") {
    await this.database.query(
      `UPDATE qualification_campaign_authorizations campaign
          SET disposition=CASE WHEN campaign.disposition='inconclusive' THEN 'inconclusive' ELSE $2 END,
              terminal_at=COALESCE(terminal_at,now()),updated_at=now()
         FROM runs run
        WHERE run.id=$1 AND campaign.id=run.qualification_campaign_authorization_id
          AND campaign.disposition IN ('authorized','inconclusive')`,
      [runId, disposition],
    );
  }
}

function present(row: CampaignRow): QualificationCampaign {
  return {
    ...row,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    terminalAt: row.terminalAt?.toISOString() ?? null,
  };
}

function requireConfiguredIdentity(name: string, supplied: string, code: string) {
  const configured = process.env[name];
  if (configured && /^[a-f0-9]{64}$/.test(configured) && configured !== supplied)
    throw new ConflictException({ code });
}
