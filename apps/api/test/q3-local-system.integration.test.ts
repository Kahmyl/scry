import { randomUUID } from "node:crypto";

import { chromium, type Browser } from "playwright";
import {
  authenticateProtectedReferencedTargets,
  clickReferencedTarget,
  observeSemanticPageContext,
  observeTargetReference,
} from "@scry/praxis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresQ1Adapter } from "../../../packages/assurance/src/architecture/q1/adapters.js";
import { evaluateInvariants } from "../../../packages/assurance/src/architecture/q1/invariants.js";
import { compareIndependentTruth } from "../../../packages/assurance/src/architecture/q3/comparator.js";
import {
  startQ3Fixture,
  type Q3Fixture,
} from "../../../packages/assurance/src/architecture/q3/fixture.js";
import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/index.js";

const databaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Q3 connected local product path", () => {
  let database: Database;
  let repository: AdaptiveSessionRepository;
  let fixture: Q3Fixture;
  let browser: Browser;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const operationId = "q3-connected-create";
  const username = "q3-connected-user";
  const password = "q3-connected-protected-4Mx8";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    fixture = await startQ3Fixture({
      seed: 5399,
      mode: "NORMAL",
      evidenceMode: "REQUIRED_AVAILABLE",
      username,
      password,
    });
    database = new Database();
    repository = new AdaptiveSessionRepository(database);
    browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'Q3 connected',$2)`, [
      workspaceId,
      `q3-${workspaceId}`,
    ]);
    await database.query(
      `INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Q3 connected')`,
      [projectId, workspaceId],
    );
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Q3 local',$3,$4::jsonb)`,
      [
        environmentId,
        projectId,
        fixture.origin,
        JSON.stringify({
          allowedOrigins: [fixture.origin],
          allowPrivateNetwork: true,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 5,
          maxDurationMs: 30_000,
          maxNavigations: 3,
        }),
      ],
    );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction,status)
       VALUES($1,$2,'Q3 connected','Create one local fixture resource','running')`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order)
       VALUES($1,$2,'Create one resource','[{"description":"one resource exists","required":true}]'::jsonb,0)`,
      [objectiveId, missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key)
       VALUES($1,$2,'scry_agent','Q3 deterministic harness',$3)`,
      [agentSessionId, missionId, `q3-agent-${agentSessionId}`],
    );
    await database.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,name,content,plan,
         created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,'Q3 connected','{}'::jsonb,'{}'::jsonb,$6)`,
      [flowDraftId, projectId, missionId, objectiveId, environmentId, agentSessionId],
    );
  });

  afterAll(async () => {
    await browser?.close();
    await fixture?.close();
    await database?.onModuleDestroy();
  });

  it("carries one public browser effect through the durable adaptive repository and Q1", async () => {
    const created = await repository.create(workspaceId, {
      projectId,
      missionId,
      objectiveId,
      agentSessionId,
      flowDraftId,
      environmentId,
      objective: "Create one local fixture resource",
      allowedOrigins: [fixture.origin],
      idempotencyKey: `q3-session-${randomUUID()}`,
      protection: "ordinary",
    });
    await repository.activateProvisionedSession(created.id);
    const ownerId = randomUUID();
    const lease = await repository.claimRuntimeLease({
      sessionId: created.id,
      ownerId,
      leaseDurationMs: 30_000,
    });
    await repository.beginOperation(workspaceId, created.id, {
      operationId,
      idempotencyKey: "q3-key-5399",
      action: {
        type: "click",
        target: {
          concept: "create resource",
          requiredCapabilities: ["pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Create resource"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            testIds: [],
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "ordinary",
          confidence: { requiredFamilies: [] },
          matching: "exact",
        },
        expectedEffect: { type: "none" },
        timeoutMs: 10_000,
      },
      expectedEffect: { type: "none" },
      mode: "transact",
      protectedInputReferences: [],
    });
    await repository.markOperationDispatching({
      sessionId: created.id,
      operationId,
      ownerId,
      fencingToken: lease.fencingToken,
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(fixture.appUrl);
      const observed = await observeSemanticPageContext(page);
      const user = observed.controls.find((control) => control.name === "Username")!;
      const secret = observed.controls.find((control) => control.valueProtected)!;
      const submit = observed.controls.find((control) => control.role === "button")!;
      await authenticateProtectedReferencedTargets(page, {
        fields: [
          { targetReference: user.reference, resolveValue: async () => username },
          { targetReference: secret.reference, resolveValue: async () => password },
        ],
        submitReference: submit.reference,
      });
      await page.getByRole("button", { name: "Create resource" }).waitFor({ state: "visible" });
      const create = await observeTargetReference(
        page,
        page.getByRole("button", { name: "Create resource" }),
      );
      try {
        await clickReferencedTarget(create);
      } finally {
        await create.dispose();
      }
      await page.waitForFunction(() => Boolean(document.querySelector("#result")?.textContent));
      const resourceId = (await page.locator("#result").textContent())!.trim();
      const retrieval = await page.evaluate(async (id) => {
        const response = await fetch(`/api/resources/${encodeURIComponent(id)}`);
        return { status: response.status, body: await response.json() };
      }, resourceId);
      expect(retrieval).toMatchObject({ status: 200, body: { id: resourceId } });

      await repository.settleOperation({
        sessionId: created.id,
        operationId,
        capabilityManifestDigest: "3".repeat(64),
        outcome: {
          operationId,
          functionalResult: "succeeded",
          mutationOutcome: "applied",
          privacyResult: "verified",
          evidenceResult: [{ channel: "report", state: "available" }],
          qualityFindings: [],
          durationMs: 1,
        },
        decisionBoundary: {
          type: "objective_completed",
          reasonCode: "Q3_RESOURCE_RETRIEVED",
          safeActions: [],
        },
      });

      const snapshot = await new PostgresQ1Adapter(database).acquire({
        missionId,
        objectiveId,
        praxisSessionId: created.id,
        operationId,
      });
      expect(snapshot.operation).toMatchObject({
        operationId,
        mutationTruth: "applied",
        functionalTruth: "succeeded",
        dispatchCount: 1,
        terminal: true,
      });
      expect(evaluateInvariants(snapshot).filter(({ status }) => status === "fail")).toEqual([]);
      const oracle = fixture.readGroundTruth();
      expect(
        compareIndependentTruth({
          oracle,
          expectedGeneration: 5399,
          expectedMutationRequests: 1,
          expectedCreatedResources: 1,
          scry: {
            dispatchBoundary: "acknowledged",
            functionalTruth: snapshot.operation.functionalTruth,
            mutationTruth: snapshot.operation.mutationTruth,
            runtimeTruth: snapshot.truth.runtime,
            evidenceTruth: "available",
            lifecycle: `${snapshot.run.state}/${snapshot.praxis.state}`,
            resourceIdentity: resourceId,
            reconciliationResult: "none",
            redispatchCount: 0,
          },
        }),
      ).toEqual({ verdict: "PASS", reasons: [] });
      expect(JSON.stringify({ snapshot, oracle })).not.toContain(password);
      expect(
        await repository.releaseRuntimeLease({
          sessionId: created.id,
          ownerId,
          fencingToken: lease.fencingToken,
        }),
      ).toBe(true);
      await repository.closeAtSafeBoundary({
        workspaceId,
        sessionId: created.id,
        idempotencyKey: `q3-close-${created.id}`,
      });
      await expect(
        database.query(
          `SELECT session.state,
                  COALESCE(lease.lease_expires_at>now(),false) AS "leaseValid",
                  EXISTS(SELECT 1 FROM adaptive_operation_reconciliations reconciliation
                    WHERE reconciliation.session_id=session.id AND reconciliation.state='observing') AS "activeReconciliation"
             FROM adaptive_sessions session
             LEFT JOIN adaptive_session_runtime_leases lease ON lease.session_id=session.id
            WHERE session.id=$1`,
          [created.id],
        ),
      ).resolves.toMatchObject({
        rows: [{ state: "completed", leaseValid: false, activeReconciliation: false }],
      });
    } finally {
      await context.close();
    }
  }, 30_000);
});
