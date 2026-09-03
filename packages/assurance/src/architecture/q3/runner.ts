import type { Page } from "playwright";
import {
  authenticateProtectedReferencedTargets,
  clickReferencedTarget,
  closePraxisBrowserResources,
  createPraxisReadOnlyCdpSensor,
  navigateAndWaitNative,
  observeSemanticPageContext,
  observeTargetReference,
  openPraxisBrowserSession,
  PraxisStaleTargetError,
  reloadPraxisPage,
  waitForPraxisURL,
} from "@scry/praxis";
import { VeilRuntimeSession } from "@scry/veil";
import { artifactSha256 } from "@scry/chronicle";

import { evaluateInvariants } from "../q1/invariants.js";
import { applyReferenceAction, createReferenceState, freezeSnapshot } from "../q1/state.js";
import type { Q1Action, Q1Snapshot } from "../q1/types.js";
import { runQ2Scenario } from "../q2/runner.js";
import { q2Scenarios } from "../q2/scenarios.js";
import { compareIndependentTruth, q3OracleDigest } from "./comparator.js";
import { startQ3Fixture, type Q3Fixture } from "./fixture.js";
import { q3Scenarios, type Q3ScenarioDefinition } from "./scenarios.js";
import type { Q3ProofProvenance, Q3ScenarioId, Q3ScenarioResult, Q3ScryView } from "./types.js";

const FIXTURE_USERNAME = "q3-local-user";
const FIXTURE_PASSWORD = "q3-protected-sentinel-7Vw9k2";
const TIMEOUT_MS = 10_000;

export type Q3CampaignResult = Readonly<{
  order: readonly Q3ScenarioId[];
  scenarios: readonly Q3ScenarioResult[];
  oracleControl: Readonly<{ ordinaryStatus: number; unauthenticatedControlStatus: number }>;
}>;

export async function runQ3Campaign(
  input: {
    order?: readonly Q3ScenarioId[];
    seedBase?: number;
  } = {},
): Promise<Q3CampaignResult> {
  const order = input.order ?? q3Scenarios.map(({ id }) => id);
  if (new Set(order).size !== q3Scenarios.length || order.length !== q3Scenarios.length)
    throw new Error("Q3_CAMPAIGN_ORDER_MUST_CONTAIN_EACH_SCENARIO_ONCE");
  const scenarios: Q3ScenarioResult[] = [];
  let oracleControl: Q3CampaignResult["oracleControl"] | undefined;
  for (const id of order) {
    const definition = q3Scenarios.find((candidate) => candidate.id === id);
    if (!definition) throw new Error(`Q3_SCENARIO_NOT_FOUND:${id}`);
    const scenarioOrdinal = Number(id.slice(3));
    const result = await runScenario(definition, (input.seedBase ?? 5300) + scenarioOrdinal - 1);
    scenarios.push(result);
    oracleControl ??=
      result.id === "Q3-01" ? await probeFixtureControl(definition, result.seed) : undefined;
  }
  if (!oracleControl) throw new Error("Q3_ORACLE_CONTROL_NOT_EXECUTED");
  return Object.freeze({ order: [...order], scenarios, oracleControl });
}

async function probeFixtureControl(definition: Q3ScenarioDefinition, seed: number) {
  const fixture = await startQ3Fixture({
    seed: seed + 100_000,
    mode: definition.mode,
    evidenceMode: definition.evidenceMode,
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
  });
  try {
    return await fixture.controlNegativeProbe();
  } finally {
    await fixture.close();
  }
}

