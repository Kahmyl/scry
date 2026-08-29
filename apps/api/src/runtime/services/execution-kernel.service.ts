import { Inject, Injectable, Optional } from "@nestjs/common";
import type { ExecutionCapabilityName, ExecutionMode, ExecutionRequest } from "@scry/contracts";
import {
  createExecutionCapabilityManifest,
  ExecutionKernel,
  type ExecutionReport,
} from "@scry/executor";
import { createAuthoringBrowserSession } from "@scry/praxis";
import type { ExecuteOptions, RuntimeExecutionCapabilities } from "@scry/executor";

import { ExecutionRepository } from "../repositories/execution.repository.js";
import { ExecutionKernelRepository } from "../repositories/execution-kernel.repository.js";
import { ProtectedOperationRepository } from "../repositories/protected-operation.repository.js";
import { ProtectedOutputPersistenceRepository } from "../repositories/protected-output-persistence.repository.js";
import { QualificationCampaignRepository } from "../repositories/qualification-campaign.repository.js";
import { NativeBrowserDriver } from "../native-browser-driver/index.js";
import { ProtectedTransactionKernel } from "../protected-transactions/protected-transaction-coordinator.js";
import { OperationalEvents } from "../../infrastructure/index.js";

type BaseCapabilityInput = {
  sessionId: string;
  operationId: string;
  correlationId: string;
  mode: ExecutionMode;
  options: Omit<ExecuteOptions, "plan" | "policy">;
  states?: Partial<Record<ExecutionCapabilityName, "available" | "policy_denied" | "unavailable">>;
  beforeMutationTransition?(input: { expected: string; next: string }): Promise<boolean>;
};

@Injectable()
export class ExecutionCapabilityFactory {
  constructor(
    @Inject(ExecutionRepository) private readonly executions: ExecutionRepository,
    @Inject(ExecutionKernelRepository) private readonly kernelRepository: ExecutionKernelRepository,
    @Inject(NativeBrowserDriver) private readonly nativeBrowser: NativeBrowserDriver,
    @Optional()
    @Inject(ProtectedOperationRepository)
    private readonly protectedOperations?: ProtectedOperationRepository,
    @Optional()
    @Inject(ProtectedOutputPersistenceRepository)
    private readonly protectedOutputs?: ProtectedOutputPersistenceRepository,
    @Optional()
    @Inject(OperationalEvents)
    private readonly operationalEvents?: OperationalEvents,
    @Inject(QualificationCampaignRepository)
    private readonly qualificationCampaigns?: QualificationCampaignRepository,
  ) {}

