import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { Principal } from "./auth.types.js";
import { Database } from "./database.js";

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
        `SELECT f.id, f.name, f.description, f.latest_revision_id AS "latestRevisionId",
              f.visibility,f.purpose,f.origin_mission_id AS "originMissionId",f.origin_objective_id AS "originObjectiveId",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('missionId',linked.mission_id,'objectiveId',linked.objective_id,'missionTitle',linked.title) ORDER BY linked.created_at DESC)
                FROM (SELECT l.mission_id,l.objective_id,m.title,l.created_at FROM mission_flow_links l JOIN missions m ON m.id=l.mission_id WHERE l.flow_id=f.id) linked),'[]'::jsonb) AS "missionLinks",
              fr.revision AS "latestRevision",
              fr.content AS "latestContent", fr.plan AS "latestPlan",
              f.created_at AS "createdAt", f.updated_at AS "updatedAt"
       FROM flows f JOIN flow_revisions fr ON fr.id = f.latest_revision_id
       WHERE f.project_id=$1 AND ($2='all' OR f.visibility=$2) ORDER BY f.updated_at DESC`,
        [projectId, visibility],
      )
    ).rows;
  }
}
