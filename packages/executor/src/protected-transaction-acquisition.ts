import type { ProtectedTransaction } from "@scry/contracts";
import { resolveTarget } from "@scry/praxis";
import type { Page } from "playwright";

import { acquireValue } from "./protected-extractor.js";
import type {
  ProtectedTransactionDependencies,
  ProtectedTransactionFacts,
} from "./protected-transaction-coordinator.js";
import { ProtectedTransactionPhaseError as PhaseError } from "./protected-transaction-errors.js";

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
    if (
      ceremony.diagnostic.confidence < contract.minimumConfidence ||
      ceremony.diagnostic.confidenceMargin < contract.minimumConfidenceMargin
    ) {
      throw new Error("confidence");
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
) {
  const deadline = Date.now() + transaction.extraction.timeoutMs;
  const extracted = await Promise.all(
    transaction.extraction.outputs.map(async (output) => ({
      output,
      extraction: await acquireValue(
        page,
        output.acquisition,
        Math.max(100, deadline - Date.now()),
      ),
    })),
  );
  for (const { output, extraction } of extracted) {
    facts.diagnostics.push(...extraction.diagnostics);
    if (!extraction.value) {
      if (output.classification === "protected") facts.protectedExtraction = "not_found";
      else facts.publicExtraction = "not_found";
      facts.reasonCode =
        output.classification === "protected"
          ? "PROTECTED_VALUE_UNAVAILABLE"
          : "PUBLIC_VALUE_UNAVAILABLE";
      facts.failurePhase = "extraction";
      facts.retryClass = "manual_review";
      continue;
    }
    if (output.classification === "protected") {
      dependencies.redactor.add(extraction.value);
      facts.protectedExtraction = "captured";
      try {
        const stored = await dependencies.persistSecret({
          operationId: transaction.operationId,
          reference: output.reference,
          name: output.storage.credentialName,
          value: extraction.value,
          scope: output.storage.scope,
        });
        facts.credentialReferences[output.reference] = stored.credentialId;
        facts.protectedPersistence = "confirmed";
        facts.credentialSecurity = "active";
      } catch {
        facts.protectedPersistence = "uncertain";
        facts.credentialSecurity = "compromised";
        facts.reasonCode = "SECRET_PERSISTENCE_UNCERTAIN";
      }
    } else {
      facts.publicExtraction = "captured";
      try {
        const stored = await dependencies.persistPublicValue({
          operationId: transaction.operationId,
          reference: output.reference,
          name: output.storage.name,
          value: extraction.value,
          scope: output.storage.scope,
        });
        facts.publicValueReferences[output.reference] = stored.valueId;
        facts.publicPersistence = "confirmed";
      } catch {
        facts.publicPersistence = "uncertain";
        facts.reasonCode = "PUBLIC_VALUE_PERSISTENCE_UNCERTAIN";
      }
    }
  }
}

export function protectedOutputsPersisted(
  transaction: ProtectedTransaction,
  facts: ProtectedTransactionFacts,
) {
  return transaction.extraction.outputs.every((output) =>
    output.classification === "protected"
      ? output.reference in facts.credentialReferences
      : output.reference in facts.publicValueReferences,
  );
}

export async function recoverProtectedAcquisition(
  page: Page,
  transaction: ProtectedTransaction,
  dependencies: ProtectedTransactionDependencies,
  facts: ProtectedTransactionFacts,
  fencingToken: number,
) {
  const expiresAt = Date.now() + transaction.acquisitionReadiness.recoveryWindowMs;
  await dependencies.store.record({
    operationId: transaction.operationId,
    fencingToken,
    phase: "acquisition_unresolved",
    facts: { reasonCode: "ACQUISITION_UNRESOLVED" },
  });
  await dependencies.store.record({
    operationId: transaction.operationId,
    fencingToken,
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
        fencingToken,
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
        fencingToken,
        phase: "secure_assistance",
        facts: {},
      });
    }
    await extractAndPersistProtectedOutputs(page, recoveryTransaction, dependencies, facts);
    if (!protectedOutputsPersisted(transaction, facts)) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, expiresAt - Date.now())));
    }
  }
  if (!protectedOutputsPersisted(transaction, facts)) {
    facts.reasonCode = "RECOVERY_WINDOW_EXPIRED";
    facts.retryClass = "do_not_retry";
    await dependencies.store.record({
      operationId: transaction.operationId,
      fencingToken,
      phase: "recovery_expired",
      facts: { reasonCode: facts.reasonCode },
    });
  }
}