  createSession(input: BaseCapabilityInput): RuntimeExecutionCapabilities {
    const options = input.options;
    const originalEvent = options.onEvent;
    const originalPraxisResult = options.onPraxisResult;
    const originalEffectVerification = options.onExpectedEffectVerification;
    const atomicSecretCapture =
      options.atomicSecretCapture ??
      ((capture: Parameters<NonNullable<ExecuteOptions["atomicSecretCapture"]>>[0]) => {
        if (capture.scope !== "run")
          throw new Error("PROJECT_SECRET_PERSISTENCE_AUTHORITY_REQUIRED");
        return this.kernelRepository.persistSecret(input.sessionId, {
          ...capture,
          operationId: input.operationId,
        });
      });
    const publicValueCapture =
      options.publicValueCapture ??
      ((capture: Parameters<NonNullable<ExecuteOptions["publicValueCapture"]>>[0]) => {
        if (capture.scope !== "run")
          throw new Error("PROJECT_VALUE_PERSISTENCE_AUTHORITY_REQUIRED");
        return this.kernelRepository.persistPublicValue(input.sessionId, {
          ...capture,
          operationId: input.operationId,
        });
      });
    const calibration = input.beforeMutationTransition
      ? calibrationProtectedCapabilities(
          input.operationId,
          input.beforeMutationTransition,
          atomicSecretCapture,
          publicValueCapture,
        )
      : {};
    const compatibilityOptions: RuntimeExecutionCapabilities["options"] = {
      ...options,
      openBrowser:
        options.openBrowser ??
        ((contextOptions) =>
          this.nativeBrowser.openBrowser(contextOptions, {
            kind: "protected_capsule",
            ownerId: `${input.sessionId}:${input.operationId}`,
          })),
      executeNativeNavigation:
        options.executeNativeNavigation ??
        ((page, url, allowedOrigins, timeoutMs, trustedScriptOrigins) =>
          this.nativeBrowser.navigateAndWait(
            page,
            url,
            allowedOrigins,
            timeoutMs,
            trustedScriptOrigins,
          )),
      executeSameOriginRequest:
        options.executeSameOriginRequest ??
        ((page, request, allowedOrigins, beforeDispatch) =>
          this.nativeBrowser.sameOriginRequest(page, request, allowedOrigins, beforeDispatch)),
      atomicSecretCapture,
      publicValueCapture,
      publicValueResolver:
        options.publicValueResolver ??
        (async (reference) => {
          const value = await this.kernelRepository.resolvePublicValue(input.sessionId, reference);
          if (value === undefined) throw new Error("GENERATED_PUBLIC_VALUE_UNAVAILABLE");
          return value;
        }),
      ...(options.protectedTransactionStore
        ? { protectedTransactionStore: options.protectedTransactionStore }
        : {}),
      ...calibration,
      checkpointStore: options.checkpointStore ?? this.checkpointStore(input.sessionId),
      recordContextProvenance:
        options.recordContextProvenance ??
        ((provenance) =>
          this.kernelRepository.recordContextProvenance(input.sessionId, provenance)),
      recoverAcquisition:
        options.recoverAcquisition ??
        (async () => ({ action: "request_secure_assistance" as const })),
    };
    const derivedStates = deriveCapabilityStates(input.mode, compatibilityOptions);
    const states = Object.fromEntries(
      (Object.keys(derivedStates) as ExecutionCapabilityName[]).map((name) => [
        name,
        restrictCapabilityState(derivedStates[name], input.states?.[name]),
      ]),
    ) as Record<ExecutionCapabilityName, "available" | "policy_denied" | "unavailable">;
    const manifest = createExecutionCapabilityManifest({
      mode: input.mode,
      correlationId: input.correlationId,
      states,
    });
    return {
      manifest,
      journal: this.journal(),
      mutationFence: {
        claim: ({ mutationIdentity, requestDigest }) =>
          this.kernelRepository.claimMutation(input.sessionId, {
            operationId: mutationIdentity,
            mutationKind: "one_time",
            programDigest: requestDigest,
            inputSchemaDigest: requestDigest,
            inputDigest: requestDigest,
          }),
        transition: ({ mutationIdentity, ...transition }) =>
          this.kernelRepository.transitionMutation(input.sessionId, {
            operationId: mutationIdentity,
            ...transition,
          }),
      },
      compatibilityOptions,
      options: {
        ...compatibilityOptions,
        onEvent: async (event) => {
          await this.kernelRepository.appendEvent(
            input.sessionId,
            input.operationId,
            event.type,
            event.payload,
          );
          await originalEvent?.(event);
        },
        onPraxisResult: async (result) => {
          await this.kernelRepository.appendEvent(
            input.sessionId,
            input.operationId,
            "praxis.result",
            {
              transactionId: result.transactionId,
              operationId: result.operationId,
              groundingMs: result.timing.groundingMs,
              dispatchMs: result.timing.dispatchMs,
              effectVerificationMs: result.timing.effectVerificationMs,
              status: result.status,
              mutationOutcome: result.mutationOutcome,
            },
          );
          await originalPraxisResult?.(result);
        },
        onExpectedEffectVerification: async (result) => {
          await this.kernelRepository.appendEvent(
            input.sessionId,
            input.operationId,
            "effect.verification",
            result,
          );
          await originalEffectVerification?.(result);
        },
      },
    };
  }

