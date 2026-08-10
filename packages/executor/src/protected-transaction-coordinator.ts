import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { Assertion, ProtectedOperationState, ProtectedTransaction, ProtectedTransactionResult } from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";
import type { ProtectedBrowserSession, SafeBrowserSession } from "./browser-session.js";
import { executeProtectedReveal, verifyProtectedRevealTarget } from "./protected-extractor.js";
import {
  CalibrationRequiredError,
  protectedTransactionDigest,
  transactionInputDigest,
  transactionInputSchemaDigest,
} from "./calibration.js";
import type { VeilRuntimeCoordinator } from "@scry/veil";
import type { CapsuleFactory } from "./protected-capsule-factory.js";
import type { ExecuteOptions } from "./types.js";
export { PlaywrightProtectedCapsuleFactory } from "./protected-capsule-factory.js";
export type { CapsuleFactory } from "./protected-capsule-factory.js";
import { ProtectedTransactionPhaseError as PhaseError } from "./protected-transaction-errors.js";
import {
  executeProtectedPreparation,
  verifyProtectedTransactionAssertions,
} from "./protected-transaction-preparation.js";
import {
  acquireProtectedOutputs,
  persistAcquiredProtectedOutputs,
  protectedOutputsPersisted,
  recoverProtectedAcquisition,
  verifyProtectedAcquisitionReadiness,
} from "./protected-transaction-acquisition.js";
import {
  continueAfterProtectedMutation,
  reconcileProtectedMutation,
} from "./protected-transaction-post-dispatch.js";
import { classifyPassivePreparationRequest } from "./protected-preparation-effects.js";
import { beginProtectedResponseEnvelope } from "./protected-response-envelope.js";

/** @deprecated Historical rows only. New operations use ProtectedOperationState. */
export type MutationLedgerState = ProtectedOperationState;
export type ProtectedOperationClaim = {
  id: string;
  state: ProtectedOperationState;
  version: number;
  fencingToken: number;
  persistedReferences?: Record<string, { classification: "public" | "protected"; credentialId?: string; valueId?: string; scope: "run" | "project" }>;
};
export type ProtectedTransactionStore = {
  claim(input: {
    operationId: string;
    mutationKind: "one_time" | "repeatable";
    dispatchSemantics?: "mutation" | "read_only";
    programDigest: string;
    inputSchemaDigest: string;
    inputDigest: string;
    mutationIdentity: string;
    safeOutputManifest: Array<{ reference: string; classification: "public" | "protected"; storageName: string }>;
  }): Promise<ProtectedOperationClaim>;
  transition(input: {
    id: string;
    operationId: string;
    version: number;
    fencingToken: number;
    expected: MutationLedgerState;
    next: MutationLedgerState;
    phase: string;
    reasonCode?: string;
    facts?: Record<string, unknown>;
  }): Promise<ProtectedOperationClaim>;
  record(input: {
    operationId: string;
    fencingToken: number;
    phase: string;
    facts?: Record<string, unknown>;
  }): Promise<void>;
  heartbeat?(claim: ProtectedOperationClaim): Promise<void>;
  heartbeatIntervalMs?: number;
};

export type ProtectedTransactionDependencies = {
  safeSession: SafeBrowserSession;
  gate: VeilRuntimeCoordinator;
  redactor: SecretRedactor;
  store: ProtectedTransactionStore;
  capsuleFactory: CapsuleFactory;
  allowedOrigins: string[];
  persistSecret(input: {
    operationId: string;
    reference: string;
    name: string;
    value: string;
    scope: "run" | "project";
  }): Promise<{ credentialId: string }>;
  persistPublicValue(input: {
    operationId: string;
    reference: string;
    name: string;
    value: string;
    scope: "run" | "project";
  }): Promise<{ valueId: string }>;
  persistOutputsAtomically?(input: {
    operationId: string;
    claim: ProtectedOperationClaim;
    outputs: Array<{
      reference: string;
      classification: "public" | "protected";
      name: string;
      value: string;
      scope: "run" | "project";
    }>;
  }): Promise<{
    claim: ProtectedOperationClaim;
    references: Record<string, { classification: "public" | "protected"; credentialId?: string; valueId?: string; scope: "run" | "project" }>;
  }>;
  stageResponseOutputsAtomically?(input: {
    operationId: string;
    claim: ProtectedOperationClaim;
    outputs: Array<{
      reference: string;
      classification: "public" | "protected";
      name: string;
      value: string;
      scope: "run" | "project";
    }>;
  }): Promise<void>;
  recoverStagedResponseOutputs?(input: {
    operationId: string;
    claim: ProtectedOperationClaim;
  }): Promise<Array<{
    reference: string;
    classification: "public" | "protected";
    name: string;
    value: string;
    scope: "run" | "project";
  }> | undefined>;
  resolveKnownSecret(reference: string): Promise<string>;
  executeNativeControl?: ExecuteOptions["executeNativeControl"];
  verifyAssertions(page: Page, assertions: Assertion[]): Promise<void>;
  prepareCapsule(session: ProtectedBrowserSession): Promise<void>;
  verifyCalibration?(
    session: ProtectedBrowserSession,
    transaction: ProtectedTransaction,
  ): Promise<void>;
  onPreparationVerified?(
    session: ProtectedBrowserSession,
    transaction: ProtectedTransaction,
  ): Promise<void>;
  reconcile?(
    session: SafeBrowserSession,
    transaction: ProtectedTransaction,
  ): Promise<"succeeded" | "not_applied" | "unknown">;
  recreateCleanSession?(checkpointId: string): Promise<SafeBrowserSession>;
  reauthenticate?(authenticationContractId: string): Promise<SafeBrowserSession>;
  onContextProvenance?(input: {
    contextId: string;
    provenance: string;
    operationId: string;
  }): Promise<void>;
  onEvidenceResumed?(input: {
    contextId: string;
    operationId: string;
    continuedAtStepId: string;
  }): Promise<void>;
  emit?(type: string, payload: Record<string, unknown>): Promise<void>;
  recoverAcquisition?(input: {
    operationId: string;
    expiresAt: string;
    permittedActions: string[];
  }): Promise<{
    action: "retry" | "request_secure_assistance" | "revoke" | "abandon" | "expired";
    correctedScope?: import("@scry/contracts").SemanticScope;
  }>;
  signal?: AbortSignal;
  onMutationDispatch?(): void | Promise<void>;
  markCredentialCompromised?(credentialId: string, code: string, operationId: string): Promise<void>;
};

