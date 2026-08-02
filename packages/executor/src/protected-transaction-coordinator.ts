import { randomUUID } from "node:crypto";
import { chromium, type BrowserContextOptions, type Page } from "playwright";
import type { Assertion, ProtectedTransaction, ProtectedTransactionResult } from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";
import { BrowserSessionProvenance, type ProtectedBrowserSession, type SafeBrowserSession } from "./browser-session.js";
import { playwrightBrowserChannel } from "./browser-runtime-artifacts.js";
import { extractProtectedValue, executeProtectedReveal } from "./protected-extractor.js";
import { resolveTarget, resolveTargetLocator } from "./grounding.js";
import { CalibrationRequiredError, protectedTransactionDigest, transactionInputDigest, transactionInputSchemaDigest } from "./calibration.js";
import type { PrivacyGate } from "./privacy-gate.js";

export type MutationLedgerState = "planned" | "dispatch_authorized" | "dispatching" | "dispatched" | "acknowledged" | "reconciled_succeeded" | "reconciled_not_applied" | "outcome_unknown";
export type ProtectedTransactionStore = {
  claim(input: { operationId: string; mutationKind: "one_time" | "repeatable"; programDigest: string; inputSchemaDigest: string; inputDigest: string }): Promise<{ state: MutationLedgerState; fencingToken: number }>;
  transition(input: { operationId: string; fencingToken: number; expected: MutationLedgerState; next: MutationLedgerState }): Promise<boolean>;
  record(input: { operationId: string; fencingToken: number; phase: string; facts?: Record<string, unknown> }): Promise<void>;
};

export type CapsuleFactory = {
  create(input: { storageState: Awaited<ReturnType<SafeBrowserSession["context"]["storageState"]>>; viewport?: { width: number; height: number }; browserChannel?: string; prepare: (session: ProtectedBrowserSession) => Promise<void> }): Promise<ProtectedBrowserSession>;
};

export type ProtectedTransactionDependencies = {
  safeSession: SafeBrowserSession;
  gate: PrivacyGate;
  redactor: SecretRedactor;
  store: ProtectedTransactionStore;
  capsuleFactory: CapsuleFactory;
  allowedOrigins: string[];
  persistSecret(input: { operationId: string; reference: string; name: string; value: string; scope: "run" | "project" }): Promise<{ credentialId: string }>;
  persistPublicValue(input: { operationId: string; reference: string; name: string; value: string; scope: "run" | "project" }): Promise<{ valueId: string }>;
  resolveKnownSecret(reference: string): Promise<string>;
  verifyAssertions(page: Page, assertions: Assertion[]): Promise<void>;
  prepareCapsule(session: ProtectedBrowserSession): Promise<void>;
  verifyCalibration?(session: ProtectedBrowserSession, transaction: ProtectedTransaction): Promise<void>;
  onPreparationVerified?(session: ProtectedBrowserSession, transaction: ProtectedTransaction): Promise<void>;
  reconcile?(session: SafeBrowserSession, transaction: ProtectedTransaction): Promise<"succeeded" | "not_applied" | "unknown">;
  recreateCleanSession?(checkpointId: string): Promise<SafeBrowserSession>;
  reauthenticate?(authenticationContractId: string): Promise<SafeBrowserSession>;
  onContextProvenance?(input: { contextId: string; provenance: string; operationId: string }): Promise<void>;
  onEvidenceResumed?(input: { contextId: string; operationId: string; continuedAtStepId: string }): Promise<void>;
  emit?(type: string, payload: Record<string, unknown>): Promise<void>;
  recoverAcquisition?(input: { operationId: string; expiresAt: string; permittedActions: string[] }): Promise<{ action: "retry" | "request_secure_assistance" | "revoke" | "abandon" | "expired"; correctedScope?: import("@scry/contracts").SemanticScope }>;
  signal?: AbortSignal;
};

export type ProtectedTransactionExecution = { result: ProtectedTransactionResult; safeSession: SafeBrowserSession; terminal: boolean };

export class ProtectedTransactionKernel {
  constructor(private readonly dependencies: ProtectedTransactionDependencies) {}