  createRun(
    input: BaseCapabilityInput & {
      runId: string;
      attemptId: string;
      claimToken: string;
      flowRevisionId: string;
      environmentId: string;
      projectId: string;
      missionId: string;
      objectiveId: string;
      agentSessionId: string;
      protectedAuthorizations?: Record<string, string>;
    },
  ): RuntimeExecutionCapabilities {
    const originalMutationDispatch = input.options.onMutationDispatch;
    return this.createSession({
      ...input,
      options: {
        ...input.options,
        onMutationDispatch: async () => {
          await this.qualificationCampaigns?.consumeBusinessMutation({
            runId: input.runId,
            operationId: input.operationId,
            mutationIdentity: `run-${input.runId}`,
          });
          await originalMutationDispatch?.();
        },
        runId: input.runId,
        attemptId: input.attemptId,
        flowRevisionId: input.flowRevisionId,
        environmentId: input.environmentId,
        secretResolver: (credentialId) =>
          this.executions.resolveCredential(input.runId, credentialId),
        secretCapture: (name, value) => this.executions.captureCredential(input.runId, name, value),
        atomicSecretCapture: (capture) =>
          this.executions.persistCapturedSecret({ runId: input.runId, ...capture }),
        publicValueCapture: (capture) =>
          this.executions.persistGeneratedPublicValue({ runId: input.runId, ...capture }),
        publicValueResolver: (valueId) =>
          this.executions.resolveGeneratedPublicValue(input.runId, valueId),
        ...this.protectedOperationCapabilities({
          ownerKind: "run",
          ownerId: input.runId,
          leaseOwner: input.claimToken,
          projectId: input.projectId,
          environmentId: input.environmentId,
          missionId: input.missionId,
          objectiveId: input.objectiveId,
          agentSessionId: input.agentSessionId,
          attemptId: input.attemptId,
          correlationId: input.correlationId,
          flowRevisionId: input.flowRevisionId,
          protectedAuthorizations: input.protectedAuthorizations ?? {},
        }),
        checkpointStore: {
          establish: (checkpoint) => this.executions.establishCheckpoint(input.runId, checkpoint),
          claim: (checkpointId) => this.executions.claimCheckpoint(input.runId, checkpointId),
          complete: (checkpointId, outcome, reasonCode) =>
            this.executions.completeCheckpoint(input.runId, checkpointId, outcome, reasonCode),
        },
        recordContextProvenance: (provenance) =>
          this.executions.recordContextProvenance(input.runId, provenance),
        recoverAcquisition: async () => ({ action: "retry" as const }),
        groundingHistory: (intentDigest) =>
          this.executions.groundingHistory(input.runId, intentDigest),
        onPraxisResult: async (result) => {
          await observePraxisFailure(this.operationalEvents, input, result);
          await this.executions.recordPraxisResult(input.runId, input.attemptId, result);
        },
      },
    });
  }