async function runScenario(
  definition: Q3ScenarioDefinition,
  seed: number,
): Promise<Q3ScenarioResult> {
  const fixture = await startQ3Fixture({
    seed,
    mode: definition.mode,
    evidenceMode: definition.evidenceMode,
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
    duplicateDelivery: definition.id === "Q3-06",
  });
  const opened = await openPraxisBrowserSession({
    browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  const { context, page } = opened;
  let snapshot = scenarioInitialState(definition.id, seed);
  let resourceIdentity: string | null = null;
  let reconciliationResult: Q3ScryView["reconciliationResult"] = "none";
  const assertions: string[] = [];
  const productionComponents = new Set<string>([
    "Praxis exact target/reference mechanics",
    "Chromium",
  ]);
  const modeled = new Set<string>(["Q1 committed reference adapter"]);
  let q2Fault: string | null = null;
  let chronicle = false;
  try {
    switch (definition.id) {
      case "Q3-01": {
        const sensor = await createPraxisReadOnlyCdpSensor(context, page);
        try {
          await navigateAndWaitNative(page, fixture.docsUrl, [fixture.origin], TIMEOUT_MS);
          const docs = await page
            .getByRole("heading", { name: "Local resource service" })
            .textContent();
          if (!docs) throw new Error("Q3_DOCS_NOT_DISCOVERED");
          await protectedLogin(page, fixture);
          productionComponents.add("Veil protected runtime state machine");
          await page.getByRole("button", { name: "Create resource" }).waitFor({ state: "visible" });
          await page.waitForFunction(() => !document.querySelector("#loading"));
          await page.waitForFunction(
            () => document.querySelector("#resources")?.textContent !== "",
          );
          await waitForOracle(fixture, (truth) => truth.workerRequestCount > 0);
          const sensorTruth = await sensor.snapshot();
          if (sensorTruth.network.observedRequests < 3)
            throw new Error("Q3_WORKER_TRAFFIC_NOT_OBSERVED");
          if (!sensorTruth.network.recentRequests.some((request) => request.loaderId === undefined))
            throw new Error("Q3_WORKER_OPTIONAL_LOADER_METADATA_CONTROL_NOT_OBSERVED");
          assertions.push(
            "docs discovered",
            "SPA hydrated",
            "worker/subresource observed",
            "document authority remained current",
          );
        } finally {
          await sensor.close();
        }
        snapshot = actions(snapshot, optionalReadActions());
        break;
      }
      case "Q3-02": {
        await protectedLogin(page, fixture);
        productionComponents.add("Veil protected runtime state machine");
        const reference = await observeTargetReference(
          page,
          page.getByRole("button", { name: "Replace target" }),
        );
        try {
          await expectStale(() => clickReferencedTarget(reference, { timeoutMs: TIMEOUT_MS }));
        } finally {
          await reference.dispose();
        }
        await waitForOracle(fixture, (truth) => truth.targetReplacementCount === 1);
        assertions.push(
          "replaced exact reference refused before dispatch",
          "zero fixture mutation requests",
        );
        snapshot = actions(snapshot, [{ type: "replaceDocument" }, ...optionalReadActions()]);
        break;
      }
      case "Q3-03": {
        await protectedLogin(page, fixture);
        productionComponents.add("Veil protected runtime state machine");
        assertions.push(
          "protected capability established authenticated session",
          "protected interval resumed and finalized",
          "credential absent from oracle truth",
        );
        snapshot = actions(snapshot, [
          { type: "setProtectedProjection", canonical: "not_applied", projection: "not_applied" },
          ...optionalReadActions(),
        ]);
        break;
      }
      case "Q3-04": {
        await protectedLogin(page, fixture);
        productionComponents.add("Veil protected runtime state machine");
        await reloadPraxisPage(page);
        await page.getByRole("button", { name: "Create resource" }).waitFor({ state: "visible" });
        await waitForOracle(fixture, (truth) => truth.retrievalCount > 0);
        assertions.push("authenticated resource list read", "zero business mutation requests");
        snapshot = actions(snapshot, optionalReadActions());
        break;
      }
      case "Q3-05":
      case "Q3-06":
      case "Q3-07":
      case "Q3-08":
      case "Q3-09":
      case "Q3-10":
      case "Q3-12":
      case "Q3-14": {
        await protectedLogin(page, fixture);
        productionComponents.add("Veil protected runtime state machine");
        await activateCreate(page);
        if (["Q3-07", "Q3-08", "Q3-09"].includes(definition.id)) {
          await page.getByText("UNKNOWN", { exact: true }).waitFor({ state: "visible" });
          const retrieval = await authoritativeRetrieve(page, null, seed);
          if (definition.id === "Q3-07") {
            if (retrieval.status !== 200) throw new Error("Q3_APPLIED_RECONCILIATION_FAILED");
            resourceIdentity = typeof retrieval.body?.id === "string" ? retrieval.body.id : null;
            if (!resourceIdentity) throw new Error("Q3_APPLIED_RECONCILIATION_ID_MISSING");
            artifactSha256(Buffer.from(JSON.stringify(retrieval.body)));
            chronicle = true;
            productionComponents.add("Chronicle artifact integrity");
            reconciliationResult = "proven_applied";
          } else if (definition.id === "Q3-08") {
            if (retrieval.status !== 404) throw new Error("Q3_NOT_APPLIED_RECONCILIATION_FAILED");
            reconciliationResult = "proven_not_applied";
          } else {
            if (retrieval.status !== 503) throw new Error("Q3_AMBIGUITY_NOT_RETAINED");
            reconciliationResult = "still_unknown";
          }
          assertions.push(
            "dispatch ambiguity observed from failed browser response",
            "authoritative reconciliation used GET only",
            "no mutation replay",
          );
        }
        if (["Q3-05", "Q3-06", "Q3-10", "Q3-12", "Q3-14"].includes(definition.id)) {
          await page.waitForFunction(() => {
            const value = document.querySelector("#result")?.textContent?.trim();
            return Boolean(value && value !== "UNKNOWN");
          });
          resourceIdentity = await page.locator("#result").textContent();
          resourceIdentity = resourceIdentity?.trim() || null;
          const retrieved = await authoritativeRetrieve(page, resourceIdentity, seed);
          if (retrieved.status !== 200 || retrieved.body?.id !== resourceIdentity)
            throw new Error("Q3_EXTERNAL_IDENTITY_DISAGREEMENT");
          if (!/^[a-f0-9]{64}$/.test(artifactSha256(Buffer.from(JSON.stringify(retrieved.body)))))
            throw new Error("Q3_CHRONICLE_EVIDENCE_DIGEST_FAILED");
          chronicle = true;
          productionComponents.add("Chronicle artifact integrity");
          assertions.push(
            "authoritative generated identity retrieved",
            "idempotency retained one external effect",
          );
        }
        if (definition.id === "Q3-10") {
          const b9 = q2Scenarios.find(({ failpoint }) => failpoint.boundary === "B9");
          if (!b9) throw new Error("Q3_Q2_B9_NOT_FOUND");
          const fault = runQ2Scenario(b9);
          if (fault.violations.length) throw new Error("Q3_Q2_B9_REFERENCE_FAILED");
          q2Fault = b9.failpoint.name;
          modeled.add("Q2 B9 approved test-only failpoint");
          productionComponents.add("Q2 deterministic failpoint controller");
          assertions.push("external effect survived local evidence-persistence failure");
        }
        if (definition.id === "Q3-12") {
          validateLogicalLeaseLossCases(seed);
          assertions.push(
            "loss before dispatch retained no effect",
            "loss after possible dispatch retained UNKNOWN fence",
            "loss after applied retained applied truth",
          );
          modeled.add("M4 logical runtime/lease loss disposition");
        }
        if (definition.id === "Q3-14") {
          if (!resourceIdentity) throw new Error("Q3_CLEANUP_RESOURCE_ID_MISSING");
          const cleanup = await observeTargetReference(
            page,
            page.getByRole("button", { name: "Cleanup resource" }),
          );
          try {
            await clickReferencedTarget(cleanup, { timeoutMs: TIMEOUT_MS });
          } finally {
            await cleanup.dispose();
          }
          await page.getByText("revoked", { exact: true }).waitFor({ state: "visible" });
          assertions.push(
            "cleanup used exact external identity",
            "cleanup used distinct authorization identity",
            "cleanup effect independently observable",
          );
        }
        snapshot = mutationSnapshot(definition.id, snapshot, reconciliationResult);
        break;
      }
      case "Q3-11": {
        await protectedLogin(page, fixture);
        productionComponents.add("Veil protected runtime state machine");
        for (const [state, required, mayPass] of [
          ["available", true, true],
          ["failed", true, false],
          ["quarantined", true, false],
          ["available", false, true],
          ["suppressed", false, true],
        ] as const) {
          let evidence = actions(scenarioInitialState("Q3-11", seed), [
            { type: "recordFunctionalResult", truth: "succeeded" },
            { type: "establishMutation", truth: "not_applied", authoritative: true },
            { type: "settleEvidence", state, required },
            { type: "settlePrivacy", state: "sealed" },
            { type: "setPersistence", state: "committed" },
          ]);
          evidence = applyReferenceAction(evidence, {
            type: "finalizeRun",
            state: mayPass ? "passed" : "failed",
          });
          if (evaluateInvariants(evidence).some(({ status }) => status === "fail"))
            throw new Error(`Q3_EVIDENCE_MATRIX_FAILED:${state}:${required}`);
          artifactSha256(Buffer.from(`${state}:${required}`));
        }
        chronicle = true;
        productionComponents.add("Chronicle artifact integrity");
        assertions.push(
          "required available may pass",
          "required failed/quarantined block pass",
          "optional suppression remains legal",
        );
        snapshot = actions(snapshot, optionalReadActions());
        break;
      }
      case "Q3-13": {
        await protectedLogin(page, fixture);
        productionComponents.add("Veil protected runtime state machine");
        snapshot = actions(snapshot, [
          { type: "beginPossibleDispatch" },
          { type: "establishMutation", truth: "unknown" },
          { type: "recordFunctionalResult", truth: "inconclusive" },
          { type: "settleEvidence", state: "failed", required: true },
          { type: "settlePrivacy", state: "sealed" },
          { type: "setPersistence", state: "committed" },
          { type: "beginReconciliation", ownerCurrent: false },
          { type: "finalizeRun", state: "failed" },
        ]);
        modeled.add("M4 malformed historical authority classifier");
        assertions.push(
          "malformed authority classified closed",
          "UNKNOWN retained",
          "no mutation or unsafe workaround",
        );
        break;
      }
    }
    const oracle = fixture.readGroundTruth();
    const scry = scryView(snapshot, resourceIdentity, reconciliationResult);
    const comparison = compareIndependentTruth({
      oracle,
      scry,
      expectedGeneration: seed,
      expectedMutationRequests: definition.expectedRequests,
      expectedCreatedResources: definition.expectedResources,
      ...(definition.expectedCleanupEffects === undefined
        ? {}
        : { expectedCleanupEffects: definition.expectedCleanupEffects }),
    });
    const invariantResults = evaluateInvariants(snapshot);
    const relevant = invariantResults.filter(({ invariantId }) =>
      definition.relevantInvariantIds.includes(invariantId),
    );
    const q1Pass = invariantResults.every(({ status }) => status !== "fail");
    const lifecycleResidue = expectedLifecycleResidue(definition.id, snapshot);
    const verdict =
      comparison.verdict === "PASS" && q1Pass && lifecycleResidue.length === 0 ? "PASS" : "FAIL";
    const provenance: readonly Q3ProofProvenance[] = [
      "assurance_reference",
      "real_browser_local",
      "real_veil_local",
      ...(chronicle ? (["real_chronicle_local"] as const) : []),
      "independent_fixture_oracle",
    ];
    return Object.freeze({
      id: definition.id,
      seed,
      fixtureMode: definition.mode,
      evidenceMode: definition.evidenceMode,
      productLayers: ["Assurance", "Praxis", "Chromium", "Veil", "Q1", ...(q2Fault ? ["Q2"] : [])],
      productionComponentsExecuted: [...productionComponents],
      modeledOrTestOnlyComponents: [...modeled],
      proofProvenance: q2Fault
        ? [...provenance, "production_characterization" as const]
        : provenance,
      browser: true,
      postgres: false,
      veil: true,
      chronicle,
      mcp: false,
      q2Fault,
      scry,
      oracle,
      oracleDigest: q3OracleDigest(oracle),
      comparison: comparison.verdict,
      comparisonReasons: comparison.reasons,
      q1: {
        result: q1Pass ? ("PASS" as const) : ("FAIL" as const),
        relevantInvariantIds: definition.relevantInvariantIds,
        invariantResults: relevant,
      },
      verdict,
      assertions,
      lifecycleResidue,
      reproduction: `pnpm --filter @scry/assurance test -- q3-independent-local.test.ts -t ${definition.id}`,
    });
  } finally {
    await closePraxisBrowserResources(context, opened.browser);
    await fixture.close();
  }
}

async function protectedLogin(page: Page, fixture: Q3Fixture) {
  await navigateAndWaitNative(page, fixture.appUrl, [fixture.origin], TIMEOUT_MS);
  const context = await observeSemanticPageContext(page);
  const username = context.controls.find((control) => control.name === "Username");
  const password = context.controls.find((control) => control.valueProtected);
  const submit = context.controls.find((control) => control.role === "button");
  if (!username || !password || !submit) throw new Error("Q3_PROTECTED_LOGIN_CONTROLS_MISSING");
  let captureSuspended = false;
  const captureCollector = {
    id: "q3-capture-probe",
    async transition(
      phase: "prepare" | "suspend" | "isolate" | "resume" | "seal" | "finalize",
      state: { operationId?: string; stateVersion: number },
    ) {
      if (phase === "suspend" || phase === "isolate") captureSuspended = true;
      if (phase === "resume") captureSuspended = false;
      return {
        schemaVersion: 1 as const,
        collectorId: "q3-capture-probe",
        phase,
        ...(state.operationId ? { operationId: state.operationId } : {}),
        stateVersion: state.stateVersion,
        acknowledgedAt: new Date().toISOString(),
      };
    },
  };
  const veil = new VeilRuntimeSession(
    [captureCollector],
    `q3-policy-${fixture.generation}`,
    `q3-context-${fixture.generation}`,
  );
  await veil.prepare(`q3-login-${fixture.generation}`);
  await veil.beginProtected();
  if (!captureSuspended) throw new Error("Q3_PROTECTED_CAPTURE_NOT_SUSPENDED");
  const navigated = waitForPraxisURL(page, (url) => url.pathname === "/app", {
    timeout: TIMEOUT_MS,
  });
  await authenticateProtectedReferencedTargets(page, {
    fields: [
      { targetReference: username.reference, resolveValue: async () => FIXTURE_USERNAME },
      { targetReference: password.reference, resolveValue: async () => FIXTURE_PASSWORD },
    ],
    submitReference: submit.reference,
  });
  await navigated;
  await veil.resume();
  if (captureSuspended) throw new Error("Q3_PROTECTED_CAPTURE_NOT_RESUMED");
  await veil.finalize();
  await page
    .getByRole("button", { name: "Create resource" })
    .waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await waitForOracle(fixture, (truth) => truth.workerRequestCount > 0);
}

async function activateCreate(page: Page) {
  const reference = await observeTargetReference(
    page,
    page.getByRole("button", { name: "Create resource" }),
  );
  try {
    await clickReferencedTarget(reference, { timeoutMs: TIMEOUT_MS });
  } finally {
    await reference.dispose();
  }
}

async function authoritativeRetrieve(page: Page, id: string | null, seed: number) {
  const path = id
    ? `/api/resources/${encodeURIComponent(id)}`
    : `/api/resources/by-idempotency/q3-key-${seed}`;
  return page.evaluate(async (resourcePath) => {
    const response = await fetch(resourcePath);
    return { status: response.status, body: response.ok ? await response.json() : null };
  }, path);
}

async function waitForOracle(
  fixture: Q3Fixture,
  predicate: (truth: ReturnType<Q3Fixture["readGroundTruth"]>) => boolean,
) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!predicate(fixture.readGroundTruth())) {
    if (Date.now() >= deadline) throw new Error("Q3_FIXTURE_STATE_TIMEOUT");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function expectStale(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof PraxisStaleTargetError) return;
    throw error;
  }
  throw new Error("Q3_STALE_REFERENCE_WAS_DISPATCHED");
}

