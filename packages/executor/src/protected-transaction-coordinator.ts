import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { Assertion, ProtectedTransaction, ProtectedTransactionResult } from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";
import type { ProtectedBrowserSession, SafeBrowserSession } from "./browser-session.js";
import { executeProtectedReveal } from "./protected-extractor.js";
import {
  CalibrationRequiredError,
  protectedTransactionDigest,
  transactionInputDigest,
  transactionInputSchemaDigest,
} from "./calibration.js";
import type { VeilRuntimeCoordinator } from "@scry/veil";
import type { CapsuleFactory } from "./protected-capsule-factory.js";
export { PlaywrightProtectedCapsuleFactory } from "./protected-capsule-factory.js";
export type { CapsuleFactory } from "./protected-capsule-factory.js";
import { ProtectedTransactionPhaseError as PhaseError } from "./protected-transaction-errors.js";
import {
  executeProtectedPreparation,
  verifyProtectedTransactionAssertions,
} from "./protected-transaction-preparation.js";
import {
  extractAndPersistProtectedOutputs,
  protectedOutputsPersisted,
  recoverProtectedAcquisition,
  verifyProtectedAcquisitionReadiness,
} from "./protected-transaction-acquisition.js";
import {
  continueAfterProtectedMutation,
  reconcileProtectedMutation,
} from "./protected-transaction-post-dispatch.js";

export type MutationLedgerState =
  | "planned"
  | "dispatch_authorized"
  | "dispatching"
  | "dispatched"
  | "acknowledged"
  | "reconciled_succeeded"
  | "reconciled_not_applied"
  | "outcome_unknown";