  request(input: {
    sessionId: string;
    operationId: string;
    correlationId: string;
    mode: ExecutionMode;
    plan: ExecutionRequest["plan"];
    policy: ExecutionRequest["policy"];
    capabilities: RuntimeExecutionCapabilities;
    idempotencyKey?: string;
    mutationIdentity?: string;
    semanticContext?: string;
  }): ExecutionRequest {
    return {
      sessionId: input.sessionId,
      operationId: input.operationId,
      correlationId: input.correlationId,
      mode: input.mode,
      plan: input.plan,
      policy: input.policy,
      capabilityManifestDigest: input.capabilities.manifest.digest,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.mutationIdentity ? { mutationIdentity: input.mutationIdentity } : {}),
      ...(input.semanticContext ? { semanticContext: input.semanticContext } : {}),
    };
  }

  private journal() {
    return {
      begin: ({ request, startedAt }: { request: ExecutionRequest; startedAt: string }) =>
        this.kernelRepository.begin({ request, startedAt }),
      complete: (input: {
        request: ExecutionRequest;
        outcome: import("@scry/contracts").OperationOutcome;
        completedAt: string;
      }) => this.kernelRepository.complete(input),
      fail: (input: {
        request: ExecutionRequest;
        reasonCode: string;
        outcome: import("@scry/contracts").OperationOutcome;
        completedAt: string;
      }) => this.kernelRepository.fail(input),
      settle: (input: Parameters<ExecutionKernelRepository["settle"]>[0]) =>
        this.kernelRepository.settle(input),
    };
  }

  createMissionAuthoringSession(
    input: BaseCapabilityInput & {
      projectId: string;
      environmentId: string;
      missionId: string;
      objectiveId: string;
      agentSessionId: string;
      flowDraftId: string;
      authorizationId: string;
      leaseOwner: string;
    },
  ) {
    return this.createSession({
      ...input,
      options: {
        ...input.options,
        ...this.protectedOperationCapabilities({
          ownerKind: "authoring_session",
          ownerId: input.sessionId,
          leaseOwner: input.leaseOwner,
          projectId: input.projectId,
          environmentId: input.environmentId,
          missionId: input.missionId,
          objectiveId: input.objectiveId,
          agentSessionId: input.agentSessionId,
          correlationId: input.correlationId,
          flowDraftId: input.flowDraftId,
          authorizationId: input.authorizationId,
        }),
      },
    });
  }

  private protectedOperationCapabilities(context: {
    ownerKind: "authoring_session" | "run";
    ownerId: string;
    leaseOwner: string;
    projectId: string;
    environmentId: string;
    missionId: string;
    objectiveId: string;
    agentSessionId: string;
    attemptId?: string;
    correlationId?: string;
    flowDraftId?: string;
    flowRevisionId?: string;
    authorizationId?: string;
    protectedAuthorizations?: Record<string, string>;
  }): Pick<
    ExecuteOptions,
    | "protectedTransactionExecutor"
    | "protectedTransactionStore"
    | "atomicOutputCapture"
    | "stageProtectedResponseOutputs"
    | "recoverStagedProtectedResponseOutputs"
    | "markCredentialCompromised"
  > {
    let current: import("@scry/contracts").ProtectedOperationClaim | undefined;
    let phaseStartedAt = performance.now();
    if (!this.protectedOperations || !this.protectedOutputs)
      throw new Error("PROTECTED_OPERATION_AUTHORITY_UNAVAILABLE");
    const operations = this.protectedOperations;
    const outputs = this.protectedOutputs;
    const leaseDurationMs = 30_000;
    return {
      protectedTransactionExecutor: async ({ transaction, dependencies }) => {
        current = undefined;
        const execution = await new ProtectedTransactionKernel(dependencies).execute(transaction);
        await observeProtectedOperationResult(
          this.operationalEvents,
          context,
          transaction.operationId,
          execution.result,
          (current as import("@scry/contracts").ProtectedOperationClaim | undefined)?.id,
        );
        return execution;
      },
      protectedTransactionStore: {
        claim: async (claim) => {
          const runAuthorizationId = context.protectedAuthorizations?.[claim.operationId];
          if (context.ownerKind === "run") {
            if (!runAuthorizationId) throw new Error("PROTECTED_OPERATION_AUTHORIZATION_REQUIRED");
            try {
              await operations.create({
                ownerKind: "run",
                ownerId: context.ownerId,
                flowRevisionId: context.flowRevisionId!,
                authorizationId: runAuthorizationId,
                operationId: claim.operationId,
                mutationIdentity: claim.mutationIdentity,
                dispatchSemantics: claim.dispatchSemantics ?? "mutation",
                projectId: context.projectId,
                environmentId: context.environmentId,
                missionId: context.missionId,
                objectiveId: context.objectiveId,
                agentSessionId: context.agentSessionId,
                programDigest: claim.programDigest,
                safeOutputManifest: claim.safeOutputManifest,
              });
            } catch (error) {
              if (
                !(error instanceof Error) ||
                !error.message.includes("PROTECTED_OPERATION_ALREADY_EXISTS")
              )
                throw error;
            }
          }
          current = await operations.claim({
            ownerKind: context.ownerKind,
            ownerId: context.ownerId,
            operationId: claim.operationId,
            leaseOwner: context.leaseOwner,
            leaseDurationMs,
            binding: {
              mutationIdentity: claim.mutationIdentity,
              projectId: context.projectId,
              dispatchSemantics: claim.dispatchSemantics ?? "mutation",
              environmentId: context.environmentId,
              missionId: context.missionId,
              objectiveId: context.objectiveId,
              agentSessionId: context.agentSessionId,
              programDigest: claim.programDigest,
              safeOutputManifest: claim.safeOutputManifest,
              ...(context.ownerKind === "authoring_session"
                ? { flowDraftId: context.flowDraftId!, authorizationId: context.authorizationId! }
                : {
                    flowRevisionId: context.flowRevisionId!,
                    authorizationId: runAuthorizationId!,
                  }),
            },
          });
          return current!;
        },
        transition: async (transition) => {
          current = await operations.transition({
            ...transition,
            leaseOwner: context.leaseOwner,
            ...(transition.facts
              ? { safeDiagnostics: projectProtectedDiagnostics(transition.facts) }
              : {}),
          });
          return current!;
        },
        record: async (record) => {
          if (!current) throw new Error("PROTECTED_OPERATION_NOT_CLAIMED");
          const now = performance.now();
          await operations.record({
            id: current.id,
            leaseOwner: context.leaseOwner,
            fencingToken: record.fencingToken,
            phase: record.phase,
            ...(record.facts ? { safeDiagnostics: projectProtectedDiagnostics(record.facts) } : {}),
            durationMs: now - phaseStartedAt,
          });
          phaseStartedAt = now;
        },
        settleMutationOutcome: async (settlement) => {
          current = await operations.settleMutationOutcome({
            id: settlement.id,
            leaseOwner: context.leaseOwner,
            fencingToken: settlement.fencingToken,
            version: settlement.version,
            outcome: settlement.outcome,
          });
          return current;
        },
        heartbeat: async (claim) => {
          await operations.heartbeat({
            id: claim.id,
            leaseOwner: context.leaseOwner,
            fencingToken: claim.fencingToken,
            leaseDurationMs,
          });
        },
        heartbeatIntervalMs: Math.max(250, Math.floor(leaseDurationMs / 3)),
      },
      atomicOutputCapture: async ({
        operationId,
        claim,
        outputs: capturedOutputs,
        externalResourceBindings,
      }) =>
        outputs.persistOutputsAtomically(
          {
            protectedOperationId: claim.id,
            projectId: context.projectId,
            environmentId: context.environmentId,
            missionId: context.missionId,
            objectiveId: context.objectiveId,
            agentSessionId: context.agentSessionId,
            ownerKind: context.ownerKind,
            ownerId: context.ownerId,
            operationId,
            leaseOwner: context.leaseOwner,
            fencingToken: claim.fencingToken,
            version: claim.version,
          },
          capturedOutputs.map((output) => ({ ...output, storageName: output.name })),
          externalResourceBindings,
        ),
      stageProtectedResponseOutputs: async ({ operationId, claim, outputs: capturedOutputs }) =>
        outputs.stageResponseOutputs(
          {
            protectedOperationId: claim.id,
            projectId: context.projectId,
            environmentId: context.environmentId,
            missionId: context.missionId,
            objectiveId: context.objectiveId,
            agentSessionId: context.agentSessionId,
            ownerKind: context.ownerKind,
            ownerId: context.ownerId,
            operationId,
            leaseOwner: context.leaseOwner,
            fencingToken: claim.fencingToken,
            version: claim.version,
          },
          capturedOutputs.map((output) => ({ ...output, storageName: output.name })),
        ),
      recoverStagedProtectedResponseOutputs: async ({ operationId, claim }) => {
        const recovered = await outputs.recoverStagedResponseOutputs({
          protectedOperationId: claim.id,
          projectId: context.projectId,
          environmentId: context.environmentId,
          missionId: context.missionId,
          objectiveId: context.objectiveId,
          agentSessionId: context.agentSessionId,
          ownerKind: context.ownerKind,
          ownerId: context.ownerId,
          operationId,
          leaseOwner: context.leaseOwner,
          fencingToken: claim.fencingToken,
          version: claim.version,
        });
        return recovered?.map((output) => ({ ...output, name: output.storageName }));
      },
      markCredentialCompromised: (credentialId, code, operationId) =>
        outputs.markCommittedCredentialsCompromised({
          protectedOperationId: current?.id ?? "",
          credentialIds: [credentialId],
          operationId,
          reasonCode: code,
          ownerKind: context.ownerKind,
          ownerId: context.ownerId,
        }),
    };
  }

  private checkpointStore(sessionId: string) {
    return {
      establish: (input: Parameters<ExecutionKernelRepository["establishCheckpoint"]>[1]) =>
        this.kernelRepository.establishCheckpoint(sessionId, input),
      claim: (checkpointId: string) =>
        this.kernelRepository.claimCheckpoint(sessionId, checkpointId),
      complete: (
        checkpointId: string,
        outcome: "verified" | "failed" | "destroyed",
        reasonCode?: string,
      ) => this.kernelRepository.completeCheckpoint(sessionId, checkpointId, outcome, reasonCode),
    };
  }
}

