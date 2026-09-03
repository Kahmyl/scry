import { pathToFileURL } from "node:url";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "../src/app.module.js";
import { VitractCredentialIssuancePreparationService } from "../src/adaptive-sessions/index.js";
import { Database } from "../src/infrastructure/index.js";
import { MissionService } from "../src/missions/index.js";
import { OrchestrationService } from "../src/orchestration/index.js";

export async function main() {
  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const database = application.get(Database);
    const preparation = application.get(VitractCredentialIssuancePreparationService);
    const missions = application.get(MissionService);
    const orchestration = application.get(OrchestrationService);
    const scope = await canonicalOperatorScope(database);
    const principal = {
      kind: "user" as const,
      subject: scope.userId,
      userId: scope.userId,
      email: scope.email,
      workspaceId: scope.workspaceId,
      role: scope.role,
    };
    const input = {
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      loginEmailReferenceId: requiredUuid("SCRY_VITRACT_LOGIN_EMAIL_REFERENCE_ID"),
      loginPasswordReferenceId: requiredUuid("SCRY_VITRACT_LOGIN_PASSWORD_REFERENCE_ID"),
      applicationResourceScope: required("SCRY_VITRACT_APPLICATION_RESOURCE_SCOPE"),
      credentialName: required("SCRY_VITRACT_CREDENTIAL_NAME"),
      idempotencyKey: required("SCRY_VITRACT_ISSUANCE_IDEMPOTENCY_KEY"),
      distinctMissionReason: "The operator requested a new credential-issuance setup operation.",
      distinctMissionAuthority: {
        confirmedUserAuthorized: true as const,
        selection: "start_distinct_mission" as const,
        source: "current_request_explicit" as const,
      },
    };
    const lifecycle = await preparation.createLifecycle(principal, input);
    try {
      await preparation.prepareObservedSurface(principal, { lifecycle, ...input });
      const reserved = await preparation.reserveObserved(principal, {
        lifecycle,
        credentialName: input.credentialName,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
      process.stdout.write(
        `${JSON.stringify({
          status: "execution_ready",
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          missionId: lifecycle.missionId,
          objectiveId: lifecycle.objectiveId,
          agentSessionId: lifecycle.agentSessionId,
          flowDraftId: lifecycle.flowDraftId,
          praxisSessionId: lifecycle.authoringSessionId,
          protectedOperationId: reserved.protectedOperationId,
          publicOperationId: reserved.publicOperationId,
          contractDigest: reserved.contractDigest,
          expiresAt: reserved.expiresAt,
        })}\n`,
      );
      if (!process.argv.includes("--execute-live") || process.argv.includes("--prepare-only")) {
        await preparation.closePrepared(
          principal,
          lifecycle,
          `${input.idempotencyKey}-rehearsal-close`,
        );
        await settleGeneratedMission(principal, missions, orchestration, lifecycle);
        process.stdout.write("PRODUCTION_LIVE_ISSUANCE_PREPARATION_READY: YES\n");
        return;
      }
      const settled = await preparation.executePrepared(
        principal,
        lifecycle,
        reserved.immutableResume,
      );
      process.stdout.write(`${JSON.stringify(settled)}\n`);
    } catch (error) {
      await preparation
        .closePrepared(principal, lifecycle, `${input.idempotencyKey}-failure-close`)
        .catch(() => undefined);
      await settleGeneratedMission(principal, missions, orchestration, lifecycle).catch(
        () => undefined,
      );
      throw error;
    }
  } finally {
    await application.close();
  }
}

async function settleGeneratedMission(
  principal: Parameters<OrchestrationService["control"]>[0],
  missions: MissionService,
  orchestration: OrchestrationService,
  lifecycle: {
    missionId: string;
    agentSessionId: string;
  },
) {
  await orchestration.control(principal, lifecycle.missionId, "cancel", {
    missionId: lifecycle.missionId,
    agentSessionId: lifecycle.agentSessionId,
    reason: "Credential issuance preparation ended before external dispatch.",
  });
  await missions.endSession(principal, lifecycle.agentSessionId, { status: "completed" });
}

async function canonicalOperatorScope(database: Database) {
  const result = await database.query<{
    projectId: string;
    environmentId: string;
    workspaceId: string;
    userId: string;
    email: string;
    role: "owner" | "admin";
  }>(
    `SELECT designation.project_id::text AS "projectId",
            designation.environment_id::text AS "environmentId",
            project.workspace_id::text AS "workspaceId",membership.user_id::text AS "userId",
            app_user.email,membership.role
       FROM q5_canonical_scope_designations designation
       JOIN projects project ON project.id=designation.project_id
       JOIN workspace_memberships membership ON membership.workspace_id=project.workspace_id
         AND membership.role IN ('owner','admin')
       JOIN app_users app_user ON app_user.id=membership.user_id
      WHERE designation.qualification_key='m6-q5-authoritative'
      ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,membership.created_at
      LIMIT 2`,
  );
  if (result.rowCount !== 1) throw new Error("VITRACT_ISSUANCE_OPERATOR_SCOPE_AMBIGUOUS");
  return result.rows[0]!;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function requiredUuid(name: string) {
  const value = required(name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error(`${name}_INVALID`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error: unknown) => {
    const response =
      error &&
      typeof error === "object" &&
      "response" in error &&
      error.response &&
      typeof error.response === "object"
        ? error.response
        : undefined;
    const candidate =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : response && "code" in response && typeof response.code === "string"
          ? response.code
          : error instanceof Error
            ? error.message
            : "";
    const code = /^[A-Z][A-Z0-9_]+$/.test(candidate)
      ? candidate
      : "VITRACT_ISSUANCE_PREPARATION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