export type ProtectedTransactionExecution = {
  result: ProtectedTransactionResult;
  safeSession: SafeBrowserSession;
  terminal: boolean;
};

export class ProtectedTransactionKernel {
  constructor(private readonly dependencies: ProtectedTransactionDependencies) {}

  async execute(transaction: ProtectedTransaction): Promise<ProtectedTransactionExecution> {
    const d = this.dependencies;
    const identity = digests(transaction, d.allowedOrigins);
    let claim = await d.store.claim({
      operationId: transaction.operationId,
      mutationKind: transaction.mutation.kind,
      dispatchSemantics: transaction.mutation.dispatchSemantics ?? "mutation",
      mutationIdentity: transaction.operationId,
      safeOutputManifest: transaction.extraction.outputs.map((output) => ({
        reference: output.reference,
        classification: output.classification,
        storageName: output.classification === "protected" ? output.storage.credentialName : output.storage.name,
      })),
      ...identity,
    });
    if (["dispatching", "dispatched", "acquiring", "persisting", "persisted", "reconciling", "recovery_required", "compromised"].includes(claim.state))
      return this.recoverDurable(transaction, claim);
    if (["completed", "failed_not_applied", "revoked", "abandoned"].includes(claim.state))
      return this.storedTerminal(transaction, claim);
    if (claim.state === "planned") {
      claim = await d.store.transition({
        id: claim.id, operationId: transaction.operationId, version: claim.version,
        fencingToken: claim.fencingToken, expected: "planned", next: "preparing", phase: "preparation",
      });
    }
    let heartbeatFailure: unknown;
    const leaseController = new AbortController();
    let heartbeatWork = Promise.resolve();
    const heartbeat = () => {
      heartbeatWork = heartbeatWork.then(() => d.store.heartbeat?.(claim)).catch((error) => {
        heartbeatFailure ??= error;
        leaseController.abort(error);
      });
      return heartbeatWork;
    };
    const heartbeatTimer = d.store.heartbeat
      ? setInterval(() => { void heartbeat(); }, Math.max(250, d.store.heartbeatIntervalMs ?? 10_000))
      : undefined;
    const assertOwned = () => {
      if (heartbeatFailure) throw new PhaseError("PROTECTED_OPERATION_LEASE_LOST", facts.mutation.dispatch === "not_started" ? "preparation" : "mutation_dispatch", facts.mutation.dispatch === "not_started" ? "safe_to_retry" : "retry_requires_reconciliation");
    };
    const facts = initialFacts();
    let capsule: ProtectedBrowserSession | undefined;
    let responseEnvelope: Awaited<ReturnType<typeof beginProtectedResponseEnvelope>> | undefined;
    let capsulePrivacyFailed = false;
    let safeSession = d.safeSession;
    try {
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "safe_context_parking",
        facts: identity,
      });
      await d.gate.prepare(transaction.operationId, {
        mode: "protected_recording_gap",
        videoMaskEstablished: false,
      });
      safeSession.provenance.transition("safe_parked");
      await d.onContextProvenance?.({
        contextId: safeSession.provenance.contextId,
        provenance: "safe_parked",
        operationId: transaction.operationId,
      });
      await d.gate.beginProtected();
      facts.evidence = "stopped";