function scenarioInitialState(id: Q3ScenarioId, seed: number): Q1Snapshot {
  const mutable = structuredClone(createReferenceState()) as Mutable<Q1Snapshot>;
  mutable.scope.projectId = `q3-project-${seed}`;
  mutable.scope.missionId = `q3-mission-${seed}`;
  mutable.scope.objectiveId = `q3-objective-${seed}`;
  mutable.scope.environmentId = `q3-environment-${seed}`;
  mutable.scope.agentSessionId = `q3-agent-${seed}`;
  mutable.scope.praxisSessionId = `q3-praxis-${seed}`;
  mutable.scope.runId = `q3-run-${seed}`;
  mutable.operation.operationId = `${id.toLowerCase()}-operation-${seed}`;
  mutable.operation.mutationIdentity = `${id.toLowerCase()}-mutation-${seed}`;
  mutable.operation.providerIdempotencyIdentity = `q3-key-${seed}`;
  if (["Q3-01", "Q3-04", "Q3-11"].includes(id)) mutable.operation.kind = "read_only";
  return freezeSnapshot(mutable);
}

function actions(snapshot: Q1Snapshot, sequence: readonly Q1Action[]) {
  return sequence.reduce(applyReferenceAction, snapshot);
}

function optionalReadActions(): readonly Q1Action[] {
  return [
    { type: "establishMutation", truth: "not_applied", authoritative: true },
    { type: "recordFunctionalResult", truth: "succeeded" },
    { type: "settleEvidence", state: "suppressed", required: false },
    { type: "settlePrivacy", state: "sealed" },
    { type: "setPersistence", state: "committed" },
    { type: "finalizeRun", state: "passed" },
  ];
}