function projectProtectedDiagnostics(facts: Record<string, unknown>) {
  const allowed = new Set([
    "reasonCode",
    "failurePhase",
    "retryClass",
    "bootstrap",
    "preparation",
    "mutation",
    "protectedExtraction",
    "publicExtraction",
    "protectedPersistence",
    "publicPersistence",
    "capsule",
    "reconciliation",
    "continuation",
    "evidence",
    "credentialSecurity",
    "recoveryExpiresAt",
    "acquisitionContractDigest",
    "preparationEffects",
    "requestContract",
    "reconciliationStrategy",
    "responseEvidence",
    "protectedAcquisitionEvidence",
  ]);
  return Object.fromEntries(Object.entries(facts).filter(([key]) => allowed.has(key)));
}

function calibrationProtectedCapabilities(
  operationId: string,
  beforeTransition: (input: { expected: string; next: string }) => Promise<boolean>,
  persistSecret: NonNullable<ExecuteOptions["atomicSecretCapture"]>,
  persistPublic: NonNullable<ExecuteOptions["publicValueCapture"]>,
): Pick<
  ExecuteOptions,
  "protectedTransactionExecutor" | "protectedTransactionStore" | "atomicOutputCapture"
> {
  let state: import("@scry/contracts").ProtectedOperationState = "planned";
  let version = 1;
  let mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown" = "not_attempted";
  const transition = async (
    expected: import("@scry/contracts").ProtectedOperationState,
    next: import("@scry/contracts").ProtectedOperationState,
  ) => {
    if (state !== expected || !(await beforeTransition({ expected, next })))
      throw new Error("PROTECTED_OPERATION_TRANSITION_FENCED");
    state = next;
    version += 1;
    return { id: operationId, state, version, fencingToken: 1, mutationOutcome };
  };
  return {
    protectedTransactionExecutor: ({ transaction, dependencies }) =>
      new ProtectedTransactionKernel(dependencies).execute(transaction),
    protectedTransactionStore: {
      claim: async () => ({ id: operationId, state, version, fencingToken: 1, mutationOutcome }),
      transition: async ({ expected, next }) => transition(expected, next),
      record: async () => undefined,
      settleMutationOutcome: async ({ outcome }) => {
        if (
          (mutationOutcome === "applied" || mutationOutcome === "not_applied") &&
          mutationOutcome !== outcome
        ) {
          throw new Error("PROTECTED_MUTATION_OUTCOME_SETTLEMENT_CONTRADICTION");
        }
        mutationOutcome = outcome;
        version += 1;
        return { id: operationId, state, version, fencingToken: 1, mutationOutcome };
      },
    },
    atomicOutputCapture: async ({ outputs }) => {
      const references: Record<
        string,
        {
          classification: "public" | "protected";
          credentialId?: string;
          valueId?: string;
          scope: "run" | "project";
        }
      > = {};
      try {
        for (const output of outputs) {
          references[output.reference] =
            output.classification === "protected"
              ? {
                  classification: "protected",
                  ...(await persistSecret({
                    operationId,
                    reference: output.reference,
                    name: output.name,
                    value: output.value,
                    scope: output.scope,
                  })),
                  scope: output.scope,
                }
              : {
                  classification: "public",
                  ...(await persistPublic({
                    operationId,
                    reference: output.reference,
                    name: output.name,
                    value: output.value,
                    scope: output.scope,
                  })),
                  scope: output.scope,
                };
        }
        return { claim: await transition("persisting", "persisted"), references };
      } finally {
        for (const output of outputs) output.value = "";
      }
    },
  };
}