      facts.bootstrap = { status: "running" };
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "capsule_bootstrapping",
      });
      let storageState: Awaited<ReturnType<SafeBrowserSession["context"]["storageState"]>>;
      let sessionStorageState: { origin: string; entries: Array<[string, string]> };
      try {
        // IndexedDB serialization is optional for capsule handoff. Some applications keep
        // non-serializable values there; cookies and web storage remain the portable auth state.
        storageState = await safeSession.context
          .storageState({ indexedDB: true })
          .catch(() => safeSession.context.storageState());
      } catch {
        throw new PhaseError("PROTECTED_PORTABLE_STATE_EXPORT_FAILED", "bootstrap", "safe_to_retry");
      }
      try {
        sessionStorageState = {
          origin: new URL(safeSession.page.url()).origin,
          entries: await safeSession.page.evaluate(() => Object.entries(sessionStorage)),
        };
      } catch {
        throw new PhaseError("PROTECTED_SESSION_STATE_EXPORT_FAILED", "bootstrap", "safe_to_retry");
      }
      try {
        capsule = await abortable(
          d.capsuleFactory.create({
            storageState,
            sessionStorage: sessionStorageState,
            prepare: d.prepareCapsule,
          }),
          d.signal,
        );
      } catch {
        throw new PhaseError("PROTECTED_CAPSULE_CREATION_FAILED", "bootstrap", "safe_to_retry");
      }
      facts.capsule = "active";
      await d.onContextProvenance?.({
        contextId: capsule.provenance.contextId,
        provenance: "protected",
        operationId: transaction.operationId,
      });
      try {
        await capsule.page.goto(transaction.entry.url, { waitUntil: "domcontentloaded" });
      } catch {
        throw new PhaseError("TRANSACTION_ENTRY_NAVIGATION_FAILED", "bootstrap", "safe_to_retry");
      }
      for (const assertion of transaction.entry.assertions) {
        try {
          await d.verifyAssertions(capsule.page, [assertion]);
        } catch {
          throw new PhaseError(
            `TRANSACTION_ENTRY_${assertion.type.toUpperCase()}_ASSERTION_FAILED`,
            "bootstrap",
            "safe_to_retry",
          );
        }
      }
      facts.bootstrap = { status: "succeeded" };
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "capsule_ready",
        facts: { capsuleContextId: capsule.provenance.contextId, bootstrap: "succeeded" },
      });

      facts.preparation = { status: "running" };
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "preparation_running",
      });
      const observedEffects: Array<{
        method: string;
        origin: string;
        path: string;
        disposition: "ignored" | "blocked";
        category?: "telemetry" | "platform";
      }> = [];
      const observePreparationEffect = (request: { method(): string; url(): string }) => {
        const method = request.method().toUpperCase();
        if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
        try {
          const url = new URL(request.url());
          const ignored = transaction.preparation.effectPolicy.ignoredRequests.find(
            (rule) =>
              rule.origin === url.origin &&
              rule.methods.includes(method as "POST" | "PUT" | "PATCH" | "DELETE") &&
              url.pathname.startsWith(rule.pathPrefix),
          );
          const passiveCategory = ignored
            ? undefined
            : classifyPassivePreparationRequest({
                method,
                url,
                allowedOrigins: d.allowedOrigins,
              });
          observedEffects.push({
            method,
            origin: url.origin,
            path: url.pathname,
            disposition: ignored || passiveCategory ? "ignored" : "blocked",
            ...(ignored
              ? { category: ignored.category }
              : passiveCategory
                ? { category: passiveCategory }
                : {}),
          });
        } catch {
          observedEffects.push({
            method,
            origin: "opaque",
            path: "opaque",
            disposition: "blocked",
          });
        }
      };
      capsule.page.on("request", observePreparationEffect);
      try {
        await executeProtectedPreparation(capsule.page, transaction, d);
        await verifyProtectedTransactionAssertions(
          capsule.page,
          transaction.preparation.assertions,
          transaction,
          d,
        );
        if (observedEffects.some((effect) => effect.disposition === "blocked"))
          throw new PhaseError("UNDECLARED_PREPARATION_SIDE_EFFECT", "preparation", "do_not_retry");
        // Calibration records the transaction boundary after deterministic preparation.
        // Production must verify at that identical boundary, never at capsule entry.
        await d.verifyCalibration?.(capsule, transaction);
      } catch (error) {
        const failure =
          error instanceof PhaseError
            ? error
            : error instanceof CalibrationRequiredError
              ? new PhaseError("CALIBRATION_REQUIRED", "preparation", "do_not_retry")
              : new PhaseError("REQUIRED_STATE_NOT_ESTABLISHED", "preparation", "safe_to_retry");
        facts.preparation = { status: "failed", code: failure.code };
        throw failure;
      } finally {
        facts.preparationEffects = observedEffects.map((effect) => ({
          method: ["POST", "PUT", "PATCH", "DELETE"].includes(effect.method)
            ? (effect.method as "POST" | "PUT" | "PATCH" | "DELETE")
            : "OTHER",
          origin: effect.origin,
          path: effect.path,
          disposition: effect.disposition,
          ...(effect.category ? { category: effect.category } : {}),
        }));
        capsule.page.off("request", observePreparationEffect);
      }
      facts.preparation = { status: "succeeded" };
      await d.onPreparationVerified?.(capsule, transaction);
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "preparation_verified",
        facts: { preparation: "succeeded" },
      });

      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "acquisition_readiness_validating",
      });
      await verifyProtectedAcquisitionReadiness(capsule.page, transaction);
      await verifyProtectedRevealTarget(capsule.page, transaction);
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "acquisition_ready",
        facts: {
          acquisitionContractDigest: protectedTransactionDigest(transaction, d.allowedOrigins),
        },
      });

      await heartbeat();
      assertOwned();

      if (claim.state === "preparing") {
        claim = await d.store.transition({
          id: claim.id, operationId: transaction.operationId, version: claim.version,
          fencingToken: claim.fencingToken, expected: "preparing", next: "ready_to_dispatch",
          phase: "ready_to_dispatch",
        });
      }
      facts.mutation.dispatch = "authorized";
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "dispatch_authorized",
      });
      claim = await d.store.transition({
        id: claim.id, operationId: transaction.operationId, version: claim.version,
        fencingToken: claim.fencingToken, expected: "ready_to_dispatch", next: "dispatching",
        phase: "mutation_dispatching",
      });
      responseEnvelope = beginProtectedResponseEnvelope(
        capsule.page,
        d.allowedOrigins,
        d.redactor,
        d.stageResponseOutputsAtomically
          ? {
              outputs: transaction.extraction.outputs,
              stage: (outputs) => d.stageResponseOutputsAtomically!({
                operationId: transaction.operationId,
                claim,
                outputs,
              }),
            }
          : undefined,
      );
      await d.onMutationDispatch?.();
      facts.mutation.dispatch = "started";
      capsule.provenance.transition("tainted");
      await d.onContextProvenance?.({
        contextId: capsule.provenance.contextId,
        provenance: "tainted",
        operationId: transaction.operationId,
      });
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "mutation_dispatching",
      });
      await abortable(
        executeProtectedReveal(capsule.page, transaction, d.allowedOrigins, composeAbortSignals(d.signal, leaseController.signal)),
        composeAbortSignals(d.signal, leaseController.signal),
      );
      await responseEnvelope.settle();
      assertOwned();
      claim = await d.store.transition({
        id: claim.id, operationId: transaction.operationId, version: claim.version,
        fencingToken: claim.fencingToken, expected: "dispatching", next: "dispatched",
        phase: "mutation_dispatched",
      });
      claim = await d.store.transition({
        id: claim.id, operationId: transaction.operationId, version: claim.version,
        fencingToken: claim.fencingToken, expected: "dispatched", next: "acquiring",
        phase: "acquisition_running",
      });
      facts.mutation.dispatch = "acknowledged";
      facts.mutation.outcome = "unknown";

      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "acquisition_running",
      });
      const acquired = await acquireProtectedOutputs(capsule.page, transaction, d, facts);
      assertOwned();
      claim = await d.store.transition({
        id: claim.id, operationId: transaction.operationId, version: claim.version,
        fencingToken: claim.fencingToken, expected: "acquiring", next: "persisting",
        phase: "persistence_running",
      });
      claim = await persistAcquiredProtectedOutputs(transaction, d, facts, acquired, claim);
      if (!protectedOutputsPersisted(transaction, facts))
        await recoverProtectedAcquisition(capsule.page, transaction, d, facts, claim);
      if (protectedOutputsPersisted(transaction, facts))
        facts.mutation.outcome = "confirmed_succeeded";
    } catch (error) {
      const failure = protectedPhaseFailure(error, facts);
      facts.reasonCode = failure.code;
      facts.failurePhase = failure.phase;
      facts.retryClass = failure.retryClass;
      if (facts.bootstrap.status === "running")
        facts.bootstrap = { status: "failed", code: failure.code };
      if (facts.preparation.status === "running")
        facts.preparation = { status: "failed", code: failure.code };
      if (facts.mutation.dispatch !== "not_started") {
        const readOnly = transaction.mutation.dispatchSemantics === "read_only";
        facts.mutation.outcome = readOnly ? "confirmed_not_applied" : "unknown";
        if (readOnly) {
          facts.retryClass = "safe_to_retry";
          if (["dispatching", "dispatched", "acquiring", "persisting", "persisted", "reconciling"].includes(claim.state)) {
            claim = await d.store.transition({
              id: claim.id, operationId: transaction.operationId, version: claim.version,
              fencingToken: claim.fencingToken, expected: claim.state, next: "failed_not_applied",
              phase: "failed_not_applied", reasonCode: failure.code,
            }).catch(() => claim);
          }
        }
        if (!readOnly && ["dispatching", "dispatched", "acquiring", "persisting", "persisted", "reconciling"].includes(claim.state)) {
          claim = await d.store.transition({
            id: claim.id, operationId: transaction.operationId, version: claim.version,
            fencingToken: claim.fencingToken, expected: claim.state, next: "recovery_required",
            phase: "recovery_required", reasonCode: failure.code,
          }).catch(() => claim);
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await heartbeatWork;
      await responseEnvelope?.close().catch(() => undefined);
      if (capsule) {
        try {
          await capsule.clipboardCollector.finalize();
        } catch {
          capsulePrivacyFailed = true;
          facts.reasonCode = "VEIL_CLIPBOARD_CLEANUP_FAILED";
          facts.failurePhase = "capsule_destruction";
          facts.retryClass = "manual_review";
        }
        try {
          facts.capsule = await capsule.destroy();
          await d.onContextProvenance?.({
            contextId: capsule.provenance.contextId,
            provenance: "destroyed",
            operationId: transaction.operationId,
          });
        } catch {
          facts.capsule = "destruction_failed";
          facts.reasonCode = "CAPSULE_DESTRUCTION_FAILED";
          facts.failurePhase = "capsule_destruction";
          facts.retryClass = "manual_review";
        }
      }
    }

    facts.protectedAcquisitionEvidence =
      facts.capsule === "destroyed" || facts.capsule === "force_terminated"
        ? facts.protectedAcquisitionEvidence.map((evidence) => ({
            ...evidence,
            capsule: facts.capsule as "destroyed" | "force_terminated",
            evidenceClosure: "sealed" as const,
          }))
        : [];

    if (facts.mutation.dispatch === "not_started" && facts.reasonCode) {
      if (["planned", "preparing", "ready_to_dispatch"].includes(claim.state)) {
        claim = await d.store.transition({
          id: claim.id, operationId: transaction.operationId, version: claim.version,
          fencingToken: claim.fencingToken, expected: claim.state, next: "failed_not_applied",
          phase: "failed_not_applied", reasonCode: facts.reasonCode,
          facts: { preparationEffects: facts.preparationEffects },
        });
      }
      await d.gate.seal({ code: facts.reasonCode });
      await this.persistFinal(transaction, claim.fencingToken, "aborted", facts);
      return {
        safeSession,
        terminal: true,
        result: result(
          facts,
          "aborted",
          facts.retryClass === "safe_to_retry" ? ["retry_transaction", "abort"] : ["abort"],
        ),
      };
    }

    const persistenceComplete = transaction.extraction.outputs.every((output) =>
      output.acquisition.objective?.kind === "verify_user_copy_experience"
        ? facts.protectedAcquisitionEvidence.some(
            (evidence) =>
              evidence.reference === output.reference &&
              evidence.outcome === "copy_experience_verified",
          )
        : output.classification === "protected"
          ? facts.protectedPersistence === "confirmed"
          : facts.publicPersistence === "confirmed",
    );
    if (capsulePrivacyFailed || facts.capsule === "destruction_failed" || !persistenceComplete) {
      if (facts.capsule === "destruction_failed" || capsulePrivacyFailed) {
        await Promise.all(Object.values(facts.credentialReferences).map((credentialId) =>
          d.markCredentialCompromised?.(credentialId, facts.reasonCode ?? "CAPSULE_DESTRUCTION_FAILED", transaction.operationId),
        ));
        if (Object.keys(facts.credentialReferences).length) facts.credentialSecurity = "compromised";
      }
      facts.reconciliation = transaction.mutation.dispatchSemantics === "read_only"
        ? "not_applied"
        : await reconcileProtectedMutation(safeSession, transaction, claim.fencingToken, facts, d);
      await d.gate.seal({ code: facts.reasonCode ?? "PROTECTED_TRANSACTION_FAILED" });
      if (["persisted", "reconciling"].includes(claim.state)) {
        claim = await d.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: claim.state, next: "recovery_required", phase: "recovery_required", reasonCode: facts.reasonCode ?? "PROTECTED_TRANSACTION_FAILED" });
      }
      const status = facts.mutation.outcome === "unknown" ? "outcome_unknown" : "aborted";
      await this.persistFinal(transaction, claim.fencingToken, status, facts);
      return {
        safeSession,
        terminal: true,
        result: result(
          facts,
          status,
          facts.mutation.outcome === "unknown" ? ["manual_reconciliation", "abort"] : ["retry_transaction", "abort"],
        ),
      };
    }

    await d.gate.markCaptured();
    if (claim.state === "persisted") {
      claim = await d.store.transition({
        id: claim.id, operationId: transaction.operationId, version: claim.version,
        fencingToken: claim.fencingToken, expected: "persisted", next: "reconciling",
        phase: "reconciliation",
      });
    }
    facts.reconciliation = await reconcileProtectedMutation(
      safeSession,
      transaction,
      claim.fencingToken,
      facts,
      d,
    );
    if (facts.reconciliation === "not_applied" || facts.reconciliation === "failed") {
      await d.gate.seal({ code: "MUTATION_RECONCILIATION_FAILED" });
      if (claim.state === "reconciling") claim = await d.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: "reconciling", next: "recovery_required", phase: "recovery_required", reasonCode: "MUTATION_RECONCILIATION_FAILED" });
      await this.persistFinal(transaction, claim.fencingToken, "aborted", facts);
      return {
        safeSession,
        terminal: true,
        result: result(facts, "aborted", ["manual_reconciliation", "abort"]),
      };
    }

    const continuation = await continueAfterProtectedMutation(transaction, safeSession, d);
    safeSession = continuation.safeSession;
    facts.continuation = continuation.status;
    if (continuation.status === "terminal") {
      await d.gate.seal({ code: "TERMINAL_PROTECTED_TRANSACTION" });
      if (claim.state === "reconciling") claim = await d.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: "reconciling", next: "completed", phase: "completed" });
      await this.persistFinal(transaction, claim.fencingToken, "terminal", facts);
      return { safeSession, terminal: true, result: result(facts, "terminal", []) };
    }
    if (continuation.status === "continuing_unrecorded") {
      facts.evidence = "permanently_suppressed";
      facts.protectedAcquisitionEvidence = facts.protectedAcquisitionEvidence.map((evidence) => ({
        ...evidence,
        evidenceClosure: "permanently_suppressed",
      }));
      await d.gate.seal({ code: "CONTINUING_UNRECORDED" });
      await d.gate.terminate("continuing_unrecorded");
      if (claim.state === "reconciling") claim = await d.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: "reconciling", next: "completed", phase: "completed" });
      await this.persistFinal(transaction, claim.fencingToken, "continuing_unrecorded", facts);
      return {
        safeSession,
        terminal: false,
        result: result(facts, "continuing_unrecorded", ["abort"]),
      };
    }
    if (continuation.status === "failed" || !continuation.continuedAtStepId) {
      await d.gate.seal({ code: "CONTINUATION_FAILED" });
      if (claim.state === "reconciling") claim = await d.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: "reconciling", next: "recovery_required", phase: "recovery_required", reasonCode: "CONTINUATION_FAILED" });
      await this.persistFinal(transaction, claim.fencingToken, "aborted", facts);
      return {
        safeSession,
        terminal: true,
        result: result(facts, "aborted", ["retry_continuation", "abort"]),
      };
    }
    await d.gate.beginSafeBoundary();
    await d.gate.confirmSafeBoundary({
      kind: "protected_context_destroyed",
      contextId: capsule?.provenance.contextId ?? randomUUID(),
    });
    facts.evidence = "resumed";
    facts.protectedAcquisitionEvidence = facts.protectedAcquisitionEvidence.map((evidence) => ({
      ...evidence,
      capsule: facts.capsule === "force_terminated" ? "force_terminated" : "destroyed",
      evidenceClosure: "resumed",
    }));
    await d.onContextProvenance?.({
      contextId: safeSession.provenance.contextId,
      provenance: safeSession.provenance.value(),
      operationId: transaction.operationId,
    });
    await d.onEvidenceResumed?.({
      contextId: safeSession.provenance.contextId,
      operationId: transaction.operationId,
      continuedAtStepId: continuation.continuedAtStepId,
    });
    if (claim.state === "reconciling") {
      claim = await d.store.transition({
        id: claim.id, operationId: transaction.operationId, version: claim.version,
        fencingToken: claim.fencingToken, expected: "reconciling", next: "completed",
        phase: "completed",
      });
    }
    await this.persistFinal(transaction, claim.fencingToken, "completed", facts);
    return {
      safeSession,
      terminal: false,
      result: result(facts, "completed", [], continuation.continuedAtStepId),
    };
  }

  private async outcomeUnknown(
    transaction: ProtectedTransaction,
    fencingToken: number,
  ): Promise<ProtectedTransactionExecution> {
    await this.dependencies.gate.seal({ code: "MUTATION_OUTCOME_UNKNOWN" });
    const facts = initialFacts();
    facts.mutation.outcome = "unknown";
    facts.reasonCode = "MUTATION_OUTCOME_UNKNOWN";
    facts.retryClass = "retry_requires_reconciliation";
    await this.persistFinal(transaction, fencingToken, "outcome_unknown", facts);
    return {
      safeSession: this.dependencies.safeSession,
      terminal: true,
      result: result(facts, "outcome_unknown", ["manual_reconciliation", "abort"]),
    };
  }

  private async storedTerminal(
    transaction: ProtectedTransaction,
    claim: ProtectedOperationClaim,
  ): Promise<ProtectedTransactionExecution> {
    const facts = initialFacts();
    const references = claim.persistedReferences ?? {};
    for (const [reference, stored] of Object.entries(references)) {
      if (stored.classification === "protected" && stored.credentialId)
        facts.credentialReferences[reference] = stored.credentialId;
      if (stored.classification === "public" && stored.valueId)
        facts.publicValueReferences[reference] = stored.valueId;
    }
    if (claim.state === "completed") {
      facts.mutation.dispatch = "acknowledged";
      facts.mutation.outcome = "confirmed_succeeded";
      facts.protectedPersistence = Object.values(references).some((value) => value.classification === "protected") ? "confirmed" : "not_attempted";
      facts.publicPersistence = Object.values(references).some((value) => value.classification === "public") ? "confirmed" : "not_attempted";
      facts.capsule = "destroyed";
      return { safeSession: this.dependencies.safeSession, terminal: false, result: result(facts, "completed", []) };
    }
    facts.reasonCode = claim.state === "failed_not_applied" ? "PROTECTED_OPERATION_NOT_APPLIED" : "PROTECTED_OPERATION_TERMINAL";
    facts.mutation.outcome = claim.state === "failed_not_applied" ? "not_attempted" : "unknown";
    return { safeSession: this.dependencies.safeSession, terminal: true, result: result(facts, claim.state === "failed_not_applied" ? "aborted" : "outcome_unknown", []) };
  }

  private async recoverDurable(
    transaction: ProtectedTransaction,
    claim: ProtectedOperationClaim,
  ): Promise<ProtectedTransactionExecution> {
    const facts = initialFacts();
    facts.mutation.dispatch = "acknowledged";
    facts.mutation.outcome = "unknown";
    facts.capsule = "force_terminated";
    const references = claim.persistedReferences ?? {};
    for (const [reference, stored] of Object.entries(references)) {
      if (stored.classification === "protected" && stored.credentialId) facts.credentialReferences[reference] = stored.credentialId;
      if (stored.classification === "public" && stored.valueId) facts.publicValueReferences[reference] = stored.valueId;
    }
    let completeSet = transaction.extraction.outputs.every((output) => output.reference in references);
    if (!completeSet && claim.state === "recovery_required" && this.dependencies.recoverStagedResponseOutputs) {
      const staged = await this.dependencies.recoverStagedResponseOutputs({
        operationId: transaction.operationId,
        claim,
      });
      if (staged?.length) {
        claim = await this.dependencies.store.transition({
          id: claim.id,
          operationId: transaction.operationId,
          version: claim.version,
          fencingToken: claim.fencingToken,
          expected: "recovery_required",
          next: "acquiring",
          phase: "staged_response_recovery",
        });
        claim = await this.dependencies.store.transition({
          id: claim.id,
          operationId: transaction.operationId,
          version: claim.version,
          fencingToken: claim.fencingToken,
          expected: "acquiring",
          next: "persisting",
          phase: "persistence_running",
        });
        const acquired = staged.map((output) => ({
          output: transaction.extraction.outputs.find((candidate) => candidate.reference === output.reference)!,
          value: output.value,
          adapter: "protected_network_value" as const,
        }));
        if (acquired.length === transaction.extraction.outputs.length && acquired.every((item) => item.output)) {
          claim = await persistAcquiredProtectedOutputs(transaction, this.dependencies, facts, acquired, claim);
          completeSet = transaction.extraction.outputs.every((output) => output.reference in (claim.persistedReferences ?? {}));
          for (const [reference, stored] of Object.entries(claim.persistedReferences ?? {})) {
            if (stored.classification === "protected" && stored.credentialId) facts.credentialReferences[reference] = stored.credentialId;
            if (stored.classification === "public" && stored.valueId) facts.publicValueReferences[reference] = stored.valueId;
          }
        }
      }
    }
    if (!completeSet || claim.state === "compromised") {
      for (const credentialId of Object.values(facts.credentialReferences))
        await this.dependencies.markCredentialCompromised?.(credentialId, "PROTECTED_ACQUISITION_INTERRUPTED", transaction.operationId);
      if (!["recovery_required", "compromised"].includes(claim.state)) {
        claim = await this.dependencies.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: claim.state, next: "recovery_required", phase: "recovery_required", reasonCode: "PROTECTED_ACQUISITION_INTERRUPTED" });
      }
      if (claim.state === "recovery_required") {
        claim = await this.dependencies.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: "recovery_required", next: "compromised", phase: "compromised", reasonCode: "PROTECTED_ACQUISITION_INTERRUPTED" });
      }
      facts.credentialSecurity = Object.keys(facts.credentialReferences).length ? "compromised" : "none";
      facts.reasonCode = "PROTECTED_ACQUISITION_INTERRUPTED";
      facts.retryClass = "do_not_retry";
      return { safeSession: this.dependencies.safeSession, terminal: true, result: result(facts, "outcome_unknown", ["manual_reconciliation", "abort"]) };
    }
    if (claim.state === "persisted" || claim.state === "recovery_required") {
      claim = await this.dependencies.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: claim.state, next: "reconciling", phase: "reconciliation" });
    }
    if (claim.state !== "reconciling") return this.outcomeUnknown(transaction, claim.fencingToken);
    facts.protectedPersistence = Object.values(references).some((stored) => stored.classification === "protected") ? "confirmed" : "not_attempted";
    facts.publicPersistence = Object.values(references).some((stored) => stored.classification === "public") ? "confirmed" : "not_attempted";
    facts.reconciliation = await reconcileProtectedMutation(this.dependencies.safeSession, transaction, claim.fencingToken, facts, this.dependencies);
    if (facts.reconciliation !== "succeeded") {
      claim = await this.dependencies.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: "reconciling", next: "recovery_required", phase: "recovery_required", reasonCode: "MUTATION_RECONCILIATION_REQUIRED" });
      facts.reasonCode = "MUTATION_RECONCILIATION_REQUIRED";
      return { safeSession: this.dependencies.safeSession, terminal: true, result: result(facts, "outcome_unknown", ["manual_reconciliation", "abort"]) };
    }
    claim = await this.dependencies.store.transition({ id: claim.id, operationId: transaction.operationId, version: claim.version, fencingToken: claim.fencingToken, expected: "reconciling", next: "completed", phase: "completed" });
    facts.mutation.outcome = "confirmed_succeeded";
    facts.credentialSecurity = Object.keys(facts.credentialReferences).length ? "active" : "none";
    return { safeSession: this.dependencies.safeSession, terminal: false, result: result(facts, "completed", []) };
  }

  private async persistFinal(
    transaction: ProtectedTransaction,
    fencingToken: number,
    phase: string,
    facts: Facts,
  ) {
    await this.dependencies.store.record({
      operationId: transaction.operationId,
      fencingToken,
      phase,
      facts: { ...facts, diagnostics: undefined },
    });
  }
}

