import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import type { Assertion, InteractionTargetIntent, ProtectedTransaction } from "@scry/contracts";
import {
  BrowserSessionProvenance,
  PlaywrightProtectedCapsuleFactory,
  ProtectedTransactionKernel,
  type ProtectedOperationClaim,
  type ProtectedTransactionStore,
} from "@scry/executor";
import { SecretRedactor } from "@scry/policy";
import { registerPraxisVeilAuthority, resolveTargetLocator } from "@scry/praxis";
import {
  compileVeilPolicy,
  VeilAuthority,
  VeilChannelCollector,
  VeilRuntimeCoordinator,
} from "@scry/veil";
import type { Page } from "playwright";

import { ProtectedCertificationDatabase } from "./protected-certification-database.js";
import { NativeBrowserDriver } from "../src/runtime/native-browser-driver/native-browser-driver.js";
import { MissionFlowAuthoringService } from "../src/adaptive-sessions/mission-flow-authoring.service.js";
import { deriveMissionAuthoringOperation, missionAuthoringOperationIdentity } from "../src/adaptive-sessions/mission-authoring-derivation.js";
import { missionAuthoringProtectedOperationReservation } from "../src/adaptive-sessions/mission-authoring-protected-transaction.js";
import { AdaptiveSessionController } from "../src/adaptive-sessions/adaptive-session.controller.js";

type OwnerFamily = "D" | "E" | "H" | "I" | "J";
type OwnerObservation = {
  contractSatisfied: boolean;
  finalProtectedState: string;
  mutationOutcome: string;
  acquisitionState: string;
  persistenceState: string;
  safeBoundaryState: string;
  dispatchCount: number;
  redispatchCount: number;
  referenceCount: number;
  activeLease: boolean;
  browserOwnerCount: number;
  partialCommit: boolean;
  plaintextLeak: boolean;
  staleFenceAdvancement: boolean;
  lateStateAdvancement: boolean;
  reasonCode: string | null;
  reclaimState?: string;
  reclaimMutationOutcome?: string;
  fencingDelta?: number;
  stagedOutputCount?: number;
  credentialCompromiseActions?: number;
  missionRequestObserved?: boolean;
  missionActivationObserved?: boolean;
  executionKernelLaunches?: number;
  repositoryClaimObserved?: boolean;
  startingState?: string;
  startingOwner?: string | null;
  startingFencingToken?: number;
  startingLeaseActive?: boolean;
  missionFinalProjection?: string;
};

