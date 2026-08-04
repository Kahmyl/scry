import { randomUUID } from "node:crypto";
import { currentPlanSchema } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../src/infrastructure/database.js";
import { AuthoringService } from "../src/authoring/index.js";

const enabled = Boolean(process.env.SCRY_AUTHORING_TEST_DATABASE_URL);

describe.skipIf(!enabled)("authoring, compilation, and publication boundary", () => {
  let database: Database;
  let service: AuthoringService;
  const project = randomUUID(),
    mission = randomUUID(),
    objective = randomUUID(),
    session = randomUUID(),
    environment = randomUUID();
  const principal = { kind: "service" as const, subject: "scry-service" as const };
  const context = { missionId: mission, objectiveId: objective, agentSessionId: session };
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
    database = new Database();
    service = new AuthoringService(database, {
      assertAcceptingWork: async () => ({ ready: true }),
    } as never);
    await database.query(
      `INSERT INTO projects(id,workspace_id,name) VALUES($1,'00000000-0000-4000-8000-000000000001',$2)`,
      [project, `authoring-${project}`],
    );
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES($1,$2,'Preview','https://example.test',$3::jsonb)`,
      [
        environment,
        project,
        JSON.stringify({
          allowedOrigins: ["https://example.test"],
          allowPrivateNetwork: false,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 10,
          maxDurationMs: 120_000,
          maxNavigations: 3,
        }),
      ],
    );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction) VALUES($1,$2,'Authoring cutover','Verify authoring lifecycle')`,
      [mission, project],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,dependencies,completion_criteria,objective_order) VALUES($1,$2,'Open application','[]','[{"description":"Page opens","required":true}]',0)`,
      [objective, mission],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,'scry_agent','Authoring lifecycle',$3)`,
      [session, mission, `session-${session}`],
    );
  });
  afterAll(async () => database.onModuleDestroy());

  it("edits without revisions, compiles once, and publishes one immutable revision", async () => {
    const plan = currentPlanSchema.parse({
      name: "Open preview",
      objective: "Open preview",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: { maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: { type: "navigate", url: "https://example.test" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });
    const created = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: environment,
      name: "Open preview",
      description: "",
      content: {
        objective: "Open preview",
        preconditions: [],
        expectedOutcomes: ["Preview opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-${project}`,
    });
    const draftId = created.id!;
    const updated = await service.updateDraft(principal, draftId, {
      ...context,
      expectedVersion: 1,
      description: "Compiled after one consolidated probe",
      reason: "Apply complete correction set",
    });
    expect(updated.version).toBe(2);
    expect(
      Number(
        (
          await database.query(
            `SELECT count(*) FROM flow_revisions fr JOIN flows f ON f.id=fr.flow_id WHERE f.project_id=$1`,
            [project],
          )
        ).rows[0]!.count,
      ),
    ).toBe(0);
    const probe = randomUUID();
    await database.query(
      `INSERT INTO probe_sessions(id,draft_id,mission_id,objective_id,environment_id,draft_version,level,state,created_by_agent_session_id,idempotency_key,result,completed_at) VALUES($1,$2,$3,$4,$5,2,'inspection','completed',$6,$7,$8::jsonb,now())`,
      [
        probe,
        draftId,
        mission,
        objective,
        environment,
        session,
        `probe-${probe}`,
        JSON.stringify({
          allResolved: true,
          runtimeHealthy: true,
          targets: [],
          readiness: [],
          diagnostics: [],
          pageFingerprint: "a".repeat(64),
        }),
      ],
    );
    const compilation = await service.compile(principal, draftId, {
      ...context,
      environmentId: environment,
      draftVersion: 2,
      probeSessionId: probe,
      idempotencyKey: `compile-${project}`,
    });
    expect(compilation).toMatchObject({ status: "execution_ready", diagnostics: [] });
    const publication = await service.publish(principal, draftId, {
      ...context,
      expectedVersion: 2,
      compilationId: compilation.id!,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Probe and compilation passed",
      idempotencyKey: `publish-${project}`,
    });
    expect(publication.revision).toBe(1);
    expect(
      Number(
        (
          await database.query(`SELECT count(*) FROM flow_revisions WHERE id=$1`, [
            publication.revisionId,
          ])
        ).rows[0]!.count,
      ),
    ).toBe(1);
    await expect(
      service.updateDraft(principal, draftId, {
        ...context,
        expectedVersion: 2,
        description: "late edit",
        reason: "should fail",
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "FLOW_DRAFT_IMMUTABLE" }),
    });
  });
});
