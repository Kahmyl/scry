import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type {
  Assertion,
  ProtectedOperationClaim,
  ProtectedOperationState,
  ProtectedTransactionStore,
  ProtectedTransaction,
  ProtectedTransactionResult,
} from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";
import {
  capturePraxisSessionStorage,
  capturePraxisStorageState,
  gotoPraxisPage,
} from "@scry/praxis";
import type { ProtectedBrowserSession, SafeBrowserSession } from "@scry/praxis";
import { executeProtectedReveal, verifyProtectedRevealTarget } from "./protected-extractor.js";
import {
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
import {
  beginProtectedResponseEnvelope,
  type ProtectedResponseEvidence,
} from "./protected-response-envelope.js";
import { runProtectedStage } from "@scry/praxis";

/** @deprecated Historical rows only. New operations use ProtectedOperationState. */
export type MutationLedgerState = ProtectedOperationState;
export type { ProtectedOperationClaim, ProtectedTransactionStore } from "@scry/contracts";

export type ProtectedTransactionDependencies = {
  safeSession: SafeBrowserSession;
  gate: VeilRuntimeCoordinator;
  redactor: SecretRedactor;
  store: ProtectedTransactionStore;
  capsuleFactory: CapsuleFactory;
  liveProtectedSession?: ProtectedBrowserSession;
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
    externalResourceBindings: ProtectedTransaction["extraction"]["externalResourceBindings"];
  }): Promise<{
    claim: ProtectedOperationClaim;
    references: Record<
      string,
      {
        classification: "public" | "protected";
        credentialId?: string;
        valueId?: string;
        scope: "run" | "project";
      }
    >;
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
  }): Promise<
    | Array<{
        reference: string;
        classification: "public" | "protected";
        name: string;
        value: string;
        scope: "run" | "project";
      }>
    | undefined
  >;
  resolveKnownSecret(reference: string): Promise<string>;
  verifyAssertions(page: Page, assertions: Assertion[]): Promise<void>;
  prepareCapsule(session: ProtectedBrowserSession): Promise<void>;
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
  dispatchDisposition?: "execute" | "qualification_only";
  onReadyToDispatch?(input: {
    operationId: string;
    disposition: "execute" | "qualification_only";
  }): void | Promise<void>;
  markCredentialCompromised?(
    credentialId: string,
    code: string,
    operationId: string,
  ): Promise<void>;
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
        storageName:
          output.classification === "protected"
            ? output.storage.credentialName
            : output.storage.name,
      })),
      ...identity,
    });
    if (
      [
        "dispatching",
        "dispatched",
        "acquiring",
        "persisting",
        "persisted",
        "reconciling",
        "recovery_required",
        "compromised",
      ].includes(claim.state)
    )
      return this.recoverDurable(transaction, claim);
    if (["completed", "failed_not_applied", "revoked", "abandoned"].includes(claim.state))
      return this.storedTerminal(transaction, claim);
    if (claim.state === "planned") {
      claim = await d.store.transition({
        id: claim.id,
        operationId: transaction.operationId,
        version: claim.version,
        fencingToken: claim.fencingToken,
        expected: "planned",
        next: "preparing",
        phase: "preparation",
      });
    }
    let heartbeatFailure: unknown;
    const leaseController = new AbortController();
    let heartbeatWork = Promise.resolve();
    const heartbeat = () => {
      const ownedClaim = claim;
      heartbeatWork = heartbeatWork
        .then(() =>
          runProtectedStage({
            stage: "protected_repository_heartbeat",
            timeoutMs:
              d.store.heartbeatTimeoutMs ?? Math.max(250, d.store.heartbeatIntervalMs ?? 10_000),
            signal: leaseController.signal,
            timeoutCode: "PROTECTED_OPERATION_HEARTBEAT_TIMEOUT",
            dispatchPosition:
              facts.mutation.dispatch === "not_started" ? "pre_dispatch" : "post_dispatch",
            work: () => d.store.heartbeat?.(ownedClaim) ?? Promise.resolve(),
          }),
        )
        .catch((error) => {
          heartbeatFailure ??= error;
          leaseController.abort(error);
        });
      return heartbeatWork;
    };
    const heartbeatTimer = d.store.heartbeat
      ? setInterval(
          () => {
            void heartbeat();
          },
          Math.max(250, d.store.heartbeatIntervalMs ?? 10_000),
        )
      : undefined;
    const assertOwned = () => {
      if (heartbeatFailure)
        throw new PhaseError(
          "PROTECTED_OPERATION_LEASE_LOST",
          facts.mutation.dispatch === "not_started" ? "preparation" : "mutation_dispatch",
          facts.mutation.dispatch === "not_started"
            ? "safe_to_retry"
            : "retry_requires_reconciliation",
        );
    };
    const facts = initialFacts();
    const lifecycleSignal = composeAbortSignals(d.signal, leaseController.signal);
    const lifecycleDependencies: ProtectedTransactionDependencies = {
      ...d,
      signal: lifecycleSignal,
    };
    let capsule: ProtectedBrowserSession | undefined;
    let responseEnvelope: Awaited<ReturnType<typeof beginProtectedResponseEnvelope>> | undefined;
    let capsulePrivacyFailed = false;
    let safeSession = d.safeSession;
    const stopHeartbeat = async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await runProtectedStage({
        stage: "protected_heartbeat_shutdown",
        timeoutMs: d.store.heartbeatTimeoutMs ?? 1_000,
        timeoutCode: "PROTECTED_HEARTBEAT_SHUTDOWN_TIMEOUT",
        dispatchPosition:
          facts.mutation.dispatch === "not_started" ? "pre_dispatch" : "post_dispatch",
        work: () => heartbeatWork,
      }).catch(() => undefined);
    };
    try {
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
        if (!d.liveProtectedSession) safeSession.provenance.transition("safe_parked");
        await runProtectedStage({
          stage: "safe_context_provenance",
          timeoutMs: transaction.extraction.timeoutMs,
          signal: lifecycleSignal,
          timeoutCode: "PROTECTED_CONTEXT_PROVENANCE_TIMEOUT",
          dispatchPosition: "pre_dispatch",
          work: () =>
            d.onContextProvenance?.({
              contextId: safeSession.provenance.contextId,
              provenance: "safe_parked",
              operationId: transaction.operationId,
            }) ?? Promise.resolve(),
        });
        await d.gate.beginProtected();
        facts.evidence = "stopped";

        facts.bootstrap = { status: "running" };
        await d.store.record({
          operationId: transaction.operationId,
          fencingToken: claim.fencingToken,
          phase: "capsule_bootstrapping",
        });
        let storageState:
          Awaited<ReturnType<SafeBrowserSession["context"]["storageState"]>> | undefined;
        let sessionStorageState: { origin: string; entries: Array<[string, string]> } | undefined;
        if (d.liveProtectedSession) {
          if (
            d.liveProtectedSession.provenance.contextId !== safeSession.provenance.contextId ||
            d.liveProtectedSession.provenance.value() !== "protected"
          )
            throw new PhaseError("PROTECTED_LIVE_SESSION_MISMATCH", "bootstrap", "do_not_retry");
          capsule = d.liveProtectedSession;
        }
        if (!capsule) {
          try {
            // IndexedDB serialization is optional for capsule handoff. Some applications keep
            // non-serializable values there; cookies and web storage remain the portable auth state.
            storageState = await runProtectedStage({
              stage: "portable_state_export",
              timeoutMs: transaction.extraction.timeoutMs,
              signal: lifecycleSignal,
              timeoutCode: "PROTECTED_PORTABLE_STATE_EXPORT_TIMEOUT",
              dispatchPosition: "pre_dispatch",
              work: () =>
                capturePraxisStorageState(safeSession.context, { indexedDB: true }).catch(() =>
                  capturePraxisStorageState(safeSession.context),
                ),
            });
          } catch {
            throw new PhaseError(
              "PROTECTED_PORTABLE_STATE_EXPORT_FAILED",
              "bootstrap",
              "safe_to_retry",
            );
          }
          try {
            sessionStorageState = {
              origin: new URL(safeSession.page.url()).origin,
              entries: await runProtectedStage({
                stage: "session_state_export",
                timeoutMs: transaction.extraction.timeoutMs,
                signal: lifecycleSignal,
                timeoutCode: "PROTECTED_SESSION_STATE_EXPORT_TIMEOUT",
                dispatchPosition: "pre_dispatch",
                work: () => capturePraxisSessionStorage(safeSession.page),
              }),
            };
          } catch {
            throw new PhaseError(
              "PROTECTED_SESSION_STATE_EXPORT_FAILED",
              "bootstrap",
              "safe_to_retry",
            );
          }
          try {
            capsule = await runProtectedStage({
              stage: "capsule_bootstrap",
              timeoutMs: transaction.extraction.timeoutMs,
              signal: lifecycleSignal,
              timeoutCode: "PROTECTED_CAPSULE_CREATION_TIMEOUT",
              dispatchPosition: "pre_dispatch",
              work: () =>
                d.capsuleFactory.create({
                  storageState: storageState!,
                  ...(sessionStorageState ? { sessionStorage: sessionStorageState } : {}),
                  prepare: d.prepareCapsule,
                }),
            });
          } catch {
            throw new PhaseError("PROTECTED_CAPSULE_CREATION_FAILED", "bootstrap", "safe_to_retry");
          }
        }
        facts.capsule = "active";
        await runProtectedStage({
          stage: "protected_context_provenance",
          timeoutMs: transaction.extraction.timeoutMs,
          signal: lifecycleSignal,
          timeoutCode: "PROTECTED_CONTEXT_PROVENANCE_TIMEOUT",
          dispatchPosition: "pre_dispatch",
          work: () =>
            d.onContextProvenance?.({
              contextId: capsule!.provenance.contextId,
              provenance: "protected",
              operationId: transaction.operationId,
            }) ?? Promise.resolve(),
        });
        if (!d.liveProtectedSession) {
          try {
            await gotoPraxisPage(capsule.page, transaction.entry.url, {
              waitUntil: "domcontentloaded",
            });
          } catch {
            throw new PhaseError(
              "TRANSACTION_ENTRY_NAVIGATION_FAILED",
              "bootstrap",
              "safe_to_retry",
            );
          }
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
          await runProtectedStage({
            stage: "protected_preparation",
            timeoutMs: transaction.extraction.timeoutMs,
            signal: lifecycleSignal,
            timeoutCode: "PROTECTED_PREPARATION_TIMEOUT",
            dispatchPosition: "pre_dispatch",
            work: async () => {
              await executeProtectedPreparation(capsule!.page, transaction, lifecycleDependencies);
              await verifyProtectedTransactionAssertions(
                capsule!.page,
                transaction.preparation.assertions,
                transaction,
                lifecycleDependencies,
              );
            },
          });
          if (observedEffects.some((effect) => effect.disposition === "blocked"))
            throw new PhaseError(
              "UNDECLARED_PREPARATION_SIDE_EFFECT",
              "preparation",
              "do_not_retry",
            );
        } catch (error) {
          const failure =
            error instanceof PhaseError
              ? error
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
        await runProtectedStage({
          stage: "preparation_verification_callback",
          timeoutMs: transaction.extraction.timeoutMs,
          signal: lifecycleSignal,
          timeoutCode: "PROTECTED_PREPARATION_VERIFICATION_TIMEOUT",
          dispatchPosition: "pre_dispatch",
          work: () => d.onPreparationVerified?.(capsule!, transaction) ?? Promise.resolve(),
        });
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
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: "preparing",
            next: "ready_to_dispatch",
            phase: "ready_to_dispatch",
          });
        }
        facts.mutation.dispatch = "authorized";
        await d.store.record({
          operationId: transaction.operationId,
          fencingToken: claim.fencingToken,
          phase: "dispatch_authorized",
        });
        await d.onReadyToDispatch?.({
          operationId: transaction.operationId,
          disposition: d.dispatchDisposition ?? "execute",
        });
        if (d.dispatchDisposition === "qualification_only") {
          await d.store.record({
            operationId: transaction.operationId,
            fencingToken: claim.fencingToken,
            phase: "ready_to_dispatch_proven",
            facts: { dispatchDisposition: "qualification_only" },
          });
          claim = await d.store.transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: "ready_to_dispatch",
            next: "failed_not_applied",
            phase: "dispatch_withheld_by_policy",
            reasonCode: "PROTECTED_DISPATCH_WITHHELD_BY_QUALIFICATION_POLICY",
          });
          facts.mutation.dispatch = "not_started";
          facts.mutation.outcome = "confirmed_not_applied";
          throw new PhaseError(
            "PROTECTED_DISPATCH_WITHHELD_BY_QUALIFICATION_POLICY",
            "mutation_dispatch",
            "do_not_retry",
          );
        }
        claim = await d.store.transition({
          id: claim.id,
          operationId: transaction.operationId,
          version: claim.version,
          fencingToken: claim.fencingToken,
          expected: "ready_to_dispatch",
          next: "dispatching",
          phase: "mutation_dispatching",
        });
        responseEnvelope = beginProtectedResponseEnvelope(
          capsule.page,
          d.allowedOrigins,
          d.redactor,
          d.stageResponseOutputsAtomically || transaction.mutation.request
            ? {
                ...(d.stageResponseOutputsAtomically
                  ? {
                      outputs: transaction.extraction.outputs,
                      stage: (outputs) =>
                        d.stageResponseOutputsAtomically!({
                          operationId: transaction.operationId,
                          claim,
                          outputs,
                        }),
                    }
                  : {}),
                ...(transaction.mutation.request ? { request: transaction.mutation.request } : {}),
              }
            : undefined,
        );
        await runProtectedStage({
          stage: "mutation_dispatch_callback",
          timeoutMs: transaction.extraction.timeoutMs,
          signal: lifecycleSignal,
          timeoutCode: "PROTECTED_MUTATION_DISPATCH_TIMEOUT",
          dispatchPosition: "post_dispatch",
          work: () => Promise.resolve(d.onMutationDispatch?.()).then(() => undefined),
        });
        facts.mutation.dispatch = "started";
        capsule.provenance.transition("tainted");
        await runProtectedStage({
          stage: "tainted_context_provenance",
          timeoutMs: transaction.extraction.timeoutMs,
          signal: lifecycleSignal,
          timeoutCode: "PROTECTED_CONTEXT_PROVENANCE_TIMEOUT",
          dispatchPosition: "post_dispatch",
          work: () =>
            d.onContextProvenance?.({
              contextId: capsule!.provenance.contextId,
              provenance: "tainted",
              operationId: transaction.operationId,
            }) ?? Promise.resolve(),
        });
        await d.store.record({
          operationId: transaction.operationId,
          fencingToken: claim.fencingToken,
          phase: "mutation_dispatching",
        });
        responseEnvelope.beginActionCapture();
        try {
          await abortable(
            executeProtectedReveal(capsule.page, transaction, d.allowedOrigins, lifecycleSignal),
            lifecycleSignal,
          );
        } catch (error) {
          responseEnvelope.endActionCapture();
          throw error;
        }

        if (
          transaction.mutation.dispatchSemantics === "read_only" ||
          transaction.mutation.request
        ) {
          const requestInitiation = await responseEnvelope.waitForRequestInitiation(
            Math.min(5_000, transaction.extraction.timeoutMs),
          );
          responseEnvelope.endActionCapture();

          if (requestInitiation.status === "initiated") {
            facts.mutation.request = {
              status: "initiated",
              method: requestInitiation.method,
              transport: requestInitiation.resourceType,
              envelopeMatched: true,
            };
            await d.store.record({
              operationId: transaction.operationId,
              fencingToken: claim.fencingToken,
              phase: "request_initiated",
              facts: {
                mutation: {
                  request: {
                    status: "initiated",
                    method: requestInitiation.method,
                    transport: requestInitiation.resourceType,
                    envelopeMatched: true,
                  },
                },
              },
            });
          } else {
            const reasonCode =
              requestInitiation.status === "lineage_ambiguous"
                ? "PROTECTED_REQUEST_LINEAGE_AMBIGUOUS"
                : requestInitiation.status === "outside_envelope"
                  ? "PROTECTED_REQUEST_OUTSIDE_ENVELOPE"
                  : requestInitiation.status === "unsupported_transport"
                    ? "PROTECTED_REQUEST_TRANSPORT_UNSUPPORTED"
                    : "PROTECTED_REQUEST_NOT_INITIATED";

            facts.mutation.request =
              requestInitiation.status === "outside_envelope"
                ? {
                    status: "outside_envelope",
                    method: requestInitiation.method,
                    transport: requestInitiation.resourceType,
                    envelopeMatched: false,
                  }
                : requestInitiation.status === "unsupported_transport"
                  ? {
                      status: "unsupported_transport",
                      transport: requestInitiation.transport,
                      envelopeMatched: false,
                    }
                  : {
                      status: "not_initiated",
                      envelopeMatched: false,
                    };

            await d.store.record({
              operationId: transaction.operationId,
              fencingToken: claim.fencingToken,
              phase:
                requestInitiation.status === "lineage_ambiguous"
                  ? "request_lineage_ambiguous"
                  : requestInitiation.status === "outside_envelope"
                    ? "request_outside_envelope"
                    : requestInitiation.status === "unsupported_transport"
                      ? "request_transport_unsupported"
                      : "request_not_initiated",
              facts: {
                reasonCode,
                mutation: {
                  request: {
                    status: requestInitiation.status,
                    ...(requestInitiation.status === "outside_envelope"
                      ? {
                          method: requestInitiation.method,
                          transport: requestInitiation.resourceType,
                          envelopeMatched: false,
                        }
                      : requestInitiation.status === "unsupported_transport"
                        ? {
                            transport: requestInitiation.transport,
                            envelopeMatched: false,
                          }
                        : {
                            envelopeMatched: false,
                          }),
                  },
                },
              },
            });

            throw new PhaseError(reasonCode, "acquisition", "safe_to_retry");
          }
        } else {
          responseEnvelope.endActionCapture();
        }

        const responseSettled = await responseEnvelope.settle(transaction.extraction.timeoutMs);
        facts.responseEvidence = responseEnvelope.evidence();
        await d.store.record({
          operationId: transaction.operationId,
          fencingToken: claim.fencingToken,
          phase: responseSettled ? "response_settled" : "response_settlement_timed_out",
          facts: { responseEvidence: facts.responseEvidence },
        });
        if (!responseSettled) {
          // The network adapter is now closed to late/partial admission, but a
          // complete set may still be acquired through another declared method.
          await d.store.record({
            operationId: transaction.operationId,
            fencingToken: claim.fencingToken,
            phase: "response_settlement_timed_out",
            facts: { reasonCode: "PROTECTED_RESPONSE_SETTLEMENT_TIMEOUT" },
          });
        }
        assertOwned();
        claim = await d.store.transition({
          id: claim.id,
          operationId: transaction.operationId,
          version: claim.version,
          fencingToken: claim.fencingToken,
          expected: "dispatching",
          next: "dispatched",
          phase: "mutation_dispatched",
        });
        claim = await d.store.transition({
          id: claim.id,
          operationId: transaction.operationId,
          version: claim.version,
          fencingToken: claim.fencingToken,
          expected: "dispatched",
          next: "acquiring",
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
        facts.responseEvidence = responseEnvelope.evidence();
        assertOwned();
        claim = await d.store.transition({
          id: claim.id,
          operationId: transaction.operationId,
          version: claim.version,
          fencingToken: claim.fencingToken,
          expected: "acquiring",
          next: "persisting",
          phase: "persistence_running",
        });
        claim = await persistAcquiredProtectedOutputs(transaction, d, facts, acquired, claim);
        if (!protectedOutputsPersisted(transaction, facts))
          await recoverProtectedAcquisition(capsule.page, transaction, d, facts, claim);
        facts.reconciliation =
          transaction.mutation.dispatchSemantics === "read_only"
            ? "not_applied"
            : await reconcileProtectedMutation(
                safeSession,
                transaction,
                claim.fencingToken,
                facts,
                lifecycleDependencies,
              );
        if (facts.reconciliation === "succeeded" || facts.reconciliation === "not_applied") {
          const settledOutcome =
            facts.reconciliation === "not_applied" ||
            transaction.mutation.dispatchSemantics === "read_only"
              ? "not_applied"
              : "applied";
          claim = await d.store.settleMutationOutcome({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            outcome: settledOutcome,
          });
          facts.mutation.outcome =
            settledOutcome === "applied" ? "confirmed_succeeded" : "confirmed_not_applied";
        }
      } catch (error) {
        if (responseEnvelope) facts.responseEvidence = responseEnvelope.evidence();
        // An eligible non-success response is the authoritative cause even when
        // its event races the outer acquisition deadline. Preserve the bounded
        // status evidence and never let the scheduler-dependent stage timeout
        // replace the precise fail-closed classification.
        const authoritativeHttpRejection =
          facts.responseEvidence?.eligibleResponseSelected === true &&
          typeof facts.responseEvidence.httpStatusCode === "number" &&
          (facts.responseEvidence.httpStatusCode < 200 ||
            facts.responseEvidence.httpStatusCode >= 400);
        const failure = authoritativeHttpRejection
          ? new PhaseError("PROTECTED_RESPONSE_HTTP_REJECTED", "acquisition", "safe_to_retry")
          : protectedPhaseFailure(error, facts);
        facts.reasonCode = failure.code;
        facts.failurePhase = failure.phase;
        facts.retryClass = failure.retryClass;
        if (facts.bootstrap.status === "running")
          facts.bootstrap = { status: "failed", code: failure.code };
        if (facts.preparation.status === "running")
          facts.preparation = { status: "failed", code: failure.code };
        if (facts.mutation.dispatch !== "not_started") {
          const readOnly = transaction.mutation.dispatchSemantics === "read_only";
          const responseProvesNotApplied =
            authoritativeHttpRejection &&
            typeof facts.responseEvidence?.httpStatusCode === "number" &&
            (transaction.mutation.response?.confirmedNotAppliedStatuses.includes(
              facts.responseEvidence.httpStatusCode,
            ) ??
              false);
          facts.mutation.outcome =
            readOnly || responseProvesNotApplied ? "confirmed_not_applied" : "unknown";
          if (readOnly || responseProvesNotApplied) {
            facts.retryClass = "safe_to_retry";
            if (responseProvesNotApplied && !readOnly) {
              claim = await d.store.settleMutationOutcome({
                id: claim.id,
                operationId: transaction.operationId,
                version: claim.version,
                fencingToken: claim.fencingToken,
                outcome: "not_applied",
              });
            }
            if (
              [
                "dispatching",
                "dispatched",
                "acquiring",
                "persisting",
                "persisted",
                "reconciling",
              ].includes(claim.state)
            ) {
              claim = await d.store
                .transition({
                  id: claim.id,
                  operationId: transaction.operationId,
                  version: claim.version,
                  fencingToken: claim.fencingToken,
                  expected: claim.state,
                  next: "failed_not_applied",
                  phase: "failed_not_applied",
                  reasonCode: failure.code,
                  facts: { ...facts, diagnostics: undefined },
                })
                .catch(() => claim);
            }
          }
          if (
            !readOnly &&
            [
              "dispatching",
              "dispatched",
              "acquiring",
              "persisting",
              "persisted",
              "reconciling",
            ].includes(claim.state)
          ) {
            claim = await d.store
              .transition({
                id: claim.id,
                operationId: transaction.operationId,
                version: claim.version,
                fencingToken: claim.fencingToken,
                expected: claim.state,
                next: "recovery_required",
                phase: "recovery_required",
                reasonCode: failure.code,
                facts: { ...facts, diagnostics: undefined },
              })
              .catch(() => claim);
          }
        }
      } finally {
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
            await runProtectedStage({
              stage: "destroyed_context_provenance",
              timeoutMs: transaction.extraction.timeoutMs,
              signal: lifecycleSignal,
              timeoutCode: "PROTECTED_CONTEXT_PROVENANCE_TIMEOUT",
              dispatchPosition:
                facts.mutation.dispatch === "not_started" ? "pre_dispatch" : "post_dispatch",
              work: () =>
                d.onContextProvenance?.({
                  contextId: capsule!.provenance.contextId,
                  provenance: "destroyed",
                  operationId: transaction.operationId,
                }) ?? Promise.resolve(),
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
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: claim.state,
            next: "failed_not_applied",
            phase: "failed_not_applied",
            reasonCode: facts.reasonCode,
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
          await Promise.all(
            Object.values(facts.credentialReferences).map((credentialId) =>
              d.markCredentialCompromised?.(
                credentialId,
                facts.reasonCode ?? "CAPSULE_DESTRUCTION_FAILED",
                transaction.operationId,
              ),
            ),
          );
          if (Object.keys(facts.credentialReferences).length)
            facts.credentialSecurity = "compromised";
        }
        if (facts.reconciliation !== "succeeded" && facts.reconciliation !== "not_applied") {
          facts.reconciliation =
            transaction.mutation.dispatchSemantics === "read_only"
              ? "not_applied"
              : await reconcileProtectedMutation(
                  safeSession,
                  transaction,
                  claim.fencingToken,
                  facts,
                  lifecycleDependencies,
                );
        }
        if (
          (facts.reconciliation === "succeeded" || facts.reconciliation === "not_applied") &&
          claim.mutationOutcome !== "applied" &&
          claim.mutationOutcome !== "not_applied" &&
          ["persisted", "reconciling"].includes(claim.state)
        ) {
          const settledOutcome =
            facts.reconciliation === "not_applied" ||
            transaction.mutation.dispatchSemantics === "read_only"
              ? "not_applied"
              : "applied";
          claim = await d.store.settleMutationOutcome({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            outcome: settledOutcome,
          });
          facts.mutation.outcome =
            settledOutcome === "applied" ? "confirmed_succeeded" : "confirmed_not_applied";
        }
        await d.gate.seal({ code: facts.reasonCode ?? "PROTECTED_TRANSACTION_FAILED" });
        if (["persisted", "reconciling"].includes(claim.state)) {
          claim = await d.store.transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: claim.state,
            next: "recovery_required",
            phase: "recovery_required",
            reasonCode: facts.reasonCode ?? "PROTECTED_TRANSACTION_FAILED",
            facts: { ...facts, diagnostics: undefined },
          });
        }
        const status = facts.mutation.outcome === "unknown" ? "outcome_unknown" : "aborted";
        await this.persistFinal(transaction, claim.fencingToken, status, facts);
        return {
          safeSession,
          terminal: true,
          result: result(
            facts,
            status,
            facts.mutation.outcome === "unknown"
              ? ["manual_reconciliation", "abort"]
              : ["retry_transaction", "abort"],
          ),
        };
      }

      await runProtectedStage({
        stage: "protected_capture_settlement",
        timeoutMs: transaction.extraction.timeoutMs,
        signal: lifecycleSignal,
        timeoutCode: "PROTECTED_CAPTURE_SETTLEMENT_TIMEOUT",
        dispatchPosition: "post_dispatch",
        work: () => d.gate.markCaptured(),
      });
      assertOwned();
      if (claim.state === "persisted") {
        claim = await d.store.transition({
          id: claim.id,
          operationId: transaction.operationId,
          version: claim.version,
          fencingToken: claim.fencingToken,
          expected: "persisted",
          next: "reconciling",
          phase: "reconciliation",
        });
      }
      if (facts.reconciliation !== "succeeded" && facts.reconciliation !== "not_applied") {
        facts.reconciliation = await reconcileProtectedMutation(
          safeSession,
          transaction,
          claim.fencingToken,
          facts,
          lifecycleDependencies,
        );
      }
      if (
        (facts.reconciliation === "succeeded" || facts.reconciliation === "not_applied") &&
        claim.mutationOutcome !== "applied" &&
        claim.mutationOutcome !== "not_applied"
      ) {
        const settledOutcome =
          facts.reconciliation === "not_applied" ||
          transaction.mutation.dispatchSemantics === "read_only"
            ? "not_applied"
            : "applied";
        claim = await d.store.settleMutationOutcome({
          id: claim.id,
          operationId: transaction.operationId,
          version: claim.version,
          fencingToken: claim.fencingToken,
          outcome: settledOutcome,
        });
        facts.mutation.outcome =
          settledOutcome === "applied" ? "confirmed_succeeded" : "confirmed_not_applied";
      }
      if (
        (facts.reconciliation === "not_applied" &&
          transaction.mutation.dispatchSemantics !== "read_only") ||
        facts.reconciliation === "failed"
      ) {
        const provenNotApplied = facts.reconciliation === "not_applied";
        const reasonCode = provenNotApplied
          ? "MUTATION_RECONCILIATION_NOT_APPLIED"
          : "MUTATION_RECONCILIATION_FAILED";
        await d.gate.seal({ code: reasonCode });
        if (claim.state === "reconciling") {
          claim = await d.store.transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: "reconciling",
            next: provenNotApplied ? "failed_not_applied" : "recovery_required",
            phase: provenNotApplied ? "failed_not_applied" : "recovery_required",
            reasonCode,
          });
        }
        facts.reasonCode = reasonCode;
        await this.persistFinal(transaction, claim.fencingToken, "aborted", facts);
        return {
          safeSession,
          terminal: true,
          result: result(
            facts,
            "aborted",
            provenNotApplied ? ["retry_transaction", "abort"] : ["manual_reconciliation", "abort"],
          ),
        };
      }

      if (d.liveProtectedSession) {
        await runProtectedStage({
          stage: "protected_live_session_terminal_seal",
          timeoutMs: transaction.extraction.timeoutMs,
          signal: lifecycleSignal,
          timeoutCode: "PROTECTED_TERMINAL_PRIVACY_SEAL_TIMEOUT",
          dispatchPosition: "post_dispatch",
          // The only browser authority was deliberately destroyed above. There
          // is no surviving page on which collectors can safely resume, so this
          // path terminates with Veil sealed after the durable mutation and
          // output facts have already been established.
          work: () => d.gate.seal({ code: "TERMINAL_PROTECTED_TRANSACTION" }),
        });
        facts.continuation = "terminal";
        await this.persistFinal(transaction, claim.fencingToken, "terminal", facts);
        if (claim.state === "reconciling") {
          claim = await d.store.transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: "reconciling",
            next: "completed",
            phase: "completed",
            facts: { ...facts, diagnostics: undefined },
          });
        }
        return { safeSession, terminal: true, result: result(facts, "terminal", []) };
      }

      const continuation = await continueAfterProtectedMutation(
        transaction,
        safeSession,
        lifecycleDependencies,
      );
      assertOwned();
      safeSession = continuation.safeSession;
      facts.continuation = continuation.status;
      if (continuation.status === "terminal") {
        await d.gate.seal({ code: "TERMINAL_PROTECTED_TRANSACTION" });
        if (claim.state === "reconciling")
          claim = await d.store.transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: "reconciling",
            next: "completed",
            phase: "completed",
          });
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
        if (claim.state === "reconciling")
          claim = await d.store.transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: "reconciling",
            next: "completed",
            phase: "completed",
          });
        await this.persistFinal(transaction, claim.fencingToken, "continuing_unrecorded", facts);
        return {
          safeSession,
          terminal: false,
          result: result(facts, "continuing_unrecorded", ["abort"]),
        };
      }
      if (continuation.status === "failed" || !continuation.continuedAtStepId) {
        await d.gate.seal({ code: "CONTINUATION_FAILED" });
        if (claim.state === "reconciling")
          claim = await d.store.transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: "reconciling",
            next: "recovery_required",
            phase: "recovery_required",
            reasonCode: "CONTINUATION_FAILED",
          });
        await this.persistFinal(transaction, claim.fencingToken, "aborted", facts);
        return {
          safeSession,
          terminal: true,
          result: result(facts, "aborted", ["retry_continuation", "abort"]),
        };
      }
      await runProtectedStage({
        stage: "safe_boundary_establishment",
        timeoutMs: transaction.extraction.timeoutMs,
        signal: lifecycleSignal,
        timeoutCode: "PROTECTED_SAFE_BOUNDARY_ESTABLISHMENT_TIMEOUT",
        dispatchPosition: "post_dispatch",
        work: () => d.gate.beginSafeBoundary(),
      });
      await runProtectedStage({
        stage: "safe_boundary_confirmation",
        timeoutMs: transaction.extraction.timeoutMs,
        signal: lifecycleSignal,
        timeoutCode: "PROTECTED_SAFE_BOUNDARY_CONFIRMATION_TIMEOUT",
        dispatchPosition: "post_dispatch",
        work: () =>
          d.gate.confirmSafeBoundary({
            kind: "protected_context_destroyed",
            contextId: capsule?.provenance.contextId ?? randomUUID(),
          }),
      });
      assertOwned();
      facts.evidence = "resumed";
      facts.protectedAcquisitionEvidence = facts.protectedAcquisitionEvidence.map((evidence) => ({
        ...evidence,
        capsule: facts.capsule === "force_terminated" ? "force_terminated" : "destroyed",
        evidenceClosure: "resumed",
      }));
      await runProtectedStage({
        stage: "resumed_context_provenance",
        timeoutMs: transaction.extraction.timeoutMs,
        signal: lifecycleSignal,
        timeoutCode: "PROTECTED_CONTEXT_PROVENANCE_TIMEOUT",
        dispatchPosition: "post_dispatch",
        work: () =>
          d.onContextProvenance?.({
            contextId: safeSession.provenance.contextId,
            provenance: safeSession.provenance.value(),
            operationId: transaction.operationId,
          }) ?? Promise.resolve(),
      });
      await runProtectedStage({
        stage: "evidence_resumption",
        timeoutMs: transaction.extraction.timeoutMs,
        signal: lifecycleSignal,
        timeoutCode: "PROTECTED_EVIDENCE_RESUMPTION_TIMEOUT",
        dispatchPosition: "post_dispatch",
        work: () =>
          d.onEvidenceResumed?.({
            contextId: safeSession.provenance.contextId,
            operationId: transaction.operationId,
            continuedAtStepId: continuation.continuedAtStepId,
          }) ?? Promise.resolve(),
      });
      assertOwned();
      if (claim.state === "reconciling") {
        // Persist final diagnostics while this process still owns the lease.
        // The terminal transition intentionally releases ownership, after which
        // repository fencing must reject every late write from this execution.
        await this.persistFinal(transaction, claim.fencingToken, "completed", facts);
        claim = await d.store.transition({
          id: claim.id,
          operationId: transaction.operationId,
          version: claim.version,
          fencingToken: claim.fencingToken,
          expected: "reconciling",
          next: "completed",
          phase: "completed",
          facts: { ...facts, diagnostics: undefined },
        });
      }
      return {
        safeSession,
        terminal: false,
        result: result(facts, "completed", [], continuation.continuedAtStepId),
      };
    } catch (error) {
      const failure = protectedPhaseFailure(error, facts);
      facts.reasonCode = failure.code;
      facts.failurePhase = failure.phase;
      facts.retryClass =
        facts.mutation.dispatch === "not_started"
          ? "safe_to_retry"
          : "retry_requires_reconciliation";
      if (facts.mutation.dispatch !== "not_started") {
        facts.mutation.outcome =
          claim.mutationOutcome === "applied"
            ? "confirmed_succeeded"
            : claim.mutationOutcome === "not_applied"
              ? "confirmed_not_applied"
              : "unknown";
      }
      await d.gate.seal({ code: failure.code }).catch(() => undefined);
      if (
        [
          "dispatching",
          "dispatched",
          "acquiring",
          "persisting",
          "persisted",
          "reconciling",
        ].includes(claim.state)
      ) {
        claim = await d.store
          .transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: claim.state,
            next: "recovery_required",
            phase: "recovery_required",
            reasonCode: failure.code,
            facts: { ...facts, diagnostics: undefined },
          })
          .catch(() => claim);
      }
      const failedStatus =
        facts.mutation.dispatch === "not_started"
          ? "aborted"
          : facts.mutation.outcome === "unknown"
            ? "outcome_unknown"
            : "aborted";
      await this.persistFinal(transaction, claim.fencingToken, failedStatus, facts).catch(
        () => undefined,
      );
      return {
        safeSession,
        terminal: true,
        result: result(
          facts,
          failedStatus,
          facts.mutation.dispatch === "not_started"
            ? ["retry_transaction", "abort"]
            : facts.mutation.outcome === "unknown"
              ? ["manual_reconciliation", "abort"]
              : ["retry_continuation", "abort"],
        ),
      };
    } finally {
      await stopHeartbeat();
    }
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
      facts.protectedPersistence = Object.values(references).some(
        (value) => value.classification === "protected",
      )
        ? "confirmed"
        : "not_attempted";
      facts.publicPersistence = Object.values(references).some(
        (value) => value.classification === "public",
      )
        ? "confirmed"
        : "not_attempted";
      facts.capsule = "destroyed";
      return {
        safeSession: this.dependencies.safeSession,
        terminal: false,
        result: result(facts, "completed", []),
      };
    }
    facts.reasonCode =
      claim.state === "failed_not_applied"
        ? "PROTECTED_OPERATION_NOT_APPLIED"
        : "PROTECTED_OPERATION_TERMINAL";
    facts.mutation.outcome =
      claim.state === "failed_not_applied" ? "confirmed_not_applied" : "unknown";
    return {
      safeSession: this.dependencies.safeSession,
      terminal: true,
      result: result(
        facts,
        claim.state === "failed_not_applied" ? "aborted" : "outcome_unknown",
        [],
      ),
    };
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
    let protectedMaterialObserved = Object.values(references).some(
      (stored) => stored.classification === "protected",
    );
    for (const [reference, stored] of Object.entries(references)) {
      if (stored.classification === "protected" && stored.credentialId)
        facts.credentialReferences[reference] = stored.credentialId;
      if (stored.classification === "public" && stored.valueId)
        facts.publicValueReferences[reference] = stored.valueId;
    }
    let completeSet = transaction.extraction.outputs.every(
      (output) => output.reference in references,
    );
    if (
      !completeSet &&
      claim.state === "recovery_required" &&
      this.dependencies.recoverStagedResponseOutputs
    ) {
      const staged = await runProtectedStage({
        stage: "staged_output_recovery",
        timeoutMs: transaction.extraction.timeoutMs,
        signal: this.dependencies.signal,
        timeoutCode: "PROTECTED_STAGED_OUTPUT_RECOVERY_TIMEOUT",
        dispatchPosition:
          transaction.mutation.dispatchSemantics === "read_only" ? "read_only" : "post_dispatch",
        work: () =>
          this.dependencies.recoverStagedResponseOutputs!({
            operationId: transaction.operationId,
            claim,
          }),
      });
      if (staged?.length) {
        protectedMaterialObserved ||= staged.some(
          (output) => output.classification === "protected",
        );
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
          output: transaction.extraction.outputs.find(
            (candidate) => candidate.reference === output.reference,
          )!,
          value: output.value,
          adapter: "protected_network_value" as const,
        }));
        if (
          acquired.length === transaction.extraction.outputs.length &&
          acquired.every((item) => item.output)
        ) {
          claim = await persistAcquiredProtectedOutputs(
            transaction,
            this.dependencies,
            facts,
            acquired,
            claim,
          );
          completeSet = transaction.extraction.outputs.every(
            (output) => output.reference in (claim.persistedReferences ?? {}),
          );
          for (const [reference, stored] of Object.entries(claim.persistedReferences ?? {})) {
            if (stored.classification === "protected" && stored.credentialId)
              facts.credentialReferences[reference] = stored.credentialId;
            if (stored.classification === "public" && stored.valueId)
              facts.publicValueReferences[reference] = stored.valueId;
          }
        }
      }
    }
    if (!completeSet || claim.state === "compromised") {
      for (const credentialId of Object.values(facts.credentialReferences))
        await this.dependencies.markCredentialCompromised?.(
          credentialId,
          "PROTECTED_ACQUISITION_INTERRUPTED",
          transaction.operationId,
        );
      if (protectedMaterialObserved || claim.state === "compromised") {
        if (claim.state !== "compromised") {
          claim = await this.dependencies.store.transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: claim.state,
            next: "compromised",
            phase: "compromised",
            reasonCode: "PROTECTED_ACQUISITION_INTERRUPTED",
          });
        }
        facts.credentialSecurity = "compromised";
        facts.reasonCode = "PROTECTED_ACQUISITION_INTERRUPTED";
      } else {
        if (claim.state !== "recovery_required") {
          claim = await this.dependencies.store.transition({
            id: claim.id,
            operationId: transaction.operationId,
            version: claim.version,
            fencingToken: claim.fencingToken,
            expected: claim.state,
            next: "recovery_required",
            phase: "recovery_required",
            reasonCode: "PROTECTED_ACQUISITION_INCOMPLETE",
          });
        }
        facts.credentialSecurity = "none";
        facts.reasonCode = "PROTECTED_ACQUISITION_INCOMPLETE";
      }
      facts.retryClass = "do_not_retry";
      return {
        safeSession: this.dependencies.safeSession,
        terminal: true,
        result: result(facts, "outcome_unknown", ["manual_reconciliation", "abort"]),
      };
    }
    if (claim.state === "persisted" || claim.state === "recovery_required") {
      claim = await this.dependencies.store.transition({
        id: claim.id,
        operationId: transaction.operationId,
        version: claim.version,
        fencingToken: claim.fencingToken,
        expected: claim.state,
        next: "reconciling",
        phase: "reconciliation",
      });
    }
    if (claim.state !== "reconciling") return this.outcomeUnknown(transaction, claim.fencingToken);
    facts.protectedPersistence = Object.values(references).some(
      (stored) => stored.classification === "protected",
    )
      ? "confirmed"
      : "not_attempted";
    facts.publicPersistence = Object.values(references).some(
      (stored) => stored.classification === "public",
    )
      ? "confirmed"
      : "not_attempted";
    facts.reconciliation = await reconcileProtectedMutation(
      this.dependencies.safeSession,
      transaction,
      claim.fencingToken,
      facts,
      this.dependencies,
    );
    if (facts.reconciliation === "succeeded" || facts.reconciliation === "not_applied") {
      const settledOutcome =
        facts.reconciliation === "not_applied" ||
        transaction.mutation.dispatchSemantics === "read_only"
          ? "not_applied"
          : "applied";
      claim = await this.dependencies.store.settleMutationOutcome({
        id: claim.id,
        operationId: transaction.operationId,
        version: claim.version,
        fencingToken: claim.fencingToken,
        outcome: settledOutcome,
      });
      facts.mutation.outcome =
        settledOutcome === "applied" ? "confirmed_succeeded" : "confirmed_not_applied";
    }
    if (
      facts.reconciliation === "not_applied" &&
      transaction.mutation.dispatchSemantics !== "read_only"
    ) {
      claim = await this.dependencies.store.transition({
        id: claim.id,
        operationId: transaction.operationId,
        version: claim.version,
        fencingToken: claim.fencingToken,
        expected: "reconciling",
        next: "failed_not_applied",
        phase: "failed_not_applied",
        reasonCode: "MUTATION_RECONCILIATION_NOT_APPLIED",
      });
      facts.reasonCode = "MUTATION_RECONCILIATION_NOT_APPLIED";
      return {
        safeSession: this.dependencies.safeSession,
        terminal: true,
        result: result(facts, "aborted", ["retry_transaction", "abort"]),
      };
    }
    if (facts.reconciliation !== "succeeded") {
      claim = await this.dependencies.store.transition({
        id: claim.id,
        operationId: transaction.operationId,
        version: claim.version,
        fencingToken: claim.fencingToken,
        expected: "reconciling",
        next: "recovery_required",
        phase: "recovery_required",
        reasonCode: "MUTATION_RECONCILIATION_REQUIRED",
      });
      facts.reasonCode = "MUTATION_RECONCILIATION_REQUIRED";
      return {
        safeSession: this.dependencies.safeSession,
        terminal: true,
        result: result(facts, "outcome_unknown", ["manual_reconciliation", "abort"]),
      };
    }
    claim = await this.dependencies.store.transition({
      id: claim.id,
      operationId: transaction.operationId,
      version: claim.version,
      fencingToken: claim.fencingToken,
      expected: "reconciling",
      next: "completed",
      phase: "completed",
    });
    facts.mutation.outcome = "confirmed_succeeded";
    facts.credentialSecurity = Object.keys(facts.credentialReferences).length ? "active" : "none";
    return {
      safeSession: this.dependencies.safeSession,
      terminal: false,
      result: result(facts, "completed", []),
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

function protectedPhaseFailure(error: unknown, facts: Facts) {
  if (error instanceof PhaseError) return error;
  const phase =
    facts.mutation.dispatch === "started"
      ? "mutation_dispatch"
      : facts.preparation.status === "running"
        ? "preparation"
        : "bootstrap";
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
export async function executeProtectedTransactionCompatibility(input: {
  transaction: ProtectedTransaction;
  dependencies: ProtectedTransactionDependencies;
}): Promise<ProtectedTransactionExecution> {
  return new ProtectedTransactionKernel(input.dependencies).execute(input.transaction);
}

export class ProtectedTransactionCoordinator extends ProtectedTransactionKernel {}

export type ProtectedTransactionFacts = ReturnType<typeof initialFacts>;
type Facts = ProtectedTransactionFacts;
type ProtectedRequestEvidence = {
  status: "initiated" | "outside_envelope" | "unsupported_transport" | "not_initiated";
  method?: string;
  transport?: string;
  envelopeMatched: boolean;
};
function initialFacts() {
  return {
    bootstrap: { status: "not_started" as const },
    preparation: { status: "not_started" as const },
    mutation: {
      dispatch: "not_started" as const,
      outcome: "not_attempted" as const,
      request: undefined as undefined | ProtectedRequestEvidence,
    },
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
    responseEvidence: undefined as undefined | ProtectedResponseEvidence,
    reasonCode: undefined as string | undefined,
    failurePhase: undefined as string | undefined,
    retryClass: undefined as string | undefined,
  } as unknown as ProtectedTransactionResult & {
    mutation: ProtectedTransactionResult["mutation"] & { request?: ProtectedRequestEvidence };
    responseEvidence?: ProtectedResponseEvidence;
    failurePhase?: string;
    retryClass?: string;
  };
}
function result(
  facts: Facts,
  status: ProtectedTransactionResult["status"],
  safeActions: ProtectedTransactionResult["safeActions"],
  continuedAtStepId?: string,
): ProtectedTransactionResult {
  const { request: _request, ...mutation } = facts.mutation;
  return {
    ...facts,
    mutation,
    status,
    safeActions,
    ...(continuedAtStepId ? { continuedAtStepId } : {}),
  };
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
  if (signal.aborted) {
    // Work may have started before the composed signal was inspected. Keep a
    // rejection observer attached so a later cancellation result cannot escape
    // as an unhandled rejection after this owner has already failed closed.
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("RUN_ABORTED"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("RUN_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
