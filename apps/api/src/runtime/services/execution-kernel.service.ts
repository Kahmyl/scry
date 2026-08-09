import { Inject, Injectable } from "@nestjs/common";
import type { ExecutionCapabilityName, ExecutionMode, ExecutionRequest } from "@scry/contracts";
import {
  createExecutionCapabilityManifest,
  ExecutionKernel,
  createAuthoringBrowserSession,
  type ExecuteOptions,
  type RuntimeExecutionCapabilities,
} from "@scry/executor";

import { ExecutionRepository } from "../repositories/execution.repository.js";
import { ExecutionKernelRepository } from "../repositories/execution-kernel.repository.js";
import { NativeBrowserDriver } from "../native-browser-driver/index.js";

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
  ) {}

  createSession(input: BaseCapabilityInput): RuntimeExecutionCapabilities {
    const options = input.options;
    const originalEvent = options.onEvent;
    const originalPraxisResult = options.onPraxisResult;
    const originalNativeResolution = options.onNativeResolution;
    const originalEffectVerification = options.onExpectedEffectVerification;
    const compatibilityOptions: RuntimeExecutionCapabilities["options"] = {
      ...options,
      openBrowser: options.openBrowser ?? ((contextOptions) => this.nativeBrowser.openBrowser(contextOptions)),
      executeNativeControl:
        options.executeNativeControl ??
        ((page, target, operation, beforeDispatch) =>
          this.nativeBrowser.executeSemanticControl(page, target, operation, beforeDispatch)),
      executeNativeNavigation:
        options.executeNativeNavigation ??
        ((page, url, allowedOrigins, timeoutMs, trustedScriptOrigins) =>
          this.nativeBrowser.navigateAndWait(
            page, url, allowedOrigins, timeoutMs, trustedScriptOrigins,
          )),
      executeSameOriginRequest:
        options.executeSameOriginRequest ??
        ((page, request, allowedOrigins, beforeDispatch) =>
          this.nativeBrowser.sameOriginRequest(page, request, allowedOrigins, beforeDispatch)),
      verifyNativeExpectedEffect:
        options.verifyNativeExpectedEffect ??
        ((page, effect, beforeUrl, timeoutMs) =>
          this.nativeBrowser.verifyExpectedEffect(page, effect, beforeUrl, timeoutMs)),
      atomicSecretCapture:
        options.atomicSecretCapture ??
        ((capture) => {
          if (capture.scope !== "run") {
            throw new Error("PROJECT_SECRET_PERSISTENCE_AUTHORITY_REQUIRED");
          }
          return this.kernelRepository.persistSecret(input.sessionId, {
            ...capture,
            operationId: input.operationId,
          });
        }),
      publicValueCapture:
        options.publicValueCapture ??
        ((capture) => {
          if (capture.scope !== "run") {
            throw new Error("PROJECT_VALUE_PERSISTENCE_AUTHORITY_REQUIRED");
          }
          return this.kernelRepository.persistPublicValue(input.sessionId, {
            ...capture,
            operationId: input.operationId,
          });
        }),
      publicValueResolver:
        options.publicValueResolver ??
        (async (reference) => {
          const value = await this.kernelRepository.resolvePublicValue(input.sessionId, reference);
          if (value === undefined) throw new Error("GENERATED_PUBLIC_VALUE_UNAVAILABLE");
          return value;
        }),
      protectedTransactionStore:
        options.protectedTransactionStore ??
        this.protectedStore(input.sessionId, input.operationId, input.beforeMutationTransition),
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
        onNativeResolution: async (result) => {
          await this.kernelRepository.appendEvent(
            input.sessionId,
            input.operationId,
            "native.resolution",
            result,
          );
          await originalNativeResolution?.(result);
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
    },
  ): RuntimeExecutionCapabilities {
    return this.createSession({
      ...input,
      options: {
        ...input.options,
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
        protectedTransactionStore: {
          claim: (claim) =>
            this.executions.claimProtectedTransaction(
              input.runId,
              input.claimToken,
              claim,
            ) as never,
          transition: (transition) =>
            this.executions.transitionProtectedMutation(input.runId, input.claimToken, transition),
          record: (record) =>
            this.executions.recordProtectedTransaction(input.runId, input.claimToken, record),
        },
        checkpointStore: {
          establish: (checkpoint) => this.executions.establishCheckpoint(input.runId, checkpoint),
          claim: (checkpointId) => this.executions.claimCheckpoint(input.runId, checkpointId),
          complete: (checkpointId, outcome, reasonCode) =>
            this.executions.completeCheckpoint(input.runId, checkpointId, outcome, reasonCode),
        },
        calibrationVerifier: (calibration) =>
          this.executions.verifyCalibrationAttestation(
            input.runId,
            calibration.attestationId,
            calibration.operationId,
            calibration.operationDigest,
            calibration.structureFingerprint,
          ),
        markCredentialCompromised: async (credentialId, code, operationId) => {
          await this.executions.markCapturedCredentialCompromised(
            input.runId,
            credentialId,
            code,
            operationId,
          );
        },
        recordContextProvenance: (provenance) =>
          this.executions.recordContextProvenance(input.runId, provenance),
        recoverAcquisition: async (recovery) =>
          ((await this.executions.protectedRecoveryDecision(input.runId, recovery.operationId)) as
            | {
                action: "retry" | "request_secure_assistance" | "revoke" | "abandon" | "expired";
                correctedScope?: import("@scry/contracts").SemanticScope;
              }
            | undefined) ?? { action: "retry" },
        groundingHistory: (intentDigest) =>
          this.executions.groundingHistory(input.runId, intentDigest),
        onPraxisResult: (result) =>
          this.executions.recordPraxisResult(input.runId, input.attemptId, result),
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

  private protectedStore(
    sessionId: string,
    parentOperationId: string,
    beforeTransition?: (input: { expected: string; next: string }) => Promise<boolean>,
  ) {
    return {
      claim: (input: Parameters<ExecutionKernelRepository["claimMutation"]>[1]) =>
        this.kernelRepository.claimMutation(sessionId, input) as never,
      transition: async (input: Parameters<ExecutionKernelRepository["transitionMutation"]>[1]) => {
        if (beforeTransition && !(await beforeTransition(input))) return false;
        return this.kernelRepository.transitionMutation(sessionId, input);
      },
      record: (input: Parameters<ExecutionKernelRepository["recordMutation"]>[2]) =>
        this.kernelRepository.recordMutation(sessionId, parentOperationId, input),
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

function deriveCapabilityStates(
  mode: ExecutionMode,
  options: BaseCapabilityInput["options"],
): Record<ExecutionCapabilityName, "available" | "unavailable"> {
  const browser = Boolean(options.browserChannel && options.outputDirectory);
  const veil = Boolean(
    options.environmentId && options.veilAdmissionKey && options.veilPolicySnapshot,
  );
  const evidence = Boolean(browser && veil && options.outputDirectory);
  const protectedOperations = Boolean(
    options.secretResolver &&
      options.atomicSecretCapture &&
      options.publicValueCapture &&
      options.publicValueResolver &&
      options.protectedTransactionStore &&
      options.checkpointStore &&
      options.recordContextProvenance &&
      options.recoverAcquisition,
  );
  const calibration = Boolean(
    options.calibrationVerifier || (mode === "certify" && options.calibrationRehearsal),
  );
  return {
    browser: browser ? "available" : "unavailable",
    praxis: "available",
    veil: veil ? "available" : "unavailable",
    evidence: evidence ? "available" : "unavailable",
    journal: "available",
    protected_operations: protectedOperations ? "available" : "unavailable",
    checkpoint: options.checkpointStore ? "available" : "unavailable",
    calibration: calibration ? "available" : "unavailable",
  };
}

function restrictCapabilityState(
  derived: "available" | "unavailable",
  requested?: "available" | "policy_denied" | "unavailable",
) {
  if (derived === "unavailable") return "unavailable" as const;
  return requested ?? derived;
}

@Injectable()
export class ExecutionKernelService extends ExecutionKernel {
  openAuthoringSession(input: {
    request: ExecutionRequest;
    capabilities: RuntimeExecutionCapabilities;
    session: Parameters<typeof createAuthoringBrowserSession>[0];
  }) {
    this.admitOnly({ request: input.request, capabilities: input.capabilities });
    return createAuthoringBrowserSession(input.session);
  }

}
