import { randomUUID } from "node:crypto";

import { currentPlanSchema, type InteractionTargetIntent } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthoringService } from "../src/authoring/index.js";
import { Database } from "../src/infrastructure/database.js";

const enabled = Boolean(process.env.SCRY_AUTHORING_TEST_DATABASE_URL);

describe.skipIf(!enabled)("authoring, compilation, and publication boundary", () => {
  let database: Database;
  let service: AuthoringService;

  const project = randomUUID();
  const mission = randomUUID();
  const objective = randomUUID();
  const session = randomUUID();
  const environment = randomUUID();

  const principal = {
    kind: "service" as const,
    subject: "scry-service" as const,
  };

  const context = {
    missionId: mission,
    objectiveId: objective,
    agentSessionId: session,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;

    database = new Database();
    service = new AuthoringService(database, {
      assertAcceptingWork: async () => ({ ready: true }),
    } as never);

    await database.query(
      `INSERT INTO projects(id,workspace_id,name)
         VALUES($1,'00000000-0000-4000-8000-000000000001',$2)`,
      [project, `authoring-${project}`],
    );

    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
         VALUES($1,$2,'Preview','https://example.test',$3::jsonb)`,
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
      `INSERT INTO missions(id,project_id,title,original_instruction)
         VALUES($1,$2,'Authoring cutover','Verify authoring lifecycle')`,
      [mission, project],
    );

    await database.query(
      `INSERT INTO mission_objectives(
          id,
          mission_id,
          title,
          dependencies,
          completion_criteria,
          objective_order
        )
        VALUES(
          $1,
          $2,
          'Open application',
          '[]',
          '[{"description":"Page opens","required":true}]',
          0
        )`,
      [objective, mission],
    );

    await database.query(
      `INSERT INTO agent_sessions(
          id,
          mission_id,
          provider,
          instruction_snapshot,
          idempotency_key
        )
        VALUES($1,$2,'scry_agent','Authoring lifecycle',$3)`,
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
      budgets: {
        maxActions: 1,
        maxDurationMs: 10_000,
        maxNavigations: 1,
      },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: {
            type: "navigate",
            url: "https://example.test",
          },
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
      idempotencyKey: `draft-success-${randomUUID()}`,
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
            `SELECT count(*)
               FROM flow_revisions fr
               JOIN flows f ON f.id=fr.flow_id
               WHERE f.project_id=$1`,
            [project],
          )
        ).rows[0]!.count,
      ),
    ).toBe(0);

    const probe = randomUUID();

    await insertCompletedProbe(database, {
      probeId: probe,
      draftId,
      mission,
      objective,
      environment,
      session,
      draftVersion: 2,
      result: {
        allResolved: true,
        runtimeHealthy: true,
        targets: [],
        readiness: [],
        diagnostics: [],
        pageFingerprint: "a".repeat(64),
      },
    });

    const compilation = await service.compile(principal, draftId, {
      ...context,
      environmentId: environment,
      draftVersion: 2,
      probeSessionId: probe,
      idempotencyKey: `compile-success-${randomUUID()}`,
    });

    expect(compilation).toMatchObject({
      status: "execution_ready",
      diagnostics: [],
    });

    const publication = await service.publish(principal, draftId, {
      ...context,
      expectedVersion: 2,
      compilationId: compilation.id!,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Probe and compilation passed",
      idempotencyKey: `publish-${randomUUID()}`,
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
      response: expect.objectContaining({
        code: "FLOW_DRAFT_IMMUTABLE",
      }),
    });
  });

  it("keeps the draft in editing when a completed probe returns a diagnostic", async () => {
    const plan = currentPlanSchema.parse({
      name: "Open preview",
      objective: "Open preview",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: {
        maxActions: 1,
        maxDurationMs: 10_000,
        maxNavigations: 1,
      },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: {
            type: "navigate",
            url: "https://example.test",
          },
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
      name: "Open preview with diagnostic",
      description: "",
      content: {
        objective: "Open preview",
        preconditions: [],
        expectedOutcomes: ["Preview opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-diagnostic-${randomUUID()}`,
    });

    const draftId = created.id!;

    const updated = await service.updateDraft(principal, draftId, {
      ...context,
      expectedVersion: 1,
      description: "Compiled after one consolidated probe",
      reason: "Apply complete correction set",
    });

    expect(updated.version).toBe(2);

    const probe = randomUUID();

    const diagnostic = {
      code: "FIELD_HAS_NO_ASSOCIATED_LABEL",
      message: "Field has no associated label.",
    };

    await insertCompletedProbe(database, {
      probeId: probe,
      draftId,
      mission,
      objective,
      environment,
      session,
      draftVersion: 2,
      result: {
        allResolved: true,
        runtimeHealthy: true,
        targets: [],
        readiness: [],
        diagnostics: [diagnostic],
        pageFingerprint: "a".repeat(64),
      },
    });

    const compilation = await service.compile(principal, draftId, {
      ...context,
      environmentId: environment,
      draftVersion: 2,
      probeSessionId: probe,
      idempotencyKey: `compile-diagnostic-${randomUUID()}`,
    });

    expect(compilation).toMatchObject({
      status: "calibration_required",
      diagnostics: [diagnostic],
    });

    const draftState = await database.query(`SELECT state FROM flow_drafts WHERE id=$1`, [draftId]);

    expect(draftState.rows[0]!.state).toBe("editing");
  });

  it("publishes a compiled plan without probe-confirmed redundant steps", async () => {
    const ordersTarget = target("orders", "link", "Orders");

    const plan = currentPlanSchema.parse({
      name: "Open partner orders",
      objective: "Open the partner orders page",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: {
        maxActions: 3,
        maxDurationMs: 30_000,
        maxNavigations: 2,
      },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: {
            type: "navigate",
            url: "https://example.test",
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "open-menu",
          title: "Open partner navigation",
          action: {
            type: "click",
            target: target("open_menu", "button", "Open menu"),
            expectedEffect: {
              type: "visibility_change",
              target: ordersTarget,
              visible: true,
            },
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "open-orders",
          title: "Open orders",
          action: {
            type: "click",
            target: ordersTarget,
            expectedEffect: {
              type: "navigation",
              url: "/orders",
              match: "path",
            },
          },
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
      name: "Open partner orders",
      description: "",
      content: {
        objective: "Open the partner orders page",
        preconditions: [],
        expectedOutcomes: ["Orders page opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-redundant-${randomUUID()}`,
    });

    const draftId = created.id!;
    const probe = randomUUID();

    await insertCompletedProbe(database, {
      probeId: probe,
      draftId,
      mission,
      objective,
      environment,
      session,
      draftVersion: 1,
      result: {
        allResolved: true,
        runtimeHealthy: true,
        targets: [
          {
            stepId: "open-menu",
            channel: "action",
            status: "redundant",
            reason: "expected_effect_already_satisfied",
            expectedEffectTarget: {
              role: "link",
              accessibleName: "Orders",
            },
          },
          {
            stepId: "open-orders",
            channel: "action",
            status: "resolved",
            confidence: 1,
            confidenceMargin: 1,
            fingerprint: {
              role: "link",
              accessibleName: "Orders",
            },
            strategy: "dom",
          },
        ],
        readiness: [],
        diagnostics: [],
        pageFingerprint: "b".repeat(64),
      },
    });

    const compilation = await service.compile(principal, draftId, {
      ...context,
      environmentId: environment,
      draftVersion: 1,
      probeSessionId: probe,
      idempotencyKey: `compile-redundant-${randomUUID()}`,
    });

    expect(compilation).toMatchObject({
      status: "execution_ready",
      diagnostics: [],
    });

    const publication = await service.publish(principal, draftId, {
      ...context,
      expectedVersion: 1,
      compilationId: compilation.id!,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Remove probe-confirmed redundant navigation preparation",
      idempotencyKey: `publish-redundant-${randomUUID()}`,
    });

    const revision = await database.query<{ plan: typeof plan }>(
      `SELECT plan
         FROM flow_revisions
         WHERE id=$1`,
      [publication.revisionId],
    );

    expect(revision.rows[0]!.plan.steps.map((step) => step.id)).toEqual(["open", "open-orders"]);

    expect(revision.rows[0]!.plan.steps.some((step) => step.id === "open-menu")).toBe(false);
  });
});

async function insertCompletedProbe(
  database: Database,
  input: {
    probeId: string;
    draftId: string;
    mission: string;
    objective: string;
    environment: string;
    session: string;
    draftVersion: number;
    result: Record<string, unknown>;
  },
) {
  await database.query(
    `INSERT INTO probe_sessions(
      id,
      draft_id,
      mission_id,
      objective_id,
      environment_id,
      draft_version,
      level,
      state,
      created_by_agent_session_id,
      idempotency_key,
      result,
      completed_at
    )
    VALUES(
      $1,$2,$3,$4,$5,$6,'inspection','completed',$7,$8,$9::jsonb,now()
    )`,
    [
      input.probeId,
      input.draftId,
      input.mission,
      input.objective,
      input.environment,
      input.draftVersion,
      input.session,
      `probe-${input.probeId}`,
      JSON.stringify(input.result),
    ],
  );
}

type InteractionRole = InteractionTargetIntent["preferredEvidence"]["roles"][number];

function target(concept: string, role: InteractionRole, name: string): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities: ["pointer_activatable"],
    preferredEvidence: {
      roles: [role],
      names: [name],
      labels: [name],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: {
      kind: "page",
    },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "read_only",
    confidence: {
      requiredFamilies: [],
      minimum: 0.35,
      minimumMargin: 0,
      minimumFamilyCount: 1,
    },
  };
}