export type ProtectedTransactionStore = {
  claim(input: {
    operationId: string;
    mutationKind: "one_time" | "repeatable";
    programDigest: string;
    inputSchemaDigest: string;
    inputDigest: string;
  }): Promise<{ state: MutationLedgerState; fencingToken: number }>;
  transition(input: {
    operationId: string;
    fencingToken: number;
    expected: MutationLedgerState;
    next: MutationLedgerState;
  }): Promise<boolean>;
  record(input: {
    operationId: string;
    fencingToken: number;
    phase: string;
    facts?: Record<string, unknown>;
  }): Promise<void>;
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
  resolveKnownSecret(reference: string): Promise<string>;
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
    const claim = await d.store.claim({
      operationId: transaction.operationId,
      mutationKind: transaction.mutation.kind,
      ...identity,
    });
    if (claim.state !== "planned") return this.outcomeUnknown(transaction, claim.fencingToken);
    const facts = initialFacts();
    let capsule: ProtectedBrowserSession | undefined;
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
      capsule = await abortable(
        d.capsuleFactory.create({
          storageState: await safeSession.context.storageState({ indexedDB: true }),
          prepare: d.prepareCapsule,
        }),
        d.signal,
      );
      facts.capsule = "active";
      await d.onContextProvenance?.({
        contextId: capsule.provenance.contextId,
        provenance: "protected",
        operationId: transaction.operationId,
      });
      await capsule.page.goto(transaction.entry.url, { waitUntil: "domcontentloaded" });
      await d.verifyAssertions(capsule.page, transaction.entry.assertions);
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
          observedEffects.push({
            method,
            origin: url.origin,
            path: url.pathname,
            disposition: ignored ? "ignored" : "blocked",
            ...(ignored ? { category: ignored.category } : {}),
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
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "acquisition_ready",
        facts: {
          acquisitionContractDigest: protectedTransactionDigest(transaction, d.allowedOrigins),
        },
      });

      if (
        !(await d.store.transition({
          operationId: transaction.operationId,
          fencingToken: claim.fencingToken,
          expected: "planned",
          next: "dispatch_authorized",
        }))
      )
        throw new PhaseError("MUTATION_LEDGER_CONFLICT", "mutation_dispatch", "manual_review");
      facts.mutation.dispatch = "authorized";
      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "dispatch_authorized",
      });
      if (
        !(await d.store.transition({
          operationId: transaction.operationId,
          fencingToken: claim.fencingToken,
          expected: "dispatch_authorized",
          next: "dispatching",
        }))
      )
        throw new PhaseError("MUTATION_LEDGER_CONFLICT", "mutation_dispatch", "manual_review");
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
        executeProtectedReveal(capsule.page, transaction, d.allowedOrigins, d.signal),
        d.signal,
      );
      if (
        !(await d.store.transition({
          operationId: transaction.operationId,
          fencingToken: claim.fencingToken,
          expected: "dispatching",
          next: "dispatched",
        }))
      )
        throw new PhaseError("MUTATION_LEDGER_CONFLICT", "mutation_dispatch", "manual_review");
      await d.store.transition({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        expected: "dispatched",
        next: "acknowledged",
      });
      facts.mutation.dispatch = "acknowledged";
      facts.mutation.outcome = "unknown";

      await d.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "acquisition_running",
      });
      await extractAndPersistProtectedOutputs(capsule.page, transaction, d, facts);
      if (!protectedOutputsPersisted(transaction, facts))
        await recoverProtectedAcquisition(capsule.page, transaction, d, facts, claim.fencingToken);
      if (protectedOutputsPersisted(transaction, facts))
        facts.mutation.outcome = "confirmed_succeeded";
    } catch (error) {
      const failure =
        error instanceof PhaseError
          ? error
          : error instanceof CalibrationRequiredError
            ? new PhaseError(
                "CALIBRATION_REQUIRED",
                facts.preparation.status === "running" ? "preparation" : "bootstrap",
                "do_not_retry",
              )
            : new PhaseError(
                "PROTECTED_TRANSACTION_FAILED",
                facts.mutation.dispatch === "started"
                  ? "mutation_dispatch"
                  : facts.preparation.status === "running"
                    ? "preparation"
                    : "bootstrap",
                facts.mutation.dispatch === "started"
                  ? "retry_requires_reconciliation"
                  : "safe_to_retry",
              );
      facts.reasonCode = failure.code;
      facts.failurePhase = failure.phase;
      facts.retryClass = failure.retryClass;
      if (facts.bootstrap.status === "running")
        facts.bootstrap = { status: "failed", code: failure.code };
      if (facts.preparation.status === "running")
        facts.preparation = { status: "failed", code: failure.code };
      if (facts.mutation.dispatch === "started") {
        facts.mutation.outcome = "unknown";
        await d.store
          .transition({
            operationId: transaction.operationId,
            fencingToken: claim.fencingToken,
            expected: "dispatching",
            next: "outcome_unknown",
          })
          .catch(() => false);
      }
    } finally {
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

    if (facts.mutation.dispatch === "not_started" && facts.reasonCode) {
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
      output.classification === "protected"
        ? facts.protectedPersistence === "confirmed"
        : facts.publicPersistence === "confirmed",
    );
    if (capsulePrivacyFailed || facts.capsule === "destruction_failed" || !persistenceComplete) {
      facts.reconciliation = await reconcileProtectedMutation(
        safeSession,
        transaction,
        claim.fencingToken,
        facts,
        d,
      );
      await d.gate.seal({ code: facts.reasonCode ?? "PROTECTED_TRANSACTION_FAILED" });
      const status = facts.mutation.outcome === "unknown" ? "outcome_unknown" : "aborted";
      await this.persistFinal(transaction, claim.fencingToken, status, facts);
      return {
        safeSession,
        terminal: true,
        result: result(
          facts,
          status,
          facts.mutation.outcome === "unknown" ? ["manual_reconciliation", "abort"] : ["abort"],
        ),
      };
    }

    await d.gate.markCaptured();
    facts.reconciliation = await reconcileProtectedMutation(
      safeSession,
      transaction,
      claim.fencingToken,
      facts,
      d,
    );
    if (facts.reconciliation === "not_applied" || facts.reconciliation === "failed") {
      await d.gate.seal({ code: "MUTATION_RECONCILIATION_FAILED" });
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
      await this.persistFinal(transaction, claim.fencingToken, "terminal", facts);
      return { safeSession, terminal: true, result: result(facts, "terminal", []) };
    }
    if (continuation.status === "continuing_unrecorded") {
      facts.evidence = "permanently_suppressed";
      await d.gate.seal({ code: "CONTINUING_UNRECORDED" });
      await d.gate.terminate("continuing_unrecorded");
      await this.persistFinal(transaction, claim.fencingToken, "continuing_unrecorded", facts);
      return {
        safeSession,
        terminal: false,
        result: result(facts, "continuing_unrecorded", ["abort"]),
      };
    }
    if (continuation.status === "failed" || !continuation.continuedAtStepId) {
      await d.gate.seal({ code: "CONTINUATION_FAILED" });
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
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("RUN_ABORTED"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("RUN_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