function deriveCapabilityStates(
  mode: ExecutionMode,
  options: BaseCapabilityInput["options"],
): Record<ExecutionCapabilityName, "available" | "unavailable"> {
  const browser = Boolean(options.browserChannel && options.outputDirectory);
  const veil = Boolean(
    options.environmentId && options.veilAdmissionKey && options.veilPolicySnapshot,
  );
  const evidence = Boolean(browser && veil && options.outputDirectory);
  const protectedInput = Boolean(browser && veil && options.secretResolver);
  const protectedOperations = Boolean(
    options.protectedTransactionExecutor &&
    options.secretResolver &&
    options.atomicSecretCapture &&
    options.publicValueCapture &&
    options.atomicOutputCapture &&
    options.publicValueResolver &&
    options.protectedTransactionStore &&
    options.checkpointStore &&
    options.recordContextProvenance &&
    options.recoverAcquisition,
  );
  return {
    browser: browser ? "available" : "unavailable",
    praxis: "available",
    veil: veil ? "available" : "unavailable",
    evidence: evidence ? "available" : "unavailable",
    journal: "available",
    protected_input: protectedInput ? "available" : "unavailable",
    protected_operations: protectedOperations ? "available" : "unavailable",
    checkpoint: options.checkpointStore ? "available" : "unavailable",
    calibration: mode === "certify" && options.calibrationRehearsal ? "available" : "unavailable",
  };
}