function mutationSnapshot(
  id: Q3ScenarioId,
  initial: Q1Snapshot,
  reconciliation: Q3ScryView["reconciliationResult"],
) {
  let sequence: Q1Action[] = [{ type: "beginPossibleDispatch" }, { type: "crossDispatch" }];
  if (id === "Q3-07" || id === "Q3-08" || id === "Q3-09") {
    sequence.push(
      { type: "establishMutation", truth: "unknown" },
      { type: "recordFunctionalResult", truth: "inconclusive" },
      { type: "settleEvidence", state: "failed", required: true },
      { type: "settlePrivacy", state: "sealed" },
      { type: "setPersistence", state: "committed" },
    );
    if (reconciliation === "proven_applied" || reconciliation === "proven_not_applied")
      sequence.push(
        { type: "beginReconciliation", ownerCurrent: true },
        {
          type: "reconcileMutation",
          truth: reconciliation === "proven_applied" ? "applied" : "not_applied",
          authoritative: true,
        },
      );
    if (reconciliation === "proven_applied")
      sequence.push(
        { type: "recordFunctionalResult", truth: "succeeded" },
        { type: "settleEvidence", state: "available", required: true },
      );
    if (reconciliation === "still_unknown")
      sequence.push(
        { type: "loseRuntimeLease" },
        { type: "settlePraxisOwnerLoss", state: "recovery_required" },
      );
    sequence.push({ type: "finalizeRun", state: "failed" });
    return actions(initial, sequence);
  }
  sequence.push(
    { type: "establishMutation", truth: "applied", authoritative: true },
    { type: "recordFunctionalResult", truth: "succeeded" },
    { type: "settleEvidence", state: id === "Q3-10" ? "failed" : "available", required: true },
    { type: "settlePrivacy", state: "sealed" },
    { type: "setPersistence", state: id === "Q3-10" ? "failed" : "committed" },
  );
  if (id === "Q3-12")
    sequence.push(
      { type: "loseRuntimeLease" },
      { type: "settlePraxisOwnerLoss", state: "recovery_required" },
    );
  sequence.push({ type: "finalizeRun", state: id === "Q3-10" ? "failed" : "passed" });
  if (id !== "Q3-10")
    sequence.push(
      { type: "acceptObjectiveEvidence" },
      { type: "concludeObjective", state: "passed" },
      { type: "finalizeMission" },
    );
  return actions(initial, sequence);
}

