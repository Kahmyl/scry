import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { Principal } from "../auth/index.js";
import { Database } from "../infrastructure/index.js";

@Injectable()
export class FlowReadRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async list(principal: Principal, projectId: string, visibility = "reusable") {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const project = await this.database.query(
      `SELECT 1 FROM projects WHERE id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)`,
      [projectId, workspaceId],
    );
    if (!project.rowCount) throw new NotFoundException("Project not found");

    return (
      await this.database.query(
        `WITH published AS (
         SELECT f.id,f.project_id AS "projectId",'published'::text AS "recordKind",f.publication_state AS "lifecycleState",
              f.name, f.description, f.latest_revision_id AS "latestRevisionId",
              f.visibility,f.purpose,f.origin_mission_id AS "originMissionId",f.origin_objective_id AS "originObjectiveId",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('missionId',linked.mission_id,'objectiveId',linked.objective_id,'missionTitle',linked.title) ORDER BY linked.created_at DESC)
                FROM (SELECT l.mission_id,l.objective_id,m.title,l.created_at FROM mission_flow_links l JOIN missions m ON m.id=l.mission_id WHERE l.flow_id=f.id) linked),'[]'::jsonb) AS "missionLinks",
              fr.revision AS "latestVersion",
              fr.content AS "latestContent", fr.plan AS "latestPlan",
              jsonb_array_length(COALESCE(fr.plan->'steps','[]'::jsonb))::int AS "stepCount",
              (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(fr.plan->'steps','[]'::jsonb)) step WHERE step->'action'->>'type'='navigate') AS "navigationCount",
              f.created_at AS "createdAt", f.updated_at AS "updatedAt"
       FROM flows f JOIN flow_revisions fr ON fr.id = f.latest_revision_id
       WHERE f.project_id=$1
         AND f.publication_state='published'
         AND ($2='all' OR f.visibility=$2)
       ), drafts AS (
         SELECT d.id,d.project_id AS "projectId",'draft'::text AS "recordKind",d.state AS "lifecycleState",
              d.name,d.description,NULL::uuid AS "latestRevisionId",
              'mission_local'::text AS visibility,d.purpose,d.mission_id AS "originMissionId",d.objective_id AS "originObjectiveId",
              jsonb_build_array(jsonb_build_object('missionId',d.mission_id,'objectiveId',d.objective_id,'missionTitle',m.title)) AS "missionLinks",
              d.version AS "latestVersion",
              jsonb_build_object('objective',d.content->'objective','expectedOutcomes',COALESCE(d.content->'expectedOutcomes','[]'::jsonb)) AS "latestContent",
              NULL::jsonb AS "latestPlan",
              jsonb_array_length(COALESCE(d.plan->'steps','[]'::jsonb))::int AS "stepCount",
              (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(d.plan->'steps','[]'::jsonb)) step WHERE step->'action'->>'type'='navigate') AS "navigationCount",
              d.created_at AS "createdAt",d.updated_at AS "updatedAt"
         FROM flow_drafts d JOIN missions m ON m.id=d.mission_id
         WHERE d.project_id=$1 AND d.state NOT IN ('published','abandoned') AND $2='all'
       )
       SELECT * FROM published UNION ALL SELECT * FROM drafts ORDER BY "updatedAt" DESC`,
        [projectId, visibility],
      )
    ).rows;
  }

  async getPublished(principal: Principal, flowId: string) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await this.database.query(
      `SELECT f.id,f.project_id AS "projectId",'published'::text AS "recordKind",
              f.publication_state AS "lifecycleState",f.name,f.description,f.visibility,f.purpose,
              f.origin_mission_id AS "originMissionId",f.origin_objective_id AS "originObjectiveId",
              f.latest_revision_id AS "latestRevisionId",fr.revision AS version,
              fr.content,fr.plan,fr.validation,fr.publication_state AS "revisionPublicationState",
              f.created_at AS "createdAt",f.updated_at AS "updatedAt",fr.created_at AS "revisionCreatedAt",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('missionId',l.mission_id,'objectiveId',l.objective_id,'missionTitle',m.title) ORDER BY l.created_at DESC)
                FROM mission_flow_links l JOIN missions m ON m.id=l.mission_id WHERE l.flow_id=f.id),'[]'::jsonb) AS "missionLinks"
       FROM flows f JOIN flow_revisions fr ON fr.id=f.latest_revision_id JOIN projects p ON p.id=f.project_id
       WHERE f.id=$1 AND f.publication_state='published' AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [flowId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Published Flow not found");
    return result.rows[0];
  }
}