function restrictCapabilityState(
  derived: "available" | "unavailable",
  requested?: "available" | "policy_denied" | "unavailable",
) {
  if (derived === "unavailable") return "unavailable" as const;
  return requested ?? derived;
}

function praxisFailureClassification(
  result: Exclude<import("@scry/contracts").PraxisResult, { status: "succeeded" }>,
) {
  if (/STALE|CHANGED|DOCUMENT|REFERENCE/.test(result.code)) return "stale_authority" as const;
  if (result.provenance === "policy") return "policy_refusal" as const;
  if (result.provenance === "infrastructure") return "infrastructure" as const;
  return "application_provider" as const;
}

export async function observePraxisFailure(
  events: OperationalEvents | undefined,
  context: {
    projectId: string;
    missionId: string;
    objectiveId: string;
    agentSessionId: string;
    runId: string;
    attemptId: string;
    correlationId: string;
  },
  result: import("@scry/contracts").PraxisResult,
) {
  if (result.status === "succeeded") return;
  await events?.emit("praxis", {
    name: "praxis.action_failed",
    classification: praxisFailureClassification(result),
    reasonCode: result.code,
    outcome: result.status === "inconclusive" ? "inconclusive" : "failed",
    causality: {
      projectId: context.projectId,
      missionId: context.missionId,
      objectiveId: context.objectiveId,
      agentSessionId: context.agentSessionId,
      runId: context.runId,
      attemptId: context.attemptId,
      operationId: result.operationId,
      correlationId: context.correlationId,
    },
    durationMs: result.timing.totalMs,
    details: {
      status: result.status,
      phase: result.phase,
      provenance: result.provenance,
      mutationOutcome: result.mutationOutcome,
      retry: result.retry,
    },
  });
}

export async function observeProtectedOperationResult(
  events: OperationalEvents | undefined,
  context: {
    ownerKind: "authoring_session" | "run";
    ownerId: string;
    projectId: string;
    missionId: string;
    objectiveId: string;
    agentSessionId: string;
    attemptId?: string;
    correlationId?: string;
  },
  operationId: string,
  result: import("@scry/contracts").ProtectedTransactionResult,
  protectedOperationId?: string,
) {
  if (result.status !== "outcome_unknown" && result.mutation.outcome !== "unknown") return;
  await events?.emit("runtime", {
    name: "protected_operation.reconciliation_required",
    classification: "reconciliation_unknown",
    reasonCode: result.reasonCode ?? "MUTATION_RECONCILIATION_REQUIRED",
    outcome: "reconciliation_required",
    causality: {
      projectId: context.projectId,
      missionId: context.missionId,
      objectiveId: context.objectiveId,
      agentSessionId: context.agentSessionId,
      ...(context.ownerKind === "run" ? { runId: context.ownerId } : {}),
      ...(context.attemptId ? { attemptId: context.attemptId } : {}),
      ...(context.ownerKind === "authoring_session" ? { praxisSessionId: context.ownerId } : {}),
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      operationId,
      ...(protectedOperationId ? { protectedOperationId } : {}),
    },
    details: {
      mutationDispatch: result.mutation.dispatch,
      mutationOutcome: result.mutation.outcome,
      reconciliation: result.reconciliation,
      failurePhase: result.failurePhase,
      retryClass: result.retryClass,
      safeActions: result.safeActions,
    },
  });
}

@Injectable()
export class ExecutionKernelService extends ExecutionKernel {
  openAuthoringSession(input: {
    request: ExecutionRequest;
    capabilities: RuntimeExecutionCapabilities;
    session: Parameters<typeof createAuthoringBrowserSession<ExecutionReport>>[0];
  }) {
    this.admitOnly({ request: input.request, capabilities: input.capabilities });
    return createAuthoringBrowserSession<ExecutionReport>(input.session);
  }
}
