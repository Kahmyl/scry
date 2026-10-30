import { ChronicleRepository } from "@scry/chronicle";
import { Inject, Injectable } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import path from "node:path";
import { nativeEvidenceWarning, readNativePublication, readNativeMedia } from "@scry/chronicle";

import { Database } from "../../infrastructure/database.js";

@Injectable()
export class BrowserDashboardRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  private async nativePublication(workspaceId: string | undefined, runId: string) {
    const result = await this.database.query<{ objectKey: string; sessionId: string }>(
      `SELECT es.replay_artifact_key AS "objectKey",es.session_id AS "sessionId"
       FROM browser_evidence_streams es JOIN runs r ON r.id=es.run_id
       JOIN projects p ON p.id=r.project_id WHERE r.id=$1
       AND ($2::uuid IS NULL OR p.workspace_id=$2) AND es.sealed_at IS NOT NULL
       AND es.replay_artifact_key IS NOT NULL ORDER BY es.created_at DESC LIMIT 1`,
      [runId, workspaceId ?? null],
    );
    const publication = result.rows[0];
    if (!publication) return undefined;
    const root = path.resolve(process.env.SCRY_BROWSER_ARTIFACT_ROOT ?? "artifacts/browser");
    const sessionRoot = path.join(root, publication.sessionId);
    const media = await readNativePublication(publication.objectKey, sessionRoot);
    return { media, sessionRoot };
  }

  async listMedia(workspaceId: string | undefined, runId: string) {
    // Require the same Run/workspace visibility even when no recording exists.
    await this.getRun(workspaceId, runId);
    const publication = await this.nativePublication(workspaceId, runId);
    return {
      warning:
        nativeEvidenceWarning +
        (publication?.media.some((item) => item.masking === "unavailable")
          ? " Automatic masking was unavailable for part of this recording."
          : ""),
      playbackRate: 1,
      items: (publication?.media ?? []).map(({ kind, timestamp, label, durationMs }, index) => ({
        index,
        kind,
        timestamp,
        label,
        ...(durationMs === undefined ? {} : { durationMs }),
      })),
    };
  }

  async getMedia(workspaceId: string | undefined, runId: string, index: number) {
    const publication = await this.nativePublication(workspaceId, runId);
    const receipt = publication?.media[index];
    if (!publication || !receipt) throw new NotFoundException("Recording not found");
    return {
      bytes: await readNativeMedia(publication.sessionRoot, receipt),
      type: receipt.kind === "video" ? "video/webm" : "image/png",
    };
  }

  async listRuns(workspaceId: string | undefined, projectId: string) {
    return new ChronicleRepository(this.database).listRuns(workspaceId, projectId);
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
    if (!run.rows[0]) throw new Error("SCRY_BROWSER_RUN_NOT_FOUND");
    return { ...run.rows[0], ...(await new ChronicleRepository(this.database).runEvidence(runId)) };
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
              mr.state,mr.summary,mr.safe_report AS "safeReport",mr.evidence_coverage AS "evidenceCoverage",
              mr.evidence_digest AS "evidenceDigest",mr.created_at AS "createdAt",
              mr.finalized_at AS "finalizedAt"
       FROM mission_reports mr JOIN missions m ON m.id=mr.mission_id
       JOIN projects p ON p.id=m.project_id
       WHERE mr.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [reportId, workspaceId ?? null],
    );
    if (!result.rows[0]) throw new Error("SCRY_BROWSER_REPORT_NOT_FOUND");
    return result.rows[0];
  }
}
