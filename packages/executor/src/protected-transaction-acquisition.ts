import type { ProtectedTransaction } from "@scry/contracts";
import { resolveTarget } from "@scry/praxis";
import type { Page } from "playwright";

import { acquireValue } from "./protected-extractor.js";
import type {
  ProtectedTransactionDependencies,
  ProtectedTransactionFacts,
} from "./protected-transaction-coordinator.js";
import { ProtectedTransactionPhaseError as PhaseError } from "./protected-transaction-errors.js";
import { runProtectedStage } from "@scry/praxis";

export async function verifyProtectedAcquisitionReadiness(
  page: Page,
  transaction: ProtectedTransaction,
) {
  const contract = transaction.acquisitionReadiness;
  for (const output of transaction.extraction.outputs) {
    for (const method of output.acquisition.permittedMethods) {
      if (!contract.approvedMethods.includes(method)) {
        throw new PhaseError("ACQUISITION_NOT_READY", "preparation", "do_not_retry");
      }
    }
  }
  try {
    const ceremony = await resolveTarget(page, contract.ceremonyIntent);
    // Agent-directed V2 operations always take the exact-reference branch. The
    // score check is retained only for historical whole-Flow drain fixtures.
    if (
      !contract.ceremonyIntent.authoritativeReference &&
      (ceremony.diagnostic.confidence < contract.minimumConfidence ||
        ceremony.diagnostic.confidenceMargin < contract.minimumConfidenceMargin)
    ) {
      throw new Error("legacy-confidence");
    }
  } catch {
    throw new PhaseError("ACQUISITION_NOT_READY", "preparation", "do_not_retry");
  }
}

export async function extractAndPersistProtectedOutputs(
  page: Page,
  transaction: ProtectedTransaction,
  dependencies: ProtectedTransactionDependencies,
  facts: ProtectedTransactionFacts,
  claim: import("./protected-transaction-coordinator.js").ProtectedOperationClaim,
) {
  const acquired = await acquireProtectedOutputs(page, transaction, dependencies, facts);
  return persistAcquiredProtectedOutputs(transaction, dependencies, facts, acquired, claim);
}

export type AcquiredProtectedOutputSet = Array<{
  output: ProtectedTransaction["extraction"]["outputs"][number];
  value: string;
  adapter: import("@scry/contracts").ProtectedAcquisitionEvidence["adapter"];
}>;

export async function acquireProtectedOutputs(
  page: Page,
  transaction: ProtectedTransaction,
  dependencies: ProtectedTransactionDependencies,
  facts: ProtectedTransactionFacts,
): Promise<AcquiredProtectedOutputSet> {
  const deadline = Date.now() + transaction.extraction.timeoutMs;
  const protectedInputTargets = (transaction.preparation?.actions ?? []).flatMap((action) =>
    action.type === "fillKnownSecret" ? [action.target] : [],
  );
  const extracted = await runProtectedStage({
    stage: "protected_output_acquisition",
    timeoutMs: transaction.extraction.timeoutMs,
    signal: dependencies.signal,
    timeoutCode: "PROTECTED_OUTPUT_ACQUISITION_TIMEOUT",
    dispatchPosition:
      transaction.mutation.dispatchSemantics === "read_only" ? "read_only" : "post_dispatch",
    work: (stageSignal) =>
      Promise.all(
        transaction.extraction.outputs.map(async (output) => {
          const remainingMs = Math.max(1, deadline - Date.now());
          // The dependency must terminate before its owning stage. Giving both
          // timers the identical deadline makes their ordering scheduler-
          // dependent and can replace a precise fail-closed classification
          // with the supervisor's generic timeout.
          const dependencyTimeoutMs = Math.max(
            1,
            remainingMs - Math.min(250, Math.max(25, Math.floor(remainingMs / 10))),
          );
          const extraction = await acquireValue(
            page,
            {
              ...output.acquisition,
              prohibitedSourceTargets: [
                ...(output.acquisition.prohibitedSourceTargets ?? []),
                ...protectedInputTargets,
              ],
            },
            dependencyTimeoutMs,
          );
          // Cooperative browser cancellation is not guaranteed. If a locator
          // completes after its owner expired, erase the late value before the
          // abandoned promise can retain it.
          if (stageSignal.aborted && extraction.result?.kind === "captured_value") {
            extraction.result.value = "";
            extraction.value = undefined;
          }
          return { output, extraction };
        }),
      ),
  });
  const acquired: AcquiredProtectedOutputSet = [];
  for (const { output, extraction } of extracted) {
    facts.diagnostics.push(...extraction.diagnostics);
    if (extraction.result?.kind === "copy_experience_verified") {
      facts.protectedAcquisitionEvidence.push({
        reference: output.reference,
        adapter: extraction.result.adapter,
        objective: "verify_user_copy_experience",
        outcome: "copy_experience_verified",
        capsule: "destroyed",
        evidenceClosure: "sealed",
      });
      continue;
    }
    if (!extraction.result || extraction.result.kind !== "captured_value") {
      if (output.classification === "protected") facts.protectedExtraction = "not_found";
      else facts.publicExtraction = "not_found";
      const networkFailure = extraction.diagnostics.find(
        (diagnostic) => diagnostic.method === "protected_network_value",
      )?.lastFailureCode;
      facts.reasonCode = networkFailure?.startsWith("PROTECTED_RESPONSE_")
        ? networkFailure
        : output.classification === "protected"
          ? "PROTECTED_VALUE_UNAVAILABLE"
          : "PUBLIC_VALUE_UNAVAILABLE";
      facts.failurePhase = "extraction";
      facts.retryClass = "manual_review";
      throw new PhaseError(facts.reasonCode, "acquisition", "manual_review");
    }
    if (output.classification === "protected") dependencies.redactor.add(extraction.result.value);
    acquired.push({ output, value: extraction.result.value, adapter: extraction.result.adapter });
  }
  facts.protectedExtraction = acquired.some(({ output }) => output.classification === "protected")
    ? "captured"
    : "not_attempted";
  facts.publicExtraction = acquired.some(({ output }) => output.classification === "public")
    ? "captured"
    : "not_attempted";
  return acquired;
}

