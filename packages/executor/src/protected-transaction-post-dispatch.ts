import type { ProtectedTransaction, ProtectedTransactionResult } from "@scry/contracts";

import type { SafeBrowserSession } from "./browser-session.js";
import type {
  ProtectedTransactionDependencies,
  ProtectedTransactionFacts,
} from "./protected-transaction-coordinator.js";
import { verifyProtectedTransactionAssertions } from "./protected-transaction-preparation.js";

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
    if (persisted) {
      await dependencies.store.transition({
        operationId: transaction.operationId,
        fencingToken,
        expected: "acknowledged",
        next: "reconciled_succeeded",
      });
      return "succeeded";
    }
    return "unknown";
  }
  try {
    if (transaction.mutation.reconciliation.strategy === "public_ui_state") {
      await session.page.reload({ waitUntil: "domcontentloaded" });
      await verifyProtectedTransactionAssertions(
        session.page,
        transaction.mutation.reconciliation.assertions,
        transaction,
        dependencies,
        "mutation_reconciliation",
      );
      await dependencies.store.transition({
        operationId: transaction.operationId,
        fencingToken,
        expected: "acknowledged",
        next: "reconciled_succeeded",
      });
      return "succeeded";
    }
    const outcome = (await dependencies.reconcile?.(session, transaction)) ?? "unknown";
    if (outcome === "succeeded") {
      await dependencies.store.transition({
        operationId: transaction.operationId,
        fencingToken,
        expected: "acknowledged",
        next: "reconciled_succeeded",
      });
    }
    if (outcome === "not_applied") {
      await dependencies.store.transition({
        operationId: transaction.operationId,
        fencingToken,
        expected: "acknowledged",
        next: "reconciled_not_applied",
      });
    }
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
        await session.page.goto(strategy.reentryUrl, { waitUntil: "domcontentloaded" });
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
        session = await dependencies.recreateCleanSession(strategy.checkpointId);
        await session.page.goto(strategy.reentryUrl, { waitUntil: "domcontentloaded" });
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
        session = await dependencies.reauthenticate(strategy.authenticationContractId);
        await session.page.goto(strategy.reentryUrl, { waitUntil: "domcontentloaded" });
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