  async execute(transaction: ProtectedTransaction): Promise<ProtectedTransactionExecution> {
    const d = this.dependencies;
    const identity = digests(transaction, d.allowedOrigins);
    const claim = await d.store.claim({ operationId: transaction.operationId, mutationKind: transaction.mutation.kind, ...identity });
    if (claim.state !== "planned") return this.outcomeUnknown(transaction, claim.fencingToken);
    const facts = initialFacts();
    let capsule: ProtectedBrowserSession | undefined;
    let safeSession = d.safeSession;
    try {
      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "safe_context_parking", facts: identity });
      await d.gate.prepare(transaction.operationId, { mode: "protected_recording_gap", videoMaskEstablished: false });
      safeSession.provenance.transition("safe_parked");
      await d.onContextProvenance?.({ contextId: safeSession.provenance.contextId, provenance: "safe_parked", operationId: transaction.operationId });
      await d.gate.beginProtected();
      facts.evidence = "stopped";

      facts.bootstrap = { status: "running" };
      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "capsule_bootstrapping" });
      capsule = await abortable(d.capsuleFactory.create({ storageState: await safeSession.context.storageState({ indexedDB: true }), prepare: d.prepareCapsule }), d.signal);
      facts.capsule = "active";
      await d.onContextProvenance?.({ contextId: capsule.provenance.contextId, provenance: "protected", operationId: transaction.operationId });
      await capsule.page.goto(transaction.entry.url, { waitUntil: "domcontentloaded" });
      await d.verifyAssertions(capsule.page, transaction.entry.assertions);
      facts.bootstrap = { status: "succeeded" };
      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "capsule_ready", facts: { capsuleContextId: capsule.provenance.contextId, bootstrap: "succeeded" } });

      facts.preparation = { status: "running" };
      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "preparation_running" });
      const observedEffects: Array<{ method: string; origin: string; path: string; disposition: "ignored" | "blocked"; category?: "telemetry" | "platform" }> = [];
      const observePreparationEffect = (request: { method(): string; url(): string }) => {
        const method = request.method().toUpperCase();
        if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
        try {
          const url = new URL(request.url());
          const ignored = transaction.preparation.effectPolicy.ignoredRequests.find((rule) => rule.origin === url.origin && rule.methods.includes(method as "POST" | "PUT" | "PATCH" | "DELETE") && url.pathname.startsWith(rule.pathPrefix));
          observedEffects.push({ method, origin: url.origin, path: url.pathname, disposition: ignored ? "ignored" : "blocked", ...(ignored ? { category: ignored.category } : {}) });
        } catch { observedEffects.push({ method, origin: "opaque", path: "opaque", disposition: "blocked" }); }
      };
      capsule.page.on("request", observePreparationEffect);
      try {
        await executePreparation(capsule.page, transaction, d);
        await verifyTransactionAssertions(capsule.page, transaction.preparation.assertions, transaction, d);
        if (observedEffects.some((effect) => effect.disposition === "blocked")) throw new PhaseError("UNDECLARED_PREPARATION_SIDE_EFFECT", "preparation", "do_not_retry");
        // Calibration records the transaction boundary after deterministic preparation.
        // Production must verify at that identical boundary, never at capsule entry.
        await d.verifyCalibration?.(capsule, transaction);
      } catch (error) {
        const failure = error instanceof PhaseError
          ? error
          : error instanceof CalibrationRequiredError
              ? new PhaseError("CALIBRATION_REQUIRED", "preparation", "do_not_retry")
              : new PhaseError("REQUIRED_STATE_NOT_ESTABLISHED", "preparation", "safe_to_retry");
        facts.preparation = { status: "failed", code: failure.code };
        throw failure;
      } finally {
        facts.preparationEffects = observedEffects.map((effect) => ({
          method: ["POST", "PUT", "PATCH", "DELETE"].includes(effect.method) ? effect.method as "POST" | "PUT" | "PATCH" | "DELETE" : "OTHER",
          origin: effect.origin,
          path: effect.path,
          disposition: effect.disposition,
          ...(effect.category ? { category: effect.category } : {}),
        }));
        capsule.page.off("request", observePreparationEffect);
      }
      facts.preparation = { status: "succeeded" };
      await d.onPreparationVerified?.(capsule, transaction);
      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "preparation_verified", facts: { preparation: "succeeded" } });

      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "acquisition_readiness_validating" });
      await verifyAcquisitionReadiness(capsule.page, transaction);
      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "acquisition_ready", facts: { acquisitionContractDigest: protectedTransactionDigest(transaction, d.allowedOrigins) } });

      if (!(await d.store.transition({ operationId: transaction.operationId, fencingToken: claim.fencingToken, expected: "planned", next: "dispatch_authorized" }))) throw new PhaseError("MUTATION_LEDGER_CONFLICT", "mutation_dispatch", "manual_review");
      facts.mutation.dispatch = "authorized";
      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "dispatch_authorized" });
      if (!(await d.store.transition({ operationId: transaction.operationId, fencingToken: claim.fencingToken, expected: "dispatch_authorized", next: "dispatching" }))) throw new PhaseError("MUTATION_LEDGER_CONFLICT", "mutation_dispatch", "manual_review");
      facts.mutation.dispatch = "started";
      capsule.provenance.transition("tainted");
      await d.onContextProvenance?.({ contextId: capsule.provenance.contextId, provenance: "tainted", operationId: transaction.operationId });
      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "mutation_dispatching" });
      await abortable(executeProtectedReveal(capsule.page, transaction), d.signal);
      if (!(await d.store.transition({ operationId: transaction.operationId, fencingToken: claim.fencingToken, expected: "dispatching", next: "dispatched" }))) throw new PhaseError("MUTATION_LEDGER_CONFLICT", "mutation_dispatch", "manual_review");
      await d.store.transition({ operationId: transaction.operationId, fencingToken: claim.fencingToken, expected: "dispatched", next: "acknowledged" });
      facts.mutation.dispatch = "acknowledged";
      facts.mutation.outcome = "unknown";

      await d.store.record({ operationId: transaction.operationId, fencingToken: claim.fencingToken, phase: "acquisition_running" });
      await extractAndPersist(capsule.page, transaction, d, facts);
      if (!outputsPersisted(transaction, facts)) await recoverAcquisition(capsule.page, transaction, d, facts, claim.fencingToken);
      if (outputsPersisted(transaction, facts)) facts.mutation.outcome = "confirmed_succeeded";
    } catch (error) {
      const failure = error instanceof PhaseError
        ? error
        : error instanceof CalibrationRequiredError
            ? new PhaseError("CALIBRATION_REQUIRED", facts.preparation.status === "running" ? "preparation" : "bootstrap", "do_not_retry")
            : new PhaseError("PROTECTED_TRANSACTION_FAILED", facts.mutation.dispatch === "started" ? "mutation_dispatch" : facts.preparation.status === "running" ? "preparation" : "bootstrap", facts.mutation.dispatch === "started" ? "retry_requires_reconciliation" : "safe_to_retry");
      facts.reasonCode = failure.code;
      facts.failurePhase = failure.phase;
      facts.retryClass = failure.retryClass;
      if (facts.bootstrap.status === "running") facts.bootstrap = { status: "failed", code: failure.code };
      if (facts.preparation.status === "running") facts.preparation = { status: "failed", code: failure.code };
      if (facts.mutation.dispatch === "started") {
        facts.mutation.outcome = "unknown";
        await d.store.transition({ operationId: transaction.operationId, fencingToken: claim.fencingToken, expected: "dispatching", next: "outcome_unknown" }).catch(() => false);
      }
    } finally {
      if (capsule) {
        try {
          facts.capsule = await capsule.destroy();
          await d.onContextProvenance?.({ contextId: capsule.provenance.contextId, provenance: "destroyed", operationId: transaction.operationId });
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
      return { safeSession, terminal: true, result: result(facts, "aborted", facts.retryClass === "safe_to_retry" ? ["retry_transaction", "abort"] : ["abort"]) };
    }

    const persistenceComplete = transaction.extraction.outputs.every((output) => output.classification === "protected" ? facts.protectedPersistence === "confirmed" : facts.publicPersistence === "confirmed");
    if (facts.capsule === "destruction_failed" || !persistenceComplete) {
      facts.reconciliation = await this.reconcile(safeSession, transaction, claim.fencingToken, facts);
      await d.gate.seal({ code: facts.reasonCode ?? "PROTECTED_TRANSACTION_FAILED" });
      const status = facts.mutation.outcome === "unknown" ? "outcome_unknown" : "aborted";
      await this.persistFinal(transaction, claim.fencingToken, status, facts);
      return { safeSession, terminal: true, result: result(facts, status, facts.mutation.outcome === "unknown" ? ["manual_reconciliation", "abort"] : ["abort"]) };
    }

    await d.gate.markCaptured();
    facts.reconciliation = await this.reconcile(safeSession, transaction, claim.fencingToken, facts);
    if (facts.reconciliation === "not_applied" || facts.reconciliation === "failed") {
      await d.gate.seal({ code: "MUTATION_RECONCILIATION_FAILED" });
      await this.persistFinal(transaction, claim.fencingToken, "aborted", facts);
      return { safeSession, terminal: true, result: result(facts, "aborted", ["manual_reconciliation", "abort"]) };
    }

    const continuation = await this.continue(transaction, safeSession);
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
      return { safeSession, terminal: false, result: result(facts, "continuing_unrecorded", ["abort"]) };
    }
    if (continuation.status === "failed" || !continuation.continuedAtStepId) {
      await d.gate.seal({ code: "CONTINUATION_FAILED" });
      await this.persistFinal(transaction, claim.fencingToken, "aborted", facts);
      return { safeSession, terminal: true, result: result(facts, "aborted", ["retry_continuation", "abort"]) };
    }
    await d.gate.beginSafeBoundary();
    await d.gate.confirmSafeBoundary({ kind: "protected_context_destroyed", contextId: capsule?.provenance.contextId ?? randomUUID() });
    facts.evidence = "resumed";
    await d.onContextProvenance?.({ contextId: safeSession.provenance.contextId, provenance: safeSession.provenance.value(), operationId: transaction.operationId });
    await d.onEvidenceResumed?.({ contextId: safeSession.provenance.contextId, operationId: transaction.operationId, continuedAtStepId: continuation.continuedAtStepId });
    await this.persistFinal(transaction, claim.fencingToken, "completed", facts);
    return { safeSession, terminal: false, result: result(facts, "completed", [], continuation.continuedAtStepId) };
  }

  private async reconcile(session: SafeBrowserSession, transaction: ProtectedTransaction, fencingToken: number, facts: Facts): Promise<ProtectedTransactionResult["reconciliation"]> {
    if (transaction.mutation.reconciliation.strategy === "none") return "not_configured";
    if (transaction.mutation.reconciliation.strategy === "persisted_outputs") {
      const persisted = transaction.mutation.reconciliation.requiredReferences.every((reference) =>
        reference in facts.credentialReferences || reference in facts.publicValueReferences,
      );
      if (persisted) {
        await this.dependencies.store.transition({ operationId: transaction.operationId, fencingToken, expected: "acknowledged", next: "reconciled_succeeded" });
        return "succeeded";
      }
      return "unknown";
    }
    try {
      if (transaction.mutation.reconciliation.strategy === "public_ui_state") {
        await session.page.reload({ waitUntil: "domcontentloaded" });
        await verifyTransactionAssertions(session.page, transaction.mutation.reconciliation.assertions, transaction, this.dependencies, "mutation_reconciliation");
        await this.dependencies.store.transition({ operationId: transaction.operationId, fencingToken, expected: "acknowledged", next: "reconciled_succeeded" });
        return "succeeded";
      }
      const outcome = await this.dependencies.reconcile?.(session, transaction) ?? "unknown";
      if (outcome === "succeeded") await this.dependencies.store.transition({ operationId: transaction.operationId, fencingToken, expected: "acknowledged", next: "reconciled_succeeded" });
      if (outcome === "not_applied") await this.dependencies.store.transition({ operationId: transaction.operationId, fencingToken, expected: "acknowledged", next: "reconciled_not_applied" });
      return outcome;
    } catch { return "failed"; }
  }

  private async continue(transaction: ProtectedTransaction, initial: SafeBrowserSession) {
    let session = initial;
    for (const strategy of transaction.continuation.strategies) {
      try {
        if (strategy.mode === "resume_parked_context") { await session.page.goto(strategy.reentryUrl, { waitUntil: "domcontentloaded" }); await verifyTransactionAssertions(session.page, strategy.assertions, transaction, this.dependencies, "continuation"); session.provenance.transition("safe"); return { safeSession: session, status: "parked_resumed" as const, continuedAtStepId: strategy.continueAtStepId }; }
        if (strategy.mode === "recreate_clean_context" && this.dependencies.recreateCleanSession) { session = await this.dependencies.recreateCleanSession(strategy.checkpointId); await session.page.goto(strategy.reentryUrl, { waitUntil: "domcontentloaded" }); await verifyTransactionAssertions(session.page, strategy.assertions, transaction, this.dependencies, "continuation"); if (session.provenance.value() === "restored_pending_verification") session.provenance.transition("restored_safe"); return { safeSession: session, status: "clean_recreated" as const, continuedAtStepId: strategy.continueAtStepId }; }
        if (strategy.mode === "reauthenticate" && this.dependencies.reauthenticate) { session = await this.dependencies.reauthenticate(strategy.authenticationContractId); await session.page.goto(strategy.reentryUrl, { waitUntil: "domcontentloaded" }); await verifyTransactionAssertions(session.page, strategy.assertions, transaction, this.dependencies, "continuation"); return { safeSession: session, status: "reauthenticated" as const, continuedAtStepId: strategy.continueAtStepId }; }
        if (strategy.mode === "continue_unrecorded") return { safeSession: session, status: "continuing_unrecorded" as const };
        if (strategy.mode === "terminal") return { safeSession: session, status: "terminal" as const };
      } catch { /* Try only the next declared strategy. */ }
    }
    return { safeSession: session, status: "failed" as const };
  }

  private async outcomeUnknown(transaction: ProtectedTransaction, fencingToken: number): Promise<ProtectedTransactionExecution> {
    await this.dependencies.gate.seal({ code: "MUTATION_OUTCOME_UNKNOWN" });
    const facts = initialFacts(); facts.mutation.outcome = "unknown"; facts.reasonCode = "MUTATION_OUTCOME_UNKNOWN"; facts.retryClass = "retry_requires_reconciliation";
    await this.persistFinal(transaction, fencingToken, "outcome_unknown", facts);
    return { safeSession: this.dependencies.safeSession, terminal: true, result: result(facts, "outcome_unknown", ["manual_reconciliation", "abort"]) };
  }

  private async persistFinal(transaction: ProtectedTransaction, fencingToken: number, phase: string, facts: Facts) {
    await this.dependencies.store.record({ operationId: transaction.operationId, fencingToken, phase, facts: { ...facts, diagnostics: undefined } });
  }
}

