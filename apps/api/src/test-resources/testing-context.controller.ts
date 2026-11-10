import { Body, Controller, Header, Inject, Post, NotFoundException } from "@nestjs/common";
import { testingContextRequestSchema, type TestingContextRequest } from "@scry/contracts";
import { performance } from "node:perf_hooks";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/auth.types.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";
import { Database } from "../infrastructure/database.js";
import { TestResourceProviders } from "./providers.js";
import { selectedBrowserAdapter } from "../browser-execution/browser-adapter-selection.js";

@Controller("api")
export class TestingContextController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(TestResourceProviders) private readonly providers: TestResourceProviders,
  ) {}

  @Post("testing-context")
  @Header("Cache-Control", "private, no-store")
  async context(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(testingContextRequestSchema)) input: TestingContextRequest,
  ) {
    const workspace = principal.kind === "user" ? principal.workspaceId : undefined;
    const end = performance.now() + 3000;
    const scope = await this.database.boundedTransaction(async (client) => {
      const project = (
        await client.query(
          "SELECT id,name FROM projects WHERE id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)",
          [input.projectId, workspace ?? null],
        )
      ).rows[0];
      if (!project) throw new NotFoundException("SCRY_BROWSER_PROJECT_NOT_FOUND");
      const mission = input.missionId
        ? (
            await client.query(
              "SELECT id,title,state FROM missions WHERE id=$1 AND project_id=$2",
              [input.missionId, input.projectId],
            )
          ).rows[0]
        : undefined;
      const environment = input.environmentId
        ? (
            await client.query(
              'SELECT id,name,state,base_origin AS "baseOrigin" FROM environments WHERE id=$1 AND project_id=$2',
              [input.environmentId, input.projectId],
            )
          ).rows[0]
        : undefined;
      return { project, mission, environment };
    }, 3000);
    // Optional metadata is independently bounded. Its failure cannot turn an
    // already-scoped independent browser task into a whole-context outage.
    const metadata = async (sql: string, values: unknown[]) => {
      const budget = Math.min(750, Math.floor(end - performance.now()));
      if (budget < 1) return { status: "unavailable" as const, rows: null };
      try {
        return {
          status: "available" as const,
          rows: await this.database.boundedTransaction(
            async (c) => (await c.query(sql, values)).rows,
            budget,
          ),
        };
      } catch {
        return { status: "unavailable" as const, rows: null };
      }
    };
    const [missions, environments, credentials, resources] = await Promise.all([
      metadata(
        "SELECT id,title,state FROM missions WHERE project_id=$1 ORDER BY updated_at DESC,id LIMIT 51",
        [input.projectId],
      ),
      metadata(
        'SELECT id,name,state,base_origin AS "baseOrigin",allowed_service_origins AS "allowedServiceOrigins" FROM environments WHERE project_id=$1 ORDER BY name,id LIMIT 51',
        [input.projectId],
      ),
      metadata(
        "SELECT id,display_name AS \"displayName\",state,(expires_at IS NOT NULL AND expires_at<=now()) AS expired FROM protected_values WHERE project_id=$1 AND source_kind='user_input' AND (mission_id IS NULL OR mission_id=$2) ORDER BY created_at DESC,id LIMIT 51",
        [input.projectId, input.missionId ?? null],
      ),
      metadata(
        `SELECT t.id,t.name,t.kind,t.state,t.expires_at AS "expiresAt",
        (t.ownership='scry' OR EXISTS(SELECT 1 FROM protected_values v WHERE v.id=t.password_credential_id AND v.state='active' AND (v.expires_at IS NULL OR v.expires_at>now()))) AS "credentialAvailable",
        EXISTS(SELECT 1 FROM test_resource_events e WHERE e.resource_id=t.id) AS "capturedMessagesAvailable"
        FROM test_resources t WHERE t.mission_id=$1 ORDER BY t.created_at DESC,t.id LIMIT 51`,
        [scope.mission?.id ?? null],
      ),
    ]);
    const configured = this.providers.capabilities(),
      native = selectedBrowserAdapter() === "playwright_mcp",
      enabled = process.env.SCRY_BROWSER_ENABLED === "true";
    const cached =
      resources.rows?.some((r) => r.kind === "mailbox" && r.capturedMessagesAvailable === true) ??
      false;
    const mailboxReady =
      cached ||
      (configured.mailbox &&
        (resources.rows?.some(
          (r) =>
            r.kind === "mailbox" &&
            r.state === "ready" &&
            r.credentialAvailable === true &&
            new Date(r.expiresAt).getTime() > Date.now(),
        ) ??
          false));
    const feature = (supported: boolean, configured: boolean, available = configured) => ({
      supported,
      configured,
      available,
    });
    const workflow = process.env.SCRY_BROWSER_WORKFLOW_V1_ENABLED === "true";
    const extended = process.env.SCRY_BROWSER_WORKFLOW_V2_ENABLED === "true";
    const canPrepare = principal.kind !== "user" || principal.role !== "viewer";
    const features = {
      browser: feature(true, enabled, enabled && canPrepare),
      mailboxRead: feature(
        true,
        configured.mailbox || cached,
        cached || (canPrepare && mailboxReady),
      ),
      protectedNavigation: feature(native, enabled && native, enabled && native && canPrepare),
      finalize: feature(true, enabled, enabled && canPrepare),
      release: feature(true, enabled, enabled && canPrepare),
      report: feature(true, enabled, enabled && canPrepare),
      journey: feature(true, enabled && workflow, enabled && workflow && canPrepare),
      sequence: feature(
        native,
        enabled && native && workflow,
        enabled && native && workflow && canPrepare,
      ),
      apiRequests: feature(
        native,
        enabled && native && extended,
        enabled && native && extended && canPrepare,
      ),
      downloadVerification: feature(
        native,
        enabled && native && extended,
        enabled && native && extended && canPrepare,
      ),
      viewportControl: feature(
        native,
        enabled && native && extended,
        enabled && native && extended && canPrepare,
      ),
    };
    const blocked: string[] = [];
    if (!scope.mission || !["planning", "running"].includes(scope.mission.state))
      blocked.push("active_mission_selection_required");
    if (!scope.environment || scope.environment.state !== "active")
      blocked.push("active_environment_selection_required");
    const required = new Set<string>(input.required);
    if (input.intent.kind === "change_access") {
      required.add("mailboxRead");
      required.add("protectedNavigation");
    }
    for (const name of required)
      if (!features[name as keyof typeof features]?.available) blocked.push(name);
    if (!canPrepare && [...required].some((name) => name !== "mailboxRead"))
      blocked.unshift("workspace_read_only");
    return {
      contractVersion: 1,
      project: scope.project,
      missions: missions.rows?.slice(0, 50) ?? null,
      environments: environments.rows?.slice(0, 50) ?? null,
      credentials: credentials.rows?.slice(0, 50) ?? null,
      resources: resources.rows?.slice(0, 50) ?? null,
      selected: { mission: scope.mission ?? null, environment: scope.environment ?? null },
      parts: Object.fromEntries(
        Object.entries({ missions, environments, credentials, resources }).map(([name, part]) => [
          name,
          { status: part.status },
        ]),
      ),
      hasMore: Object.fromEntries(
        Object.entries({ missions, environments, credentials, resources }).map(([name, part]) => [
          name,
          part.rows ? part.rows.length > 50 : null,
        ]),
      ),
      capabilities: { contractVersion: 1, features },
      ready: blocked.length === 0,
      blocked,
      hostToolExposure: "unknown",
      readinessSnapshotOnly: true,
    };
  }
}
