import { Inject, Injectable } from "@nestjs/common";

import { Database } from "../../infrastructure/database.js";

@Injectable()
export class BrowserDashboardRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async listRuns(workspaceId: string | undefined, projectId: string) {
    const result = await this.database.query(
      `SELECT r.id,r.project_id AS "projectId",r.mission_id AS "missionId",
              r.objective_id AS "objectiveId",r.flow_id AS "flowId",f.name AS "flowName",
              r.state,r.outcome_classification AS "outcomeClassification",
              r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.completed_at AS "completedAt",
              e.name AS "environmentName",e.base_origin AS "baseOrigin",
              s.id AS "browserSessionId",s.state AS "browserSessionState",
              s.active_owner_generation AS "ownerGeneration",
              count(DISTINCT a.id)::integer AS "artifactCount",
              count(DISTINCT es.id) FILTER (WHERE es.state='complete')::integer AS "completeEvidenceStreams"
       FROM runs r
       JOIN projects p ON p.id=r.project_id
       JOIN flows f ON f.id=r.flow_id
       JOIN environments e ON e.id=r.environment_id
       LEFT JOIN browser_execution_sessions s ON s.run_id=r.id
       LEFT JOIN artifacts a ON a.run_id=r.id
       LEFT JOIN browser_evidence_streams es ON es.run_id=r.id
       WHERE r.project_id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)
       GROUP BY r.id,f.name,e.name,e.base_origin,s.id
       ORDER BY r.created_at DESC LIMIT 200`,
      [projectId, workspaceId ?? null],
    );
    return result.rows;
  }

  async getRun(workspaceId: string | undefined, runId: string) {
    const run = await this.database.query(
      `SELECT r.id,r.project_id AS "projectId",r.mission_id AS "missionId",
              r.objective_id AS "objectiveId",r.flow_id AS "flowId",f.name AS "flowName",
              f.purpose AS "flowPurpose",fr.definition AS "flowDefinition",
              r.state,r.outcome_classification AS "outcomeClassification",
              r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.started_at AS "startedAt",
              r.completed_at AS "completedAt",e.name AS "environmentName",e.base_origin AS "baseOrigin",
              s.id AS "browserSessionId",s.state AS "browserSessionState",
              s.active_owner_generation AS "ownerGeneration",
              s.authentication_commits_used AS "authenticationCommitsUsed",
              s.authentication_commit_limit AS "authenticationCommitLimit",
              s.business_commits_used AS "businessCommitsUsed",
              s.business_commit_limit AS "businessCommitLimit"
       FROM runs r JOIN projects p ON p.id=r.project_id JOIN flows f ON f.id=r.flow_id
       JOIN flow_revisions fr ON fr.id=r.flow_revision_id JOIN environments e ON e.id=r.environment_id
       LEFT JOIN browser_execution_sessions s ON s.run_id=r.id
       WHERE r.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [runId, workspaceId ?? null],
    );
    if (!run.rows[0]) throw new Error("BROWSER_V2_RUN_NOT_FOUND");
    const [effects, evidence, artifacts] = await Promise.all([
      this.database.query(
        `SELECT id,effect_class AS "effectClass",effect_ordinal AS "effectOrdinal",
                dispatch_state AS "dispatchState",capture_state AS "captureState",
                publication_state AS "publicationState",mutation_outcome AS "mutationOutcome",
                determination_source AS "reasonCode",admitted_at AS "createdAt",updated_at AS "updatedAt"
         FROM browser_effects WHERE run_id=$1 ORDER BY effect_class,effect_ordinal`,
        [runId],
      ),
      this.database.query(
        `SELECT id,state,chain_head AS "chainHead",chunk_count AS "chunkCount",
                total_bytes AS "totalBytes",retention_expires_at AS "retentionExpiresAt",
                completed_at AS "completedAt"
         FROM browser_evidence_streams WHERE run_id=$1 ORDER BY created_at`,
        [runId],
      ),
      this.database.query(
        `SELECT id,kind,digest,safe_metadata AS "safeMetadata",created_at AS "createdAt"
         FROM artifacts WHERE run_id=$1 ORDER BY created_at`,
        [runId],
      ),
    ]);
    return {
      ...run.rows[0],
      effects: effects.rows,
      evidence: evidence.rows,
      artifacts: artifacts.rows,
    };
  }

  async listReports(workspaceId: string | undefined, projectId: string) {
    const result = await this.database.query(
      `SELECT mr.id,mr.mission_id AS "missionId",m.title AS "missionTitle",mr.state,
              mr.summary,mr.evidence_digest AS "evidenceDigest",mr.created_at AS "createdAt",
              mr.finalized_at AS "finalizedAt"
       FROM mission_reports mr JOIN missions m ON m.id=mr.mission_id
       JOIN projects p ON p.id=m.project_id
       WHERE m.project_id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)
       ORDER BY mr.created_at DESC LIMIT 200`,
      [projectId, workspaceId ?? null],
    );
    return result.rows;
  }

  async getReport(workspaceId: string | undefined, reportId: string) {
    const result = await this.database.query(
      `SELECT mr.id,mr.mission_id AS "missionId",m.project_id AS "projectId",
              m.title AS "missionTitle",m.original_instruction AS "originalInstruction",
              mr.state,mr.summary,mr.safe_report AS "safeReport",
              mr.evidence_digest AS "evidenceDigest",mr.created_at AS "createdAt",
              mr.finalized_at AS "finalizedAt"
       FROM mission_reports mr JOIN missions m ON m.id=mr.mission_id
       JOIN projects p ON p.id=m.project_id
       WHERE mr.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [reportId, workspaceId ?? null],
    );
    if (!result.rows[0]) throw new Error("BROWSER_V2_REPORT_NOT_FOUND");
    return result.rows[0];
  }
}