/** Kept as a domain alias while callers are cut over to the kernel name. */
export class ProtectedTransactionCoordinator extends ProtectedTransactionKernel {}

async function executePreparation(page: Page, transaction: ProtectedTransaction, dependencies: ProtectedTransactionDependencies) {
  for (const action of transaction.preparation.actions) {
    try {
    if (action.type === "navigate") { await page.goto(action.url, { waitUntil: "domcontentloaded", ...timeout(action.timeoutMs) }); continue; }
    if (action.type === "clickNavigation") { await (await resolveTargetLocator(page, action.target)).click(timeout(action.timeoutMs)); continue; }
    if (action.type === "clickPublicInput") {
      const input = transaction.inputs[action.input];
      if (!input || input.classification !== "public" || typeof input.value !== "string") throw new PhaseError("PUBLIC_NAVIGATION_INPUT_INVALID", "preparation", "safe_to_retry");
      await page.getByText(input.value, { exact: action.exact }).click(timeout(action.timeoutMs));
      continue;
    }
    if (action.type === "waitFor") { await (await resolveTargetLocator(page, action.target)).waitFor({ state: action.state, ...timeout(action.timeoutMs) }); continue; }
    if (action.type === "assertion") { await dependencies.verifyAssertions(page, [action.assertion]); continue; }
    const input = transaction.inputs[action.input];
    if (!input) throw new PhaseError("TRANSACTION_INPUT_MISSING", "preparation", "safe_to_retry");
    const locator = await resolveTargetLocator(page, action.target);
    if (action.type === "fillKnownSecret") {
      if (input.classification !== "known_secret") throw new PhaseError("TRANSACTION_INPUT_CLASSIFICATION_MISMATCH", "preparation", "do_not_retry");
      const secret = await dependencies.resolveKnownSecret(input.credentialRef);
      dependencies.redactor.add(secret);
      await locator.fill(secret, timeout(action.timeoutMs));
    } else {
      if (input.classification !== "public") throw new PhaseError("TRANSACTION_INPUT_CLASSIFICATION_MISMATCH", "preparation", "do_not_retry");
      if (action.type === "fillPublicInput") await locator.fill(String(input.value), timeout(action.timeoutMs));
      if (action.type === "selectPublicInput") await locator.selectOption(String(input.value), timeout(action.timeoutMs));
      if (action.type === "checkPublicInput") {
        if (typeof input.value !== "boolean") throw new PhaseError("TRANSACTION_INPUT_TYPE_MISMATCH", "preparation", "do_not_retry");
        if (input.value) await locator.check(timeout(action.timeoutMs)); else await locator.uncheck(timeout(action.timeoutMs));
      }
    }
    } catch (error) {
      if (error instanceof PhaseError) throw error;
      throw new PhaseError(`PREPARATION_${action.type.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_FAILED`, "preparation", "safe_to_retry");
    }
  }
}