function protectedPhaseFailure(error: unknown, facts: Facts) {
  if (error instanceof PhaseError) return error;
  const phase =
    facts.mutation.dispatch === "started"
      ? "mutation_dispatch"
      : facts.preparation.status === "running"
        ? "preparation"
        : "bootstrap";
  if (error instanceof CalibrationRequiredError)
    return new PhaseError("CALIBRATION_REQUIRED", phase, "do_not_retry");
  const candidate =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : error instanceof Error
        ? error.message
        : undefined;
  const code =
    typeof candidate === "string" && /^[A-Z][A-Z0-9_]*$/.test(candidate)
      ? candidate
      : "PROTECTED_TRANSACTION_FAILED";
  return new PhaseError(
    code,
    phase,
    facts.mutation.dispatch === "started" ? "retry_requires_reconciliation" : "safe_to_retry",
  );
}

/** Kept as a domain alias while callers are cut over to the kernel name. */
export class ProtectedTransactionCoordinator extends ProtectedTransactionKernel {}

export type ProtectedTransactionFacts = ReturnType<typeof initialFacts>;
type Facts = ProtectedTransactionFacts;
function initialFacts() {
  return {
    bootstrap: { status: "not_started" as const },
    preparation: { status: "not_started" as const },
    mutation: { dispatch: "not_started" as const, outcome: "not_attempted" as const },
    protectedExtraction: "not_attempted" as const,
    publicExtraction: "not_attempted" as const,
    protectedPersistence: "not_attempted" as const,
    publicPersistence: "not_attempted" as const,
    capsule: "not_created" as const,
    reconciliation: "not_configured" as const,
    continuation: "not_attempted" as const,
    evidence: "stopped" as const,
    credentialSecurity: "none" as const,
    credentialReferences: {} as Record<string, string>,
    publicValueReferences: {} as Record<string, string>,
    preparationEffects: [] as ProtectedTransactionResult["preparationEffects"],
    diagnostics: [] as ProtectedTransactionResult["diagnostics"],
    protectedAcquisitionEvidence: [] as ProtectedTransactionResult["protectedAcquisitionEvidence"],
    reasonCode: undefined as string | undefined,
    failurePhase: undefined as string | undefined,
    retryClass: undefined as string | undefined,
  } as unknown as ProtectedTransactionResult & { failurePhase?: string; retryClass?: string };
}
function result(
  facts: Facts,
  status: ProtectedTransactionResult["status"],
  safeActions: ProtectedTransactionResult["safeActions"],
  continuedAtStepId?: string,
): ProtectedTransactionResult {
  return { ...facts, status, safeActions, ...(continuedAtStepId ? { continuedAtStepId } : {}) };
}
function digests(transaction: ProtectedTransaction, allowedOrigins: string[]) {
  return {
    programDigest: protectedTransactionDigest(transaction, allowedOrigins),
    inputSchemaDigest: transactionInputSchemaDigest(transaction),
    inputDigest: transactionInputDigest(transaction),
  };
}

function composeAbortSignals(first: AbortSignal | undefined, second: AbortSignal) {
  return first ? AbortSignal.any([first, second]) : second;
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("RUN_ABORTED"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("RUN_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
