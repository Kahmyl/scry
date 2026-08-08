import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { currentPlanSchema, type InteractionTargetIntent } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AuthenticationAttemptRepository,
  AuthenticationAuthoringService,
} from "../src/authentication-authoring/index.js";
import { AuthoringService } from "../src/authoring/index.js";
import { Database } from "../src/infrastructure/database.js";
import { RunAttemptRepository } from "../src/runtime/repositories/run-attempt.repository.js";

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
    expect(publication.compiledContractId).toBe(compilation.id);

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

  it("certifies a v1 compatibility compilation and exposes its run contract ID", async () => {
    const plan = currentPlanSchema.parse({
      name: "Inspect preview",
      objective: "Inspect preview",
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
      name: "Inspect preview compatibility flow",
      description: "",
      content: {
        objective: "Inspect preview",
        preconditions: [],
        expectedOutcomes: ["Preview opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-v1-certification-${randomUUID()}`,
    });
    const probe = randomUUID();
    await insertCompletedProbe(database, {
      probeId: probe,
      draftId: created.id!,
      mission,
      objective,
      environment,
      session,
      draftVersion: 1,
      result: {
        allResolved: true,
        runtimeHealthy: true,
        targets: [],
        readiness: [],
        diagnostics: [],
        pageFingerprint: "a".repeat(64),
      },
    });

    const previousCompilerFlag = process.env.SCRY_TRANSCRIPT_COMPILER_ENABLED;
    process.env.SCRY_TRANSCRIPT_COMPILER_ENABLED = "false";
    try {
      const result = await service.compileAndCertify(principal, created.id!, {
        ...context,
        environmentId: environment,
        draftVersion: 1,
        probeSessionId: probe,
        idempotencyKey: `compile-v1-certification-${randomUUID()}`,
        viewport: { width: 1280, height: 720 },
        seed: 1,
      });

      expect(result.compilation.contractVersion).toBe("v1-existing");
      expect(result.compiledContractId).toBe(result.compilation.id);
      expect(result.certification).toMatchObject({ status: "certification_pending" });
      if (!("certificationRunId" in result.certification)) {
        throw new Error("Certification Run was not queued");
      }
      const attempts = new RunAttemptRepository(database);
      const claimToken = randomUUID();
      const attempt = await attempts.claimAttempt(
        result.certification.certificationRunId,
        "v1-certification-worker",
        claimToken,
      );
      await attempts.markRunning(result.certification.certificationRunId, attempt!.id, claimToken);
      await attempts.markFinalizing(
        result.certification.certificationRunId,
        attempt!.id,
        claimToken,
      );
      await attempts.completeAttempt(
        result.certification.certificationRunId,
        attempt!.id,
        claimToken,
        "passed",
        "passed",
      );

      const publication = await service.publish(principal, created.id!, {
        ...context,
        expectedVersion: 1,
        compilationId: result.compiledContractId!,
        visibility: "mission_local",
        purpose: "primary",
        reason: "Certified v1 compatibility contract",
        idempotencyKey: `publish-v1-certification-${randomUUID()}`,
      });
      expect(publication.compiledContractId).toBe(result.compiledContractId);
    } finally {
      if (previousCompilerFlag === undefined) delete process.env.SCRY_TRANSCRIPT_COMPILER_ENABLED;
      else process.env.SCRY_TRANSCRIPT_COMPILER_ENABLED = previousCompilerFlag;
    }
  });

  it("keeps quality findings visible without blocking compilation", async () => {
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
      status: "execution_ready",
      diagnostics: [],
      blockers: [],
      warnings: [],
      qualityFindings: [diagnostic],
    });

    const draftState = await database.query(`SELECT state FROM flow_drafts WHERE id=$1`, [draftId]);

    expect(draftState.rows[0]!.state).toBe("publishable");
  });

  it("starts one interactive authoring session with budgets and a browser lease", async () => {
    const plan = currentPlanSchema.parse({
      name: "Explore preview",
      objective: "Explore the preview application",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: {
        maxActions: 7,
        maxDurationMs: 45_000,
        maxNavigations: 3,
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
      name: "Explore preview",
      description: "",
      content: {
        objective: "Explore the preview application",
        preconditions: [],
        expectedOutcomes: ["Authoring session starts"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-interactive-${randomUUID()}`,
    });

    await expect(
      service.startProbe(principal, created.id!, {
        ...context,
        objectiveId: randomUUID(),
        environmentId: environment,
        draftVersion: 1,
        mode: "queued",
        level: "inspection",
        disposableDataConfirmed: false,
        idempotencyKey: `probe-wrong-objective-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "AUTHORING_DRAFT_CONTEXT_MISMATCH",
      }),
      status: 409,
    });

    const probe = await service.startProbe(principal, created.id!, {
      ...context,
      environmentId: environment,
      draftVersion: 1,
      mode: "interactive",
      level: "inspection",
      disposableDataConfirmed: false,
      idempotencyKey: `probe-interactive-${randomUUID()}`,
    });

    expect(probe).toMatchObject({
      state: "queued",
      mode: "interactive",
      replayed: false,
      authoring: {
        status: "starting",
        documentEpoch: 0,
        actionsUsed: 0,
        actionBudget: 7,
        durationBudgetMs: "45000",
      },
      browserLease: {
        state: "provisioning",
      },
    });

    const persisted = await database.query<{
      mode: string;
      status: string;
      actionBudget: number;
      durationBudgetMs: string;
      leaseState: string;
      outboxCount: string;
      eventTypes: string[];
    }>(
      `SELECT
         p.mode,
         a.status,
         a.action_budget AS "actionBudget",
         a.duration_budget_ms::text AS "durationBudgetMs",
         l.state AS "leaseState",
         (
           SELECT count(*)::text
           FROM probe_outbox o
           WHERE o.probe_session_id=p.id
         ) AS "outboxCount",
         (
           SELECT array_agg(e.type ORDER BY e.sequence)
           FROM probe_events e
           WHERE e.probe_session_id=p.id
         ) AS "eventTypes"
       FROM probe_sessions p
       JOIN probe_authoring_sessions a
         ON a.probe_session_id=p.id
       JOIN authoring_browser_leases l
         ON l.id=a.browser_lease_id
       WHERE p.id=$1`,
      [probe.id],
    );

    expect(persisted.rows[0]).toMatchObject({
      mode: "interactive",
      status: "starting",
      actionBudget: 7,
      durationBudgetMs: "45000",
      leaseState: "provisioning",
      outboxCount: "0",
      eventTypes: ["authoring_session_started", "browser_lease_attached"],
    });

    await expect(
      service.startProbe(principal, created.id!, {
        ...context,
        environmentId: environment,
        draftVersion: 1,
        mode: "interactive",
        level: "inspection",
        disposableDataConfirmed: false,
        idempotencyKey: `probe-interactive-conflict-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "INTERACTIVE_PROBE_ALREADY_ACTIVE",
      }),
    });
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

  it("authors the Vitract login vertical through authentication, adaptive compilation, certification, and replay", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../../scripts/fixtures/vitract-login-baseline.json", import.meta.url),
        "utf8",
      ),
    );
    const vitractEnvironment = randomUUID();
    const probe = randomUUID();
    const lease = randomUUID();
    const ordersTarget = target("orders", "link", "Orders");

    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Vitract Preview','https://preview.vitract.com',$3::jsonb)`,
      [
        vitractEnvironment,
        project,
        JSON.stringify({
          allowedOrigins: ["https://preview.vitract.com"],
          allowPrivateNetwork: false,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 10,
          maxDurationMs: 120_000,
          maxNavigations: 3,
        }),
      ],
    );

    const plan = currentPlanSchema.parse({
      name: "Vitract partner orders",
      objective: "Authenticate to Vitract and open partner orders",
      preconditions: [],
      allowedOrigins: ["https://preview.vitract.com"],
      budgets: {
        maxActions: 4,
        maxDurationMs: 45_000,
        maxNavigations: 3,
      },
      checkpoints: [],
      steps: [
        {
          id: "open-login",
          title: "Open Vitract login",
          action: {
            type: "navigate",
            url: fixture.target.url,
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "open-menu",
          title: fixture.observedOutcome.failedStepTitle,
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
      environmentId: vitractEnvironment,
      name: "Vitract partner orders",
      description: "",
      content: {
        objective: "Authenticate to Vitract and open partner orders",
        preconditions: [],
        expectedOutcomes: ["Orders navigation succeeds"],
        prohibitedSideEffects: ["Do not retry credential submission"],
      },
      plan,
      idempotencyKey: `draft-vitract-${randomUUID()}`,
    });

    await insertCompletedProbe(database, {
      probeId: probe,
      draftId: created.id!,
      mission,
      objective,
      environment: vitractEnvironment,
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
            confidence: 0.96,
            confidenceMargin: 0.4,
            fingerprint: {
              role: "link",
              accessibleName: "Orders",
            },
            strategy: "dom",
          },
        ],
        readiness: [],
        diagnostics: [
          {
            code: "REDUNDANT_INTERACTION",
            severity: "info",
            message:
              "Open menu was unnecessary because desktop partner navigation was already visible.",
            source: fixture.characterization.actualLayout,
          },
        ],
        qualityFindings: [
          {
            code: "REDUNDANT_INTERACTION",
            stepId: "open-menu",
            reason: "expected_effect_already_satisfied",
            visibleNavigation: fixture.characterization.actualVisibleNavigation,
          },
        ],
        learnedContracts: [
          {
            schemaVersion: 1,
            interactionId: "vitract-open-orders",
            stepId: "open-orders",
            intent: { role: "link", accessibleName: "Orders" },
            operation: { type: "activate" },
            functionalResult: "passed",
            mutationOutcome: "applied",
            successfulEvidenceFamilies: ["accessibility", "structural", "effect"],
            scope: { origin: "https://preview.vitract.com" },
            relationships: [{ kind: "navigation", name: "Partner" }],
            capabilityProfile: { activate: true },
            expectedEffect: { type: "navigation", path: "/orders" },
            sanitizedFingerprint: { role: "link", accessibleName: "Orders" },
            qualityFindings: [],
            usedSelectorHint: false,
            unresolvedMutation: false,
            veilPolicyViolated: false,
            expectedEffectVerified: true,
            deterministic: true,
          },
        ],
        pageFingerprint: "c".repeat(64),
        authenticationFingerprint: "d".repeat(64),
      },
    });

    await database.query(
      `INSERT INTO authoring_browser_leases(
         id,
         probe_session_id,
         state,
         runtime_owner_id,
         heartbeat_at,
         expires_at
       )
       VALUES($1,$2,'active','vitract-authoring-runtime',now(),now()+interval '5 minutes')`,
      [lease, probe],
    );

    const authentication = new AuthenticationAuthoringService(
      new AuthenticationAttemptRepository(database),
    );
    const authContext = {
      probeSessionId: probe,
      applicationOrigin: "https://preview.vitract.com",
      entryUrl: fixture.target.url,
      usernameInspection: {
        candidates: [
          {
            target: authTarget("Vitract username field", "1"),
            confidence: 0.94,
            runnerUpMargin: 0.5,
            evidenceKinds: ["autocomplete_username", "type_email", "praxis_verified"],
          },
        ],
      },
      passwordInspection: {
        candidates: [
          {
            target: authTarget("Vitract password field", "2"),
            confidence: 0.95,
            runnerUpMargin: 0.5,
            evidenceKinds: ["type_password", "autocomplete_current_password", "praxis_verified"],
          },
        ],
      },
      submissionInspection: {
        candidates: [
          {
            kind: "native_submit" as const,
            target: authTarget("Vitract sign in", "3"),
            confidence: 0.92,
            evidenceKinds: ["form_relationship", "praxis_verified"],
          },
        ],
      },
      stateInspection: {
        signals: [
          "login_response_success" as const,
          "url_not_login" as const,
          "login_form_absent" as const,
          "authenticated_navigation_present" as const,
          "portal_shell_present" as const,
        ],
      },
    };

    const username = await authentication.discoverUsernameField(authContext);
    const password = await authentication.discoverPasswordField(authContext);
    const submission = await authentication.discoverSubmissionPath(authContext);
    const submissionResult = await authentication.submitCredentialsOnce(authContext);
    const authenticatedState = await authentication.detectAuthenticatedState(authContext);
    const candidate = await authentication.createAuthenticationContractCandidate({
      probeSessionId: probe,
      applicationOrigin: authContext.applicationOrigin,
      entryUrl: authContext.entryUrl,
      username,
      password,
      submission,
      submissionResult,
      authenticatedState,
      safeMetadata: {},
    });

    expect(submissionResult.status).toBe("submitted");
    expect(authenticatedState.status).toBe("authenticated");
    expect(authenticatedState.signals.length).toBeGreaterThanOrEqual(3);

    const authContract = await service.createAuthenticationContract(principal, {
      ...context,
      projectId: project,
      environmentId: vitractEnvironment,
      name: "Vitract partner login",
      applicationOrigin: candidate.applicationOrigin,
      entryUrl: candidate.entryUrl,
      usernameTarget: candidate.usernameTarget,
      passwordTarget: candidate.passwordTarget,
      submissionMethods: candidate.submissionMethods,
      selectedMethodIndex: candidate.selectedMethodIndex,
      success: candidate.success,
      failureSignals: candidate.failureSignals,
      sessionReuse: candidate.sessionReuse,
      idempotencyKey: `auth-contract-vitract-${randomUUID()}`,
    });

    const previousCompilerFlag = process.env.SCRY_TRANSCRIPT_COMPILER_ENABLED;
    process.env.SCRY_TRANSCRIPT_COMPILER_ENABLED = "true";
    const certifiedCompilation = await service.compileAndCertify(principal, created.id!, {
      ...context,
      environmentId: vitractEnvironment,
      draftVersion: 1,
      probeSessionId: probe,
      authenticationContractRevisionId: authContract.revisionId,
      idempotencyKey: `compile-vitract-${randomUUID()}`,
      viewport: { width: 1280, height: 720 },
      seed: 1,
    });
    if (previousCompilerFlag === undefined) delete process.env.SCRY_TRANSCRIPT_COMPILER_ENABLED;
    else process.env.SCRY_TRANSCRIPT_COMPILER_ENABLED = previousCompilerFlag;
    const compilation = certifiedCompilation.compilation;

    expect(certifiedCompilation.compiledContractId).toBe(compilation.id);

    expect(compilation).toMatchObject({
      status: "execution_ready",
      diagnostics: [
        {
          code: "REDUNDANT_INTERACTION",
          severity: "info",
          source: fixture.characterization.actualLayout,
        },
      ],
    });
    expect(certifiedCompilation.certification).toMatchObject({
      status: "certification_pending",
    });

    if (!("certificationRunId" in certifiedCompilation.certification)) {
      throw new Error("Certification Run was not queued");
    }
    const certificationRun = certifiedCompilation.certification.certificationRunId;
    await expect(
      service.publish(principal, created.id!, {
        ...context,
        expectedVersion: 1,
        compilationId: compilation.id!,
        visibility: "mission_local",
        purpose: "primary",
        reason: "Certification is still pending",
        idempotencyKey: `publish-pending-vitract-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ response: { code: "CERTIFICATION_RUN_REQUIRED" } });

    const attempts = new RunAttemptRepository(database);
    const claimToken = randomUUID();
    const attempt = await attempts.claimAttempt(
      certificationRun,
      "integration-certification-worker",
      claimToken,
    );
    await attempts.markRunning(certificationRun, attempt!.id, claimToken);
    await attempts.markFinalizing(certificationRun, attempt!.id, claimToken);
    await attempts.completeAttempt(certificationRun, attempt!.id, claimToken, "passed", "passed");

    const publication = await service.publish(principal, created.id!, {
      ...context,
      expectedVersion: 1,
      compilationId: compilation.id!,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Vitract authoring transcript certified",
      idempotencyKey: `publish-vitract-${randomUUID()}`,
    });

    expect(publication.compiledContractId).toBe(compilation.id);

    const revision = await database.query<{ plan: typeof plan }>(
      `SELECT plan
       FROM flow_revisions
       WHERE id=$1`,
      [publication.revisionId],
    );
    expect(revision.rows[0]!.plan.steps.map((step) => step.id)).toEqual([
      "open-login",
      "open-orders",
    ]);

    const compiled = await database.query<{
      compiledContractDigest: string;
      authenticationContractRevisionId: string;
    }>(
      `SELECT
         compiled_contract_digest AS "compiledContractDigest",
         authentication_contract_revision_id AS "authenticationContractRevisionId"
       FROM flow_compilations
       WHERE id=$1`,
      [compilation.id],
    );

    const replayRun = await insertPassedRun(database, {
      project,
      mission,
      objective,
      session,
      environment: vitractEnvironment,
      flowRevisionId: publication.revisionId,
      compiledContractId: compilation.id!,
      compiledContractDigest: compiled.rows[0]!.compiledContractDigest,
      plan: revision.rows[0]!.plan,
      idempotencyKey: `fresh-replay-${randomUUID()}`,
      role: "diagnostic",
      rerunOfRunId: certificationRun,
    });

    const counts = await database.query<{
      browserLeases: string;
      authenticationAttempts: string;
      submittedAttempts: string;
      contracts: string;
      passedRuns: string;
      secretArtifacts: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM authoring_browser_leases WHERE probe_session_id=$1)
           AS "browserLeases",
         (SELECT count(*)::text FROM authentication_attempts WHERE probe_session_id=$1)
           AS "authenticationAttempts",
         (SELECT count(*)::text FROM authentication_attempts
          WHERE probe_session_id=$1
            AND dispatch_state='dispatched'
            AND result_classification='submitted')
           AS "submittedAttempts",
         (SELECT count(*)::text FROM authentication_contract_revisions WHERE id=$2)
           AS "contracts",
         (SELECT count(*)::text FROM runs
          WHERE id=ANY($3::uuid[])
            AND state='passed'
            AND result_classification='application_pass'
            AND compiled_contract_id=$4)
           AS "passedRuns",
         (SELECT count(*)::text FROM authentication_attempts
          WHERE probe_session_id=$1
            AND safe_metadata::text ~* '(password|token|clipboard|secret|authorization)')
           AS "secretArtifacts"`,
      [probe, authContract.revisionId, [certificationRun, replayRun], compilation.id],
    );

    expect(counts.rows[0]).toEqual({
      browserLeases: "1",
      authenticationAttempts: "1",
      submittedAttempts: "1",
      contracts: "1",
      passedRuns: "2",
      secretArtifacts: "0",
    });
    expect(compiled.rows[0]!.authenticationContractRevisionId).toBe(authContract.revisionId);
    expect(JSON.stringify(candidate)).not.toMatch(/password=|token=|clipboard|selector|<html/i);
    expect(fixture.characterization.rootCause).toContain("sidebar was already visible");
    expect(fixture.observedOutcome.failureCode).toBe("TARGET_NOT_FOUND");
    expect(replayRun).not.toBe(certificationRun);
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

function authTarget(concept: string, suffix: string) {
  return {
    authority: "praxis" as const,
    fingerprint: `${suffix}`.repeat(64).slice(0, 64),
    concept,
    scopeKind: "document",
    capabilityDigest: `${Number(suffix) + 4}`.repeat(64).slice(0, 64),
  };
}

async function insertPassedRun(
  database: Database,
  input: {
    project: string;
    mission: string;
    objective: string;
    session: string;
    environment: string;
    flowRevisionId: string;
    compiledContractId: string;
    compiledContractDigest: string;
    plan: unknown;
    idempotencyKey: string;
    role: "candidate" | "diagnostic";
    rerunOfRunId?: string;
  },
) {
  const result = await database.query<{ id: string }>(
    `INSERT INTO runs(
       project_id,
       mission_id,
       objective_id,
       agent_session_id,
       environment_id,
       flow_revision_id,
       compiled_contract_id,
       compiled_contract_digest,
       state,
       phase,
       outcome_classification,
       result_classification,
       plan_snapshot,
       environment_snapshot,
       policy_snapshot,
       veil_policy_snapshot,
       execution_snapshot,
       rerun_of_run_id,
       idempotency_key
     )
     VALUES(
       $1,$2,$3,$4,$5,$6,$7,$8,
       'passed',
       'completed',
       'application_pass',
       'application_pass',
       $9::jsonb,
       $10::jsonb,
       $11::jsonb,
       $12::jsonb,
       $13::jsonb,
       $14,
       $15
     )
     RETURNING id`,
    [
      input.project,
      input.mission,
      input.objective,
      input.session,
      input.environment,
      input.flowRevisionId,
      input.compiledContractId,
      input.compiledContractDigest,
      JSON.stringify(input.plan),
      JSON.stringify({
        id: input.environment,
        baseOrigin: "https://preview.vitract.com",
      }),
      JSON.stringify({
        allowedOrigins: ["https://preview.vitract.com"],
        allowPrivateNetwork: false,
        allowDownloads: false,
        allowPopups: false,
        maxActions: 10,
        maxDurationMs: 120_000,
        maxNavigations: 3,
      }),
      JSON.stringify({ artifactRetention: "sanitized" }),
      JSON.stringify({
        browser: "chrome",
        viewport: { width: 1280, height: 720 },
        seed: 8,
      }),
      input.rerunOfRunId ?? null,
      input.idempotencyKey,
    ],
  );

  await database.query(
    `INSERT INTO mission_run_links(
       run_id,
       mission_id,
       objective_id,
       role,
       reason,
       classified_by_agent_session_id
     )
     VALUES($1,$2,$3,$4,'PR8 deterministic validation',$5)`,
    [result.rows[0]!.id, input.mission, input.objective, input.role, input.session],
  );

  return result.rows[0]!.id;
}