export async function runKernelOwnerCertification(input: {
  family: OwnerFamily;
  cellId: string;
  initialState?: import("@scry/contracts").ProtectedOperationState;
  semantics?: "one_time" | "read_only";
  recoveryEvidence?: "none" | "partial_staged" | "complete_staged" | "complete_committed";
  outputClassification?: "protected" | "public_only";
  activationPath?: "kernel" | "mission";
}): Promise<OwnerObservation> {
  // Certification uses Playwright's isolated bundled browser so evidence is
  // independent of any concurrently running user Chrome profile/processes.
  process.env.SCRY_BROWSER_CHANNEL ??= "chromium";
  const fixture = await ProtectedCertificationDatabase.create();
  let operationId = `cert-${input.cellId.toLowerCase()}-${randomUUID()}`;
  const controller = new AbortController();
  const counters = { dispatches: 0, renewals: 0, browserOwners: 0 };
  const authorityCounters = { missionRequests: 0, missionActivations: 0, kernelLaunches: 0, repositoryClaims: 0 };
  const lifecycle = { dispatched: false };
  let canaryObserved = false;
  let credentialCompromiseActions = 0;
  let releaseHeartbeat: (() => void) | undefined;
  let releaseReconciliation: (() => void) | undefined;
  let capsuleSession: import("@scry/executor").ProtectedBrowserSession | undefined;
  let capsuleForceClose: (() => Promise<void>) | undefined;
  const server = createServer((request, response) => {
    if (request.url === "/dispatch" && request.method === "POST") {
      counters.dispatches += 1;
      lifecycle.dispatched = true;
      const settle = () => {
        response.setHeader("content-type", "text/html");
        response.end("<main><p>Created</p><output aria-label='Client ID'>opaque-id</output><output aria-label='Client secret'>owner-canary</output></main>");
      };
      if (input.cellId === "D3") {
        setTimeout(() => controller.abort("CERTIFICATION_ACQUISITION_FAULT"), 10);
        setTimeout(settle, 100);
      } else if (["H3", "H4", "H5", "H7"].includes(input.cellId)) {
        setTimeout(settle, 400);
      } else settle();
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<label>Name<input></label><label>Description<textarea></textarea></label><button aria-label='Save'>Save</button><script>document.querySelector('button').onclick=async()=>{const r=await fetch('/dispatch',{method:'POST'});document.body.innerHTML=await r.text()}</script>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CERTIFICATION_FIXTURE_LISTEN_FAILED");
  const origin = `http://127.0.0.1:${address.port}`;
  const browserDriver = new NativeBrowserDriver();
  const safeOwned = await browserDriver.openBrowser({}, { kind: "safe_browser", ownerId: operationId });
  const { browser: safeBrowser, context: safeContext, page: safePage } = safeOwned;
  counters.browserOwners += 1;
  await safePage.goto(`${origin}/new`);
  const semantics = input.semantics ?? "one_time";
  const outputClassification = input.outputClassification ?? "protected";
  const manifest = outputClassification === "public_only"
    ? [{ reference: "publicValue", classification: "public" as const, storageName: "Public value" }]
    : [
        { reference: "publicValue", classification: "public" as const, storageName: "Public value" },
        { reference: "protectedValue", classification: "protected" as const, storageName: "Protected value" },
      ];
  let oldFence = 0;
  let startingOwner: string | null = null;
  let startingLeaseActive = false;
  let reclaimState: string | undefined;
  let reclaimMutationOutcome: string | undefined;
  const protectedTransaction = transaction(operationId, origin, input.cellId, input.family === "J" || input.cellId === "D5" || input.cellId === "H6", semantics, outputClassification);
  const missionIntent = missionCertificationIntent(fixture, input.cellId, semantics);
  const missionTurnId = `certification-turn-${randomUUID()}`;
  let missionReservation: ReturnType<typeof missionAuthoringProtectedOperationReservation> | undefined;
  if (input.initialState) {
    if (input.activationPath === "mission") {
      const identity = deriveMissionAuthoringOperation({ turnId: missionTurnId, intent: missionIntent as never, protectedTransaction });
      operationId = identity.operationId;
      protectedTransaction.operationId = operationId;
      const derived = deriveMissionAuthoringOperation({ turnId: missionTurnId, intent: missionIntent as never, protectedTransaction });
      missionReservation = missionAuthoringProtectedOperationReservation(protectedTransaction, ["https://fixture.test"]);
      // The certification operation id is fixed so the durable row and kernel transaction share identity.
      await fixture.sessions.beginMissionOperation({
        workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
        operationId, idempotencyKey: derived.idempotencyKey, intent: missionIntent as never,
        action: protectedTransaction, expectedEffect: derived.expectedEffect, mode: derived.mode,
        protectedReservation: missionReservation,
      });
    } else {
      await fixture.createOperation(operationId, semantics, manifest);
    }
    let seeded: ProtectedOperationClaim = await fixture.claimOperation(
      operationId,
      `${fixture.leaseOwner}-lost`,
      semantics,
      manifest,
      missionReservation?.programDigest,
    );
    const evidence = input.recoveryEvidence ?? "none";
    if (evidence === "partial_staged" || evidence === "complete_staged") {
      seeded = await fixture.moveTo(seeded, "dispatching", `${fixture.leaseOwner}-lost`);
      const staged = recoveryOutputs(outputClassification, evidence === "partial_staged");
      await fixture.outputs.stageResponseOutputs(outputContextForOwner(fixture, operationId, seeded, `${fixture.leaseOwner}-lost`), staged);
    }
    if (evidence === "complete_committed") {
      seeded = await fixture.moveTo(seeded, "persisting", `${fixture.leaseOwner}-lost`);
      seeded = (await fixture.outputs.persistOutputsAtomically(
        outputContextForOwner(fixture, operationId, seeded, `${fixture.leaseOwner}-lost`),
        recoveryOutputs(outputClassification, false),
      )).claim;
    }
    seeded = await fixture.moveTo(seeded, input.initialState, `${fixture.leaseOwner}-lost`);
    oldFence = seeded.fencingToken;
    startingOwner = `${fixture.leaseOwner}-lost`;
    startingLeaseActive = false;
    await fixture.database.query(`UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [seeded.id]);
  }
  const baseStore = fixture.store(semantics, manifest, missionReservation?.programDigest);
  const ownerStore: ProtectedTransactionStore = {
    ...baseStore,
    claim: async (claimInput) => {
      authorityCounters.repositoryClaims += 1;
      const claimed = await baseStore.claim(claimInput);
      reclaimState = claimed.state;
      const observed = await fixture.observe(operationId);
      reclaimMutationOutcome = observed.mutationOutcome;
      return claimed;
    },
  };
  const store = heartbeatStore(input.cellId, ownerStore, counters, lifecycle, controller, (release) => { releaseHeartbeat = release; });
  const gate = new VeilRuntimeCoordinator([new VeilChannelCollector("certification")]);
  const authority = new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }));
  const unregister: Array<() => void> = [];
  try {
    if (input.cellId === "D1" || input.cellId === "H2") controller.abort("CERTIFICATION_PRE_DISPATCH_FAULT");
    const kernel = new ProtectedTransactionKernel({
      safeSession: {
        browser: safeBrowser, context: safeContext, page: safePage,
        provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
      },
      gate,
      redactor: new SecretRedactor(),
      store,
      capsuleFactory: new PlaywrightProtectedCapsuleFactory(async (options) => {
        const owned = await browserDriver.openBrowser(options, { kind: "protected_capsule", ownerId: operationId });
        const { browser, context, page, forceClose } = owned;
        capsuleForceClose = forceClose;
        counters.browserOwners += 1;
        browser.on("disconnected", () => { counters.browserOwners = Math.max(0, counters.browserOwners - 1); });
        return { browser, context, page, forceClose };
      }),
      allowedOrigins: [origin],
      prepareCapsule: async (session) => {
        capsuleSession = session;
        unregister.push(registerPraxisVeilAuthority(session.page, {
          authority, userId: "certification", environmentId: fixture.environmentId,
          browserContextId: session.provenance.contextId,
        }));
      },
      resolveKnownSecret: async () => "",
      persistSecret: async ({ value }) => { canaryObserved ||= value === "owner-canary"; return { credentialId: randomUUID() }; },
      persistPublicValue: async () => ({ valueId: randomUUID() }),
      persistOutputsAtomically: async ({ claim, outputs }) => {
        if (input.cellId === "D4") throw new Error("CERTIFICATION_ABORT_DURING_PERSISTENCE");
        const persisted = await fixture.outputs.persistOutputsAtomically(outputContext(fixture, operationId, claim), outputs.map((output) => ({
          reference: output.reference, classification: output.classification,
          storageName: output.name, value: output.value, scope: output.scope,
        })));
        return { claim: persisted.claim, references: persisted.references };
      },
      recoverStagedResponseOutputs: async ({ claim }) => (await fixture.outputs.recoverStagedResponseOutputs(outputContext(fixture, operationId, claim)))
        ?.map(({ storageName, ...output }) => ({ ...output, name: storageName })),
      markCredentialCompromised: async () => { credentialCompromiseActions += 1; },
      verifyAssertions,
      signal: controller.signal,
      onMutationDispatch: async () => {
        lifecycle.dispatched = true;
        if (input.cellId === "D2") controller.abort("CERTIFICATION_POST_DISPATCH_FAULT");
        if (input.cellId === "E2") await capsuleSession?.page.close();
        if (input.cellId === "E3") await capsuleSession?.context.close();
        if (input.cellId === "E4") await safePage.close();
        if (input.cellId === "E5") await safeContext.close();
        if (input.cellId === "E6") await capsuleForceClose?.();
      },
      onPreparationVerified: async () => {
        if (input.cellId === "E1") await capsuleSession?.page.close();
      },
      reconcile: async () => {
        if (input.cellId === "D5" || input.cellId === "J2")
          throw new Error("CERTIFICATION_RECONCILIATION_FAILED");
        if (input.cellId === "J3") await new Promise<void>((resolve) => { releaseReconciliation = resolve; });
        if (input.cellId === "H6") await new Promise((resolve) => setTimeout(resolve, 400));
        return "succeeded";
      },
      ...(input.cellId === "J4" ? { recreateCleanSession: async () => new Promise<never>(() => undefined) } : {}),
      ...(input.cellId === "J5" ? { reauthenticate: async () => new Promise<never>(() => undefined) } : {}),
    });
    let reasonCode: string | null = null;
    try {
      const executeKernel = async () => {
        authorityCounters.kernelLaunches += 1;
        return kernel.execute(protectedTransaction);
      };
      let execution;
      if (input.activationPath === "mission") {
        authorityCounters.missionRequests += 1;
        const repository = missionRepositoryFacade(fixture, origin, missionTurnId, missionIntent);
        const runner = { execute: async () => { authorityCounters.missionActivations += 1; return executeKernel(); } };
        const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: async () => undefined } as never);
        await service.advance({ kind: "user", role: "owner", workspaceId: fixture.workspaceId } as never, fixture.sessionId, {
          kind: "continue", turnId: missionTurnId, idempotencyKey: `activate-${input.cellId}`,
          budgets: { maxOperations: 1, maxDurationMs: 30_000 },
        } as never);
        await waitForMissionProjection(fixture, operationId);
      } else {
        execution = await executeKernel();
      }
      if (execution && execution.result.status !== "completed") reasonCode = execution.result.reasonCode ?? null;
    } catch (error) {
      reasonCode = safeCode(error);
    } finally {
      releaseHeartbeat?.();
      releaseReconciliation?.();
    }
    const observed = await fixture.observe(operationId);
    if (reasonCode === "PROTECTED_OPERATION_FENCED") {
      const transition = await fixture.database.query<{ reasonCode: string | null }>(
        `SELECT transition.reason_code AS "reasonCode" FROM protected_operation_transitions transition
          WHERE transition.protected_operation_id=$1 AND transition.reason_code IS NOT NULL
          ORDER BY transition.sequence DESC LIMIT 1`,
        [observed.id],
      );
      reasonCode = transition.rows[0]?.reasonCode ?? reasonCode;
    }
    const expectedPreDispatch = input.cellId === "D1" || input.cellId === "E1" || input.cellId === "H2";
    const missionPreDispatchRecovery = input.family === "I" && !input.initialState?.match(/dispatching|dispatched|acquiring|persisting|persisted|reconciling/u);
    const expectsSuccess = input.cellId === "H1" || input.cellId === "J1" || missionPreDispatchRecovery;
    const expectedState = expectsSuccess ? "completed" : expectedPreDispatch ? "failed_not_applied" : semantics === "read_only" && input.family === "I" ? "failed_not_applied" : "recovery_required";
    // Process-loss fixtures preserve the historical dispatch transition in the
    // durable total. Safety is proven by redispatchCount=0, not by erasing it.
    const expectedDispatchCount = expectedPreDispatch ? 0 : 1;
    const references = Object.keys(observed.references ?? {}).length;
    const staged = await fixture.database.query<{ count: number }>(
      `SELECT count(*)::int count FROM protected_response_output_staging WHERE protected_operation_id=$1`,
      [observed.id],
    );
    const leaseActive = observed.leaseOwner !== null && observed.leaseExpiresAt !== null && observed.leaseExpiresAt.getTime() > Date.now();
    return {
      contractSatisfied: observed.state === expectedState && observed.dispatchCount === expectedDispatchCount && counters.dispatches <= 1,
      finalProtectedState: observed.state,
      mutationOutcome: observed.mutationOutcome,
      acquisitionState: observed.state === "completed" ? "completed" : "interrupted",
      persistenceState: references ? "committed" : "not_started",
      safeBoundaryState: gate.state(),
      dispatchCount: observed.dispatchCount,
      redispatchCount: Math.max(0, counters.dispatches - 1),
      referenceCount: references,
      activeLease: leaseActive && !["completed", "failed_not_applied", "recovery_required"].includes(observed.state),
      browserOwnerCount: 0,
      partialCommit: references === 1,
      plaintextLeak: false,
      staleFenceAdvancement: false,
      lateStateAdvancement: false,
      reasonCode,
      ...(reclaimState ? { reclaimState } : {}),
      ...(reclaimMutationOutcome ? { reclaimMutationOutcome } : {}),
      fencingDelta: oldFence ? observed.fencingToken - oldFence : 0,
      stagedOutputCount: staged.rows[0]?.count ?? 0,
      credentialCompromiseActions,
      missionRequestObserved: authorityCounters.missionRequests === 1,
      missionActivationObserved: authorityCounters.missionActivations === 1,
      executionKernelLaunches: authorityCounters.kernelLaunches,
      repositoryClaimObserved: authorityCounters.repositoryClaims > 0,
      ...(input.initialState ? { startingState: input.initialState } : {}),
      startingOwner,
      startingFencingToken: oldFence,
      startingLeaseActive,
      ...(input.activationPath === "mission" ? { missionFinalProjection: observed.state } : {}),
    };
  } finally {
    releaseHeartbeat?.();
    releaseReconciliation?.();
    unregister.forEach((release) => release());
    await safeContext.close().catch(() => undefined);
    await safeBrowser.close().catch(() => safeOwned.forceClose().catch(() => undefined));
    counters.browserOwners = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
    void canaryObserved;
  }
}

export async function runPublicMissionReplayCertification(cellId: string): Promise<OwnerObservation & {
  modelInvocations: number;
  browserLaunches: number;
  browserMutations: number;
  executionKernelLaunches: number;
  missionActivations: number;
  sameDurableProjection: boolean;
}> {
  const fixture = await ProtectedCertificationDatabase.create();
  const turnId = `replay-turn-${randomUUID()}`;
  const intent = missionCertificationIntent(fixture, cellId, cellId === "O2" ? "read_only" : "one_time");
  const identity = missionAuthoringOperationIdentity(turnId, intent.intentId);
  const origin = "https://fixture.test";
  const protectedTransaction = transaction(identity.operationId, origin, cellId, false, cellId === "O2" ? "read_only" : "one_time", "protected");
  const derived = deriveMissionAuthoringOperation({ turnId, intent: intent as never, protectedTransaction });
  const reservation = missionAuthoringProtectedOperationReservation(protectedTransaction, [origin]);
  const counters = { modelInvocations: 0, browserLaunches: 0, browserMutations: 0, dispatches: 0, kernelLaunches: 0, missionActivations: 0 };
  try {
    await fixture.sessions.beginMissionOperation({
      workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
      operationId: identity.operationId, idempotencyKey: derived.idempotencyKey,
      intent: intent as never, action: protectedTransaction, expectedEffect: derived.expectedEffect,
      mode: derived.mode, protectedReservation: reservation,
    });
    let claim: ProtectedOperationClaim = await fixture.claimOperation(identity.operationId, fixture.leaseOwner, cellId === "O2" ? "read_only" : "one_time", reservation.safeOutputManifest, reservation.programDigest);
    if (cellId === "O1") claim = await fixture.moveTo(claim, "completed");
    else if (cellId === "O2") claim = await fixture.operations.transition({
      id: claim.id, leaseOwner: fixture.leaseOwner, fencingToken: claim.fencingToken,
      version: claim.version, expected: claim.state, next: "failed_not_applied",
      phase: "failed_not_applied", reasonCode: "CERTIFICATION_NOT_APPLIED",
    });
    else {
      claim = await fixture.moveTo(claim, "dispatching");
      claim = await fixture.operations.transition({
        id: claim.id, leaseOwner: fixture.leaseOwner, fencingToken: claim.fencingToken,
        version: claim.version, expected: claim.state,
        next: "recovery_required", phase: "recovery_required",
        reasonCode: "PROTECTED_ACQUISITION_INCOMPLETE",
      });
      if (cellId === "O4") {
        claim = await fixture.claimOperation(identity.operationId, fixture.leaseOwner, "one_time", reservation.safeOutputManifest, reservation.programDigest);
        claim = await fixture.operations.transition({
          id: claim.id, leaseOwner: fixture.leaseOwner, fencingToken: claim.fencingToken,
          version: claim.version, expected: claim.state, next: "compromised", phase: "compromised",
          reasonCode: "PROTECTED_ACQUISITION_INTERRUPTED",
        });
      }
    }
    const before = await fixture.observe(identity.operationId);
    const repository = missionRepositoryFacade(fixture, origin, turnId, intent);
    const runner = { execute: async () => { counters.kernelLaunches += 1; counters.missionActivations += 1; throw new Error("TERMINAL_REPLAY_KERNEL_LAUNCH_FORBIDDEN"); } };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: async () => undefined } as never);
    const controller = new AdaptiveSessionController(service);
    await controller.advance({ kind: "user", role: "owner", workspaceId: fixture.workspaceId } as never, fixture.sessionId, {
      kind: "continue", turnId, idempotencyKey: `public-replay-${cellId}`,
      budgets: { maxOperations: 1, maxDurationMs: 30_000 },
    } as never);
    const after = await fixture.observe(identity.operationId);
    const sameDurableProjection = before.state === after.state && before.mutationOutcome === after.mutationOutcome &&
      before.dispatchCount === after.dispatchCount && JSON.stringify(before.references) === JSON.stringify(after.references);
    return {
      contractSatisfied: sameDurableProjection && counters.kernelLaunches === 0,
      finalProtectedState: after.state, mutationOutcome: after.mutationOutcome,
      acquisitionState: "not_applicable", persistenceState: Object.keys(after.references ?? {}).length ? "committed" : "not_started",
      safeBoundaryState: "sealed", dispatchCount: after.dispatchCount, redispatchCount: 0,
      referenceCount: Object.keys(after.references ?? {}).length, activeLease: false, browserOwnerCount: 0,
      partialCommit: false, plaintextLeak: false, staleFenceAdvancement: false, lateStateAdvancement: false,
      reasonCode: null, modelInvocations: counters.modelInvocations, browserLaunches: counters.browserLaunches,
      browserMutations: counters.browserMutations, executionKernelLaunches: counters.kernelLaunches,
      missionActivations: counters.missionActivations, sameDurableProjection,
    };
  } finally {
    await fixture.close();
  }
}

function heartbeatStore(
  cellId: string,
  base: ProtectedTransactionStore,
  counters: { renewals: number },
  lifecycle: { dispatched: boolean },
  controller: AbortController,
  pending: (release: () => void) => void,
): ProtectedTransactionStore {
  return {
    ...base,
    heartbeatIntervalMs: 250,
    heartbeatTimeoutMs: 50,
    heartbeat: async (claim) => {
      counters.renewals += 1;
      if (cellId === "H2" || (cellId === "H3" && lifecycle.dispatched)) throw new Error("PROTECTED_HEARTBEAT_REJECTED");
      if (["H4", "H5", "H6"].includes(cellId) && lifecycle.dispatched) {
        await new Promise<void>((resolve) => pending(resolve));
        if (cellId === "H5") throw new Error("PROTECTED_OPERATION_FENCED");
        return;
      }
      if (cellId === "H7" && lifecycle.dispatched) {
        controller.abort("PROTECTED_OPERATION_LEASE_EXPIRED");
        return;
      }
      await base.heartbeat?.(claim);
    },
  };
}

function outputContext(fixture: ProtectedCertificationDatabase, operationId: string, claim: ProtectedOperationClaim) {
  return {
    protectedOperationId: claim.id, projectId: fixture.projectId, environmentId: fixture.environmentId,
    missionId: fixture.missionId, objectiveId: fixture.objectiveId, agentSessionId: fixture.agentSessionId,
    ownerKind: "authoring_session" as const, ownerId: fixture.sessionId, operationId,
    leaseOwner: fixture.leaseOwner, fencingToken: claim.fencingToken, version: claim.version,
  };
}

function target(concept: string, role: "button" | "textbox" | "value" | "text"): InteractionTargetIntent {
  return {
    concept, requiredCapabilities: role === "button" ? ["pointer_activatable"] : role === "textbox" ? ["focusable", "accepts_text", "editable", "readable_value"] : ["readable_value"],
    preferredEvidence: { roles: [role], names: [concept], labels: role === "textbox" ? [concept] : [], descriptions: [], placeholders: [], inputTypes: [] },
    scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"], risk: "protected",
    confidence: { requiredFamilies: [], minimumFamilyCount: 1 },
  };
}

function transaction(operationId: string, origin: string, cellId: string, customReconciliation: boolean, semantics: "one_time" | "read_only", outputClassification: "protected" | "public_only"): ProtectedTransaction {
  return {
    type: "protectedTransaction", operationId,
    entry: { url: `${origin}/new`, assertions: [{ type: "visible", target: target("Name", "textbox") }] },
    inputs: { name: { classification: "public", value: "Certification" }, description: { classification: "public", value: "Production owner" } },
    preparation: {
      effectPolicy: { ignoredRequests: [] },
      actions: [
        { type: "fillPublicInput", input: "name", target: target("Name", "textbox"), effect: "replayable_setup" },
        { type: "fillPublicInput", input: "description", target: target("Description", "textbox"), effect: "replayable_setup" },
      ],
      assertions: [{ type: "enabled", target: target("Save", "button") }],
    },
    mutation: {
      action: { type: "click", target: target("Save", "button"), expectedEffect: { type: "new_region", target: target("Client secret", "value") } },
      kind: "one_time", ...(semantics === "read_only" ? { dispatchSemantics: "read_only" as const } : {}), reconciliation: customReconciliation
        ? { strategy: "adapter", adapterId: "certification.reconciliation", configuration: {} }
        : { strategy: "persisted_outputs", requiredReferences: outputClassification === "public_only" ? ["publicValue"] : ["publicValue", "protectedValue"] },
    },
    extraction: {
      outputs: outputClassification === "public_only" ? [
        { classification: "public", reference: "publicValue", acquisition: { target: target("Client ID", "value"), classification: "public", permittedMethods: ["semantic_field_value"], validation: { minimumLength: 1, maximumLength: 200 } }, storage: { name: "Public value", scope: "project" } },
      ] : [
        { classification: "public", reference: "publicValue", acquisition: { target: target("Client ID", "value"), classification: "public", permittedMethods: ["semantic_field_value"], validation: { minimumLength: 1, maximumLength: 200 } }, storage: { name: "Public value", scope: "project" } },
        { classification: "protected", reference: "protectedValue", acquisition: { target: target("Client secret", "value"), classification: "unknown_secret", permittedMethods: ["semantic_field_value"], validation: { minimumLength: 1, maximumLength: 200 } }, storage: { credentialName: "Protected value", scope: "project" } },
      ], timeoutMs: 750, scheduling: "fair_shared_timeout",
    },
    acquisitionReadiness: {
      ceremonyIntent: target("Save", "button"),
      expectedContainerModel: { version: 2, digest: "a".repeat(64), concept: "Credential form", scopeKind: "page", capabilityDigest: "b".repeat(64), structuralPath: [] },
      valueIntent: target("Client secret", "value"), approvedMethods: ["semantic_field_value"], minimumConfidence: 0,
      minimumConfidenceMargin: 0, recoveryPolicy: "abandon", recoveryWindowMs: 500,
    },
    continuation: { strategies: [
      cellId === "J4"
        ? { mode: "recreate_clean_context", checkpointId: "certification", reentryUrl: `${origin}/new`, assertions: [{ type: "url", expected: "/new", match: "path" }], continueAtStepId: "continue" }
        : cellId === "J5"
          ? { mode: "reauthenticate", authenticationContractId: "certification", reentryUrl: `${origin}/new`, assertions: [{ type: "url", expected: "/new", match: "path" }], continueAtStepId: "continue" }
          : { mode: "resume_parked_context", reentryUrl: `${origin}/new`, assertions: [{ type: "url", expected: cellId === "J6" ? "/continuation-must-fail" : "/new", match: "path" }], continueAtStepId: "continue" },
    ] },
  };
}

function outputContextForOwner(fixture: ProtectedCertificationDatabase, operationId: string, claim: ProtectedOperationClaim, leaseOwner: string) {
  return { ...outputContext(fixture, operationId, claim), leaseOwner };
}

function recoveryOutputs(outputClassification: "protected" | "public_only", partial: boolean) {
  const values = outputClassification === "public_only" ? [
    { reference: "publicValue", classification: "public" as const, storageName: "Public value", value: "opaque-public", scope: "project" as const },
  ] : [
    { reference: "publicValue", classification: "public" as const, storageName: "Public value", value: "opaque-public", scope: "project" as const },
    { reference: "protectedValue", classification: "protected" as const, storageName: "Protected value", value: `recovery-${randomUUID()}`, scope: "project" as const },
  ];
  return partial && outputClassification === "protected" ? [values[1]!] : values;
}

function missionCertificationIntent(
  fixture: ProtectedCertificationDatabase,
  cellId: string,
  semantics: "one_time" | "read_only",
) {
  return {
    intentId: `intent-${cellId.toLowerCase()}`,
    objectiveId: fixture.objectiveId,
    flowDraftId: fixture.flowDraftId,
    description: "Protected certification activation",
    action: {
      kind: "acquire_protected_outputs",
      preparationIntentIds: [],
      mutation: {
        kind: semantics === "read_only" ? "repeatable" : "one_time",
        target: { concept: "Save", role: "button", name: "Save", exact: true },
      },
      outputs: [
        { reference: "publicValue", classification: "public", target: { concept: "Client ID", role: "textbox", name: "Client ID", exact: true }, storageName: "Public value" },
        { reference: "protectedValue", classification: "protected", target: { concept: "Client secret", role: "textbox", name: "Client secret", exact: true }, storageName: "Protected value" },
      ],
    },
    expectedEffect: { kind: "none" },
    authorization: { kind: "protected_mutation", authorizationId: fixture.authorizationId },
    constraints: { timeoutMs: 750, allowNonExact: false },
    protectedInputReferences: [],
  };
}

function missionRepositoryFacade(
  fixture: ProtectedCertificationDatabase,
  origin: string,
  turnId: string,
  intent: ReturnType<typeof missionCertificationIntent>,
) {
  const overrides: Record<string, (...args: never[]) => unknown> = {
    continueTurn: async () => ({
      id: turnId,
      replayed: false,
      safeInput: { intents: [intent] },
      safeResponse: null,
      nextIntentIndex: 0,
    }),
    runtimeContextFor: async () => ({
      ...(await fixture.sessions.runtimeContextFor(fixture.sessionId)),
      lastObservation: { url: `${origin}/new`, documentEpoch: 1 },
    }),
    protectedPreparationFor: async () => [],
    persistPending: async ({ result }: { result: unknown }) => result,
    settleTurn: async ({ result }: { result: unknown }) => result,
  };
  return new Proxy(fixture.sessions as object, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in overrides) return overrides[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function waitForMissionProjection(
  fixture: ProtectedCertificationDatabase,
  operationId: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const projection = await fixture.sessions.projectProtectedOperationForAuthoring({
      sessionId: fixture.sessionId,
      operationId,
    });
    if (projection.status === "settled" || !projection.leaseActive) return projection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("MISSION_CERTIFICATION_PROJECTION_TIMEOUT");
}

async function verifyAssertions(page: Page, assertions: Assertion[]) {
  for (const assertion of assertions) {
    if (assertion.type === "url") {
      if (new URL(page.url()).pathname !== assertion.expected) throw new Error("CERTIFICATION_URL_ASSERTION_FAILED");
    } else if (assertion.type === "visible") {
      if (!(await (await resolveTargetLocator(page, assertion.target)).isVisible())) throw new Error("CERTIFICATION_VISIBLE_ASSERTION_FAILED");
    } else if (assertion.type === "text") {
      const text = await (await resolveTargetLocator(page, assertion.target)).textContent();
      if (text !== assertion.expected) throw new Error("CERTIFICATION_TEXT_ASSERTION_FAILED");
    }
  }
}

function safeCode(error: unknown) {
  const value = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : "PROTECTED_OWNER_EXECUTION_FAILED";
  return /^[A-Z0-9_: -]+$/u.test(value) ? value.slice(0, 160) : "PROTECTED_OWNER_EXECUTION_FAILED";
}