async function verifyTransactionAssertions(
  page: Page,
  assertions: ProtectedTransaction["preparation"]["assertions"],
  transaction: ProtectedTransaction,
  dependencies: ProtectedTransactionDependencies,
  phase: PhaseError["phase"] = "preparation",
) {
  for (const assertion of assertions) {
    if (assertion.type !== "fieldValueMatchesInput" && assertion.type !== "textMatchesInput") {
      try { await dependencies.verifyAssertions(page, [assertion]); }
      catch { throw new PhaseError(`TRANSACTION_${assertion.type.toUpperCase()}_ASSERTION_FAILED`, phase, phase === "continuation" ? "manual_review" : "safe_to_retry"); }
      continue;
    }
    const code = `${phase.toUpperCase()}_${assertion.input.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_VERIFICATION_FAILED`;
    try {
      const input = transaction.inputs[assertion.input];
      if (!input) throw new PhaseError("TRANSACTION_INPUT_MISSING", phase, phase === "continuation" ? "manual_review" : "safe_to_retry");
      const locator = await resolveTargetLocator(page, assertion.target);
      const expected = input.classification === "known_secret" ? await dependencies.resolveKnownSecret(input.credentialRef) : String(input.value);
      if (input.classification === "known_secret") dependencies.redactor.add(expected);
      const deadline = Date.now() + (assertion.timeoutMs ?? 10_000);
      let matches = false;
      do {
        const actual = assertion.type === "fieldValueMatchesInput"
          ? await locator.inputValue({ timeout: Math.max(100, deadline - Date.now()) })
          : (await locator.textContent({ timeout: Math.max(100, deadline - Date.now()) })) ?? "";
        matches = assertion.type === "textMatchesInput" && !assertion.exact ? actual.includes(expected) : actual.trim() === expected;
        if (!matches && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      } while (!matches && Date.now() < deadline);
      if (!matches) throw new PhaseError(code, phase, phase === "continuation" ? "manual_review" : "safe_to_retry");
    } catch (error) {
      if (error instanceof PhaseError) throw error;
      throw new PhaseError(code, phase, phase === "continuation" ? "manual_review" : "safe_to_retry");
    }
  }
}

async function extractAndPersist(page: Page, transaction: ProtectedTransaction, dependencies: ProtectedTransactionDependencies, facts: Facts) {
  const deadline = Date.now() + transaction.extraction.timeoutMs;
  const extracted = await Promise.all(transaction.extraction.outputs.map(async (output) => ({
    output,
    extraction: await extractProtectedValue(page, output.acquisition, Math.max(100, deadline - Date.now())),
  })));
  for (const { output, extraction } of extracted) {
    facts.diagnostics.push(...extraction.diagnostics);
    if (!extraction.value) {
      if (output.classification === "protected") facts.protectedExtraction = "not_found"; else facts.publicExtraction = "not_found";
      facts.reasonCode = output.classification === "protected" ? "PROTECTED_VALUE_UNAVAILABLE" : "PUBLIC_VALUE_UNAVAILABLE";
      facts.failurePhase = "extraction";
      facts.retryClass = "manual_review";
      continue;
    }
    if (output.classification === "protected") {
      dependencies.redactor.add(extraction.value);
      facts.protectedExtraction = "captured";
      try { const stored = await dependencies.persistSecret({ operationId: transaction.operationId, reference: output.reference, name: output.storage.credentialName, value: extraction.value, scope: output.storage.scope }); facts.credentialReferences[output.reference] = stored.credentialId; facts.protectedPersistence = "confirmed"; facts.credentialSecurity = "active"; }
      catch { facts.protectedPersistence = "uncertain"; facts.credentialSecurity = "compromised"; facts.reasonCode = "SECRET_PERSISTENCE_UNCERTAIN"; }
    } else {
      facts.publicExtraction = "captured";
      try { const stored = await dependencies.persistPublicValue({ operationId: transaction.operationId, reference: output.reference, name: output.storage.name, value: extraction.value, scope: output.storage.scope }); facts.publicValueReferences[output.reference] = stored.valueId; facts.publicPersistence = "confirmed"; }
      catch { facts.publicPersistence = "uncertain"; facts.reasonCode = "PUBLIC_VALUE_PERSISTENCE_UNCERTAIN"; }
    }
  }
}

function outputsPersisted(transaction: ProtectedTransaction, facts: Facts) {
  return transaction.extraction.outputs.every((output) => output.classification === "protected"
    ? output.reference in facts.credentialReferences
    : output.reference in facts.publicValueReferences);
}

async function verifyAcquisitionReadiness(page: Page, transaction: ProtectedTransaction) {
  const contract = transaction.acquisitionReadiness;
  for (const output of transaction.extraction.outputs) {
    for (const method of output.acquisition.permittedMethods) if (!contract.approvedMethods.includes(method)) throw new PhaseError("ACQUISITION_NOT_READY", "preparation", "do_not_retry");
  }
  try {
    const ceremony = await resolveTarget(page, contract.ceremonyIntent);
    if (ceremony.diagnostic.confidence < contract.minimumConfidence || ceremony.diagnostic.confidenceMargin < contract.minimumConfidenceMargin) throw new Error("confidence");
  } catch { throw new PhaseError("ACQUISITION_NOT_READY", "preparation", "do_not_retry"); }
}

async function recoverAcquisition(page: Page, transaction: ProtectedTransaction, dependencies: ProtectedTransactionDependencies, facts: Facts, fencingToken: number) {
  const expiresAt = Date.now() + transaction.acquisitionReadiness.recoveryWindowMs;
  await dependencies.store.record({ operationId: transaction.operationId, fencingToken, phase: "acquisition_unresolved", facts: { reasonCode: "ACQUISITION_UNRESOLVED" } });
  await dependencies.store.record({ operationId: transaction.operationId, fencingToken, phase: "recovery_window", facts: { recoveryExpiresAt: new Date(expiresAt).toISOString() } });
  while (Date.now() < expiresAt && !outputsPersisted(transaction, facts)) {
    const decision = await dependencies.recoverAcquisition?.({ operationId: transaction.operationId, expiresAt: new Date(expiresAt).toISOString(), permittedActions: ["retry", transaction.acquisitionReadiness.recoveryPolicy] }) ?? { action: "retry" as const };
    if (decision.action === "abandon" || decision.action === "revoke") { facts.credentialSecurity = decision.action === "revoke" ? "revoked" : "unusable"; facts.reasonCode = decision.action === "revoke" ? "CREDENTIAL_REVOKED" : "CREDENTIAL_ABANDONED"; await dependencies.store.record({ operationId: transaction.operationId, fencingToken, phase: decision.action === "revoke" ? "credential_revoked" : "credential_abandoned", facts: { credentialSecurity: facts.credentialSecurity, reasonCode: facts.reasonCode } }); return; }
    if (decision.action === "expired") break;
    const recoveryTransaction = decision.correctedScope ? {
      ...transaction,
      extraction: { ...transaction.extraction, outputs: transaction.extraction.outputs.map((output) => ({ ...output, acquisition: { ...output.acquisition, target: { ...output.acquisition.target, scope: decision.correctedScope! } } })) },
    } : transaction;
    if (decision.action === "request_secure_assistance") await dependencies.store.record({ operationId: transaction.operationId, fencingToken, phase: "secure_assistance", facts: {} });
    await extractAndPersist(page, recoveryTransaction, dependencies, facts);
    if (!outputsPersisted(transaction, facts)) await new Promise((resolve) => setTimeout(resolve, Math.min(250, expiresAt - Date.now())));
  }
  if (!outputsPersisted(transaction, facts)) { facts.reasonCode = "RECOVERY_WINDOW_EXPIRED"; facts.retryClass = "do_not_retry"; await dependencies.store.record({ operationId: transaction.operationId, fencingToken, phase: "recovery_expired", facts: { reasonCode: facts.reasonCode } }); }
}

export class PlaywrightProtectedCapsuleFactory implements CapsuleFactory {
  async create(input: { storageState: Awaited<ReturnType<SafeBrowserSession["context"]["storageState"]>>; viewport?: { width: number; height: number }; browserChannel?: string; prepare: (session: ProtectedBrowserSession) => Promise<void> }) {
    const configuredChannel=input.browserChannel??process.env.SCRY_BROWSER_CHANNEL??"chrome";
    const launchChannel=playwrightBrowserChannel(configuredChannel);
    const browser = await chromium.launch({ headless: true, ...(launchChannel?{channel:launchChannel}:{}) });
    const options: BrowserContextOptions = { storageState: input.storageState, serviceWorkers: "block", acceptDownloads: false, ...(input.viewport ? { viewport: input.viewport } : {}) };
    const context = await browser.newContext(options); const page = await context.newPage(); const provenance = new BrowserSessionProvenance(randomUUID(), "protected"); let destroyed = false;
    const session: ProtectedBrowserSession = { browser, context, page, provenance, destroy: async () => { if (destroyed) return "destroyed"; destroyed = true; let outcome: "destroyed" | "force_terminated" = "destroyed"; try { await context.close(); await browser.close(); } catch { outcome = "force_terminated"; await browser.close().catch(() => undefined); } if (provenance.value() !== "destroyed") provenance.transition("destroyed"); return outcome; } };
    try { await input.prepare(session); return session; } catch (error) { await session.destroy(); throw error; }
  }
}

type Facts = ReturnType<typeof initialFacts>;
class PhaseError extends Error { constructor(readonly code: string, readonly phase: NonNullable<ProtectedTransactionResult["failurePhase"]>, readonly retryClass: NonNullable<ProtectedTransactionResult["retryClass"]>) { super(code); } }
function initialFacts() {
  return {
    bootstrap: { status: "not_started" as const }, preparation: { status: "not_started" as const },
    mutation: { dispatch: "not_started" as const, outcome: "not_attempted" as const },
    protectedExtraction: "not_attempted" as const, publicExtraction: "not_attempted" as const,
    protectedPersistence: "not_attempted" as const, publicPersistence: "not_attempted" as const,
    capsule: "not_created" as const, reconciliation: "not_configured" as const, continuation: "not_attempted" as const,
    evidence: "stopped" as const, credentialSecurity: "none" as const, credentialReferences: {} as Record<string, string>, publicValueReferences: {} as Record<string, string>,
    preparationEffects: [] as ProtectedTransactionResult["preparationEffects"], diagnostics: [] as ProtectedTransactionResult["diagnostics"], reasonCode: undefined as string | undefined, failurePhase: undefined as string | undefined, retryClass: undefined as string | undefined,
  } as unknown as ProtectedTransactionResult & { failurePhase?: string; retryClass?: string };
}
function result(facts: Facts, status: ProtectedTransactionResult["status"], safeActions: ProtectedTransactionResult["safeActions"], continuedAtStepId?: string): ProtectedTransactionResult { return { ...facts, status, safeActions, ...(continuedAtStepId ? { continuedAtStepId } : {}) }; }
function digests(transaction: ProtectedTransaction, allowedOrigins: string[]) { return { programDigest: protectedTransactionDigest(transaction, allowedOrigins), inputSchemaDigest: transactionInputSchemaDigest(transaction), inputDigest: transactionInputDigest(transaction) }; }
function timeout(timeoutMs?: number) { return timeoutMs === undefined ? {} : { timeout: timeoutMs }; }
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> { if (!signal) return promise; if (signal.aborted) return Promise.reject(signal.reason ?? new Error("RUN_ABORTED")); return new Promise<T>((resolve, reject) => { const abort = () => reject(signal.reason ?? new Error("RUN_ABORTED")); signal.addEventListener("abort", abort, { once: true }); promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)); }); }
