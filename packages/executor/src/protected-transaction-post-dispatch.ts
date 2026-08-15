import type { ProtectedTransaction, ProtectedTransactionResult } from "@scry/contracts";
import { gotoPraxisPage, reloadPraxisPage } from "@scry/praxis";

import type { SafeBrowserSession } from "./browser-session.js";
import type {
  ProtectedTransactionDependencies,
  ProtectedTransactionFacts,
} from "./protected-transaction-coordinator.js";
import { verifyProtectedTransactionAssertions } from "./protected-transaction-preparation.js";
import { runProtectedStage } from "./protected-stage-supervisor.js";

export async function reconcileProtectedMutation(
  session: SafeBrowserSession,
  transaction: ProtectedTransaction,
  fencingToken: number,
  facts: ProtectedTransactionFacts,
  dependencies: ProtectedTransactionDependencies,
): Promise<ProtectedTransactionResult["reconciliation"]> {
  if (transaction.mutation.reconciliation.strategy === "none") return "not_configured";
  if (transaction.mutation.reconciliation.strategy === "persisted_outputs") {
    const persisted = transaction.mutation.reconciliation.requiredReferences.every(
      (reference) =>
        reference in facts.credentialReferences || reference in facts.publicValueReferences,
    );
    if (persisted) return "succeeded";
    return "unknown";
  }
  try {
    if (transaction.mutation.reconciliation.strategy === "public_ui_state") {
      await reloadPraxisPage(session.page, { waitUntil: "domcontentloaded" });
      await verifyProtectedTransactionAssertions(
        session.page,
        transaction.mutation.reconciliation.assertions,
        transaction,
        dependencies,
        "mutation_reconciliation",
      );
      return "succeeded";
    }
    const outcome = await runProtectedStage({
      stage: "custom_reconciliation", timeoutMs: transaction.extraction.timeoutMs,
      signal: dependencies.signal, timeoutCode: "PROTECTED_RECONCILIATION_TIMEOUT",
      dispatchPosition: "post_dispatch",
      work: () => dependencies.reconcile?.(session, transaction) ?? Promise.resolve("unknown" as const),
    });
    return outcome;
  } catch {
    return "failed";
  }
}

export async function continueAfterProtectedMutation(
  transaction: ProtectedTransaction,
  initial: SafeBrowserSession,
  dependencies: ProtectedTransactionDependencies,
) {
  let session = initial;
  for (const strategy of transaction.continuation.strategies) {
    try {
      if (strategy.mode === "resume_parked_context") {
        await gotoPraxisPage(session.page, strategy.reentryUrl, { waitUntil: "domcontentloaded" });
        await verifyProtectedTransactionAssertions(
          session.page,
          strategy.assertions,
          transaction,
          dependencies,
          "continuation",
        );
        session.provenance.transition("safe");
        return {
          safeSession: session,
          status: "parked_resumed" as const,
          continuedAtStepId: strategy.continueAtStepId,
        };
      }
      if (strategy.mode === "recreate_clean_context" && dependencies.recreateCleanSession) {
        session = await runProtectedStage({
          stage: "clean_session_recreation", timeoutMs: transaction.extraction.timeoutMs,
          signal: dependencies.signal, timeoutCode: "PROTECTED_CLEAN_SESSION_RECREATION_TIMEOUT",
          dispatchPosition: "post_dispatch",
          work: () => dependencies.recreateCleanSession!(strategy.checkpointId),
        });
        await gotoPraxisPage(session.page, strategy.reentryUrl, { waitUntil: "domcontentloaded" });
        await verifyProtectedTransactionAssertions(
          session.page,
          strategy.assertions,
          transaction,
          dependencies,
          "continuation",
        );
        if (session.provenance.value() === "restored_pending_verification")
          session.provenance.transition("restored_safe");
        return {
          safeSession: session,
          status: "clean_recreated" as const,
          continuedAtStepId: strategy.continueAtStepId,
        };
      }
      if (strategy.mode === "reauthenticate" && dependencies.reauthenticate) {
        session = await runProtectedStage({
          stage: "reauthentication", timeoutMs: transaction.extraction.timeoutMs,
          signal: dependencies.signal, timeoutCode: "PROTECTED_REAUTHENTICATION_TIMEOUT",
          dispatchPosition: "post_dispatch",
          work: () => dependencies.reauthenticate!(strategy.authenticationContractId),
        });
        await gotoPraxisPage(session.page, strategy.reentryUrl, { waitUntil: "domcontentloaded" });
        await verifyProtectedTransactionAssertions(
          session.page,
          strategy.assertions,
          transaction,
          dependencies,
          "continuation",
        );
        return {
          safeSession: session,
          status: "reauthenticated" as const,
          continuedAtStepId: strategy.continueAtStepId,
        };
      }
      if (strategy.mode === "continue_unrecorded") {
        return { safeSession: session, status: "continuing_unrecorded" as const };
      }
      if (strategy.mode === "terminal") {
        return { safeSession: session, status: "terminal" as const };
      }
    } catch {
      // Try only the next declared strategy.
    }
  }
  return { safeSession: session, status: "failed" as const };
}