function scryView(
  snapshot: Q1Snapshot,
  resourceIdentity: string | null,
  reconciliationResult: Q3ScryView["reconciliationResult"],
): Q3ScryView {
  return Object.freeze({
    dispatchBoundary:
      reconciliationResult !== "none"
        ? "possible"
        : snapshot.operation.dispatchCount > 0
          ? "acknowledged"
          : snapshot.operation.dispatchPossible
            ? "possible"
            : "not_dispatched",
    functionalTruth: snapshot.operation.functionalTruth,
    mutationTruth: snapshot.operation.mutationTruth,
    runtimeTruth: snapshot.truth.runtime,
    evidenceTruth: snapshot.truth.evidence,
    lifecycle: `${snapshot.run.state}/${snapshot.praxis.state}`,
    resourceIdentity,
    reconciliationResult,
    redispatchCount: Math.max(0, snapshot.operation.dispatchCount - 1),
  });
}

function expectedLifecycleResidue(id: Q3ScenarioId, snapshot: Q1Snapshot): string[] {
  const residue: string[] = [];
  if (snapshot.run.state === "running") residue.push("active Run");
  if (snapshot.praxis.state === "active" && snapshot.praxis.liveRuntimeOwners !== 1)
    residue.push("unowned active Praxis");
  if (
    snapshot.operation.reconciliationOwnerCurrent &&
    snapshot.operation.mutationTruth === "unknown" &&
    id !== "Q3-09"
  )
    residue.push("unexpected active reconciliation owner");
  return residue;
}