export async function persistAcquiredProtectedOutputs(
  transaction: ProtectedTransaction,
  dependencies: ProtectedTransactionDependencies,
  facts: ProtectedTransactionFacts,
  acquired: AcquiredProtectedOutputSet,
  claim: import("./protected-transaction-coordinator.js").ProtectedOperationClaim,
) {
  if (acquired.length) {
    if (!dependencies.persistOutputsAtomically)
      throw new PhaseError(
        "ATOMIC_OUTPUT_PERSISTENCE_AUTHORITY_REQUIRED",
        "persistence",
        "do_not_retry",
      );
    try {
      const persisted = await runProtectedStage({
        stage: "atomic_persistence",
        timeoutMs: transaction.extraction.timeoutMs,
        signal: dependencies.signal,
        timeoutCode: "ATOMIC_OUTPUT_PERSISTENCE_TIMEOUT",
        dispatchPosition:
          transaction.mutation.dispatchSemantics === "read_only" ? "read_only" : "post_dispatch",
        work: () =>
          dependencies.persistOutputsAtomically!({
            operationId: transaction.operationId,
            claim,
            outputs: acquired.map(({ output, value }) => ({
              reference: output.reference,
              classification: output.classification,
              name:
                output.classification === "protected"
                  ? output.storage.credentialName
                  : output.storage.name,
              value,
              scope: output.storage.scope,
            })),
            externalResourceBindings: transaction.extraction.externalResourceBindings ?? [],
          }),
      });
      const references = persisted.references;
      for (const { output, adapter } of acquired) {
        const stored = references[output.reference];
        if (!stored || stored.classification !== output.classification)
          throw new Error("ATOMIC_OUTPUT_REFERENCE_MISSING");
        if (output.classification === "protected" && stored.credentialId) {
          facts.credentialReferences[output.reference] = stored.credentialId;
          facts.protectedAcquisitionEvidence.push({
            reference: output.reference,
            adapter,
            objective: "capture_value",
            outcome: "value_persisted",
            capsule: "destroyed",
            evidenceClosure: "sealed",
          });
        } else if (output.classification === "public" && stored.valueId) {
          facts.publicValueReferences[output.reference] = stored.valueId;
        } else throw new Error("ATOMIC_OUTPUT_REFERENCE_INVALID");
      }
      if (acquired.some(({ output }) => output.classification === "protected")) {
        facts.protectedPersistence = "confirmed";
        facts.credentialSecurity = "active";
      }
      if (acquired.some(({ output }) => output.classification === "public"))
        facts.publicPersistence = "confirmed";
      return persisted.claim;
    } catch {
      facts.protectedPersistence = acquired.some(
        ({ output }) => output.classification === "protected",
      )
        ? "uncertain"
        : "not_attempted";
      facts.publicPersistence = acquired.some(({ output }) => output.classification === "public")
        ? "uncertain"
        : "not_attempted";
      facts.credentialSecurity = acquired.some(
        ({ output }) => output.classification === "protected",
      )
        ? "compromised"
        : facts.credentialSecurity;
      throw new PhaseError("ATOMIC_OUTPUT_PERSISTENCE_FAILED", "persistence", "manual_review");
    } finally {
      for (const item of acquired) item.value = "";
    }
  }
  return claim;
}

export function protectedOutputsPersisted(
  transaction: ProtectedTransaction,
  facts: ProtectedTransactionFacts,
) {
  return transaction.extraction.outputs.every((output) => {
    if (output.acquisition.objective?.kind === "verify_user_copy_experience") {
      return facts.protectedAcquisitionEvidence.some(
        (evidence) =>
          evidence.reference === output.reference &&
          evidence.outcome === "copy_experience_verified",
      );
    }
    return output.classification === "protected"
      ? output.reference in facts.credentialReferences
      : output.reference in facts.publicValueReferences;
  });
}

export async function recoverProtectedAcquisition(
  page: Page,
  transaction: ProtectedTransaction,
  dependencies: ProtectedTransactionDependencies,
  facts: ProtectedTransactionFacts,
  claim: import("./protected-transaction-coordinator.js").ProtectedOperationClaim,
) {
  const expiresAt = Date.now() + transaction.acquisitionReadiness.recoveryWindowMs;
  await dependencies.store.record({
    operationId: transaction.operationId,
    fencingToken: claim.fencingToken,
    phase: "acquisition_unresolved",
    facts: { reasonCode: "ACQUISITION_UNRESOLVED" },
  });
  await dependencies.store.record({
    operationId: transaction.operationId,
    fencingToken: claim.fencingToken,
    phase: "recovery_window",
    facts: { recoveryExpiresAt: new Date(expiresAt).toISOString() },
  });
  while (Date.now() < expiresAt && !protectedOutputsPersisted(transaction, facts)) {
    const decision = (await dependencies.recoverAcquisition?.({
      operationId: transaction.operationId,
      expiresAt: new Date(expiresAt).toISOString(),
      permittedActions: ["retry", transaction.acquisitionReadiness.recoveryPolicy],
    })) ?? { action: "retry" as const };
    if (decision.action === "abandon" || decision.action === "revoke") {
      facts.credentialSecurity = decision.action === "revoke" ? "revoked" : "unusable";
      facts.reasonCode =
        decision.action === "revoke" ? "CREDENTIAL_REVOKED" : "CREDENTIAL_ABANDONED";
      await dependencies.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: decision.action === "revoke" ? "credential_revoked" : "credential_abandoned",
        facts: { credentialSecurity: facts.credentialSecurity, reasonCode: facts.reasonCode },
      });
      return;
    }
    if (decision.action === "expired") break;
    const recoveryTransaction = decision.correctedScope
      ? {
          ...transaction,
          extraction: {
            ...transaction.extraction,
            outputs: transaction.extraction.outputs.map((output) => ({
              ...output,
              acquisition: {
                ...output.acquisition,
                target: { ...output.acquisition.target, scope: decision.correctedScope! },
              },
            })),
          },
        }
      : transaction;
    if (decision.action === "request_secure_assistance") {
      await dependencies.store.record({
        operationId: transaction.operationId,
        fencingToken: claim.fencingToken,
        phase: "secure_assistance",
        facts: {},
      });
    }
    claim = await extractAndPersistProtectedOutputs(
      page,
      recoveryTransaction,
      dependencies,
      facts,
      claim,
    );
    if (!protectedOutputsPersisted(transaction, facts)) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, expiresAt - Date.now())));
    }
  }
  if (!protectedOutputsPersisted(transaction, facts)) {
    facts.reasonCode = "RECOVERY_WINDOW_EXPIRED";
    facts.retryClass = "do_not_retry";
    await dependencies.store.record({
      operationId: transaction.operationId,
      fencingToken: claim.fencingToken,
      phase: "recovery_expired",
      facts: { reasonCode: facts.reasonCode },
    });
  }
}