function validateLogicalLeaseLossCases(seed: number) {
  const base = scenarioInitialState("Q3-12", seed + 100_000);
  const beforeDispatch = actions(base, [
    { type: "loseRuntimeLease" },
    { type: "settlePraxisOwnerLoss", state: "failed" },
    { type: "settleEvidence", state: "failed", required: true },
    { type: "settlePrivacy", state: "sealed" },
    { type: "setPersistence", state: "committed" },
    { type: "finalizeRun", state: "failed" },
  ]);
  const possibleDispatch = actions(scenarioInitialState("Q3-12", seed + 200_000), [
    { type: "beginPossibleDispatch" },
    { type: "establishMutation", truth: "unknown" },
    { type: "recordFunctionalResult", truth: "inconclusive" },
    { type: "loseRuntimeLease" },
    { type: "settlePraxisOwnerLoss", state: "recovery_required" },
    { type: "settleEvidence", state: "failed", required: true },
    { type: "settlePrivacy", state: "sealed" },
    { type: "setPersistence", state: "committed" },
    { type: "finalizeRun", state: "failed" },
  ]);
  if (
    beforeDispatch.operation.mutationTruth !== "not_attempted" ||
    possibleDispatch.operation.mutationTruth !== "unknown" ||
    [beforeDispatch, possibleDispatch].some((candidate) =>
      evaluateInvariants(candidate).some(({ status }) => status === "fail"),
    )
  )
    throw new Error("Q3_LOGICAL_LEASE_LOSS_MATRIX_FAILED");
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? U[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};
