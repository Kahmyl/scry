import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import type {
  AdaptiveSessionOperationInput,
  AdvanceAdaptiveSessionInput,
  MissionAuthoringAdvanceInput,
  MissionAuthoringIntent,
  MissionAuthoringTurnResult,
  StartAdaptiveSessionInput,
  RecoverTrustedOriginsInput,
  ReconcileAdaptiveOperationInput,
  CurrentAction,
  PrepareFlowAuthoringInput,
  ReservePreparedProtectedOperationInput,
  ResumePreparedProtectedOperationInput,
  DispatchPreparedProtectedOperationInput,
  PraxisObservation,
} from "@scry/contracts";
import { createHash, randomUUID } from "node:crypto";

import type { Principal } from "../auth/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";
import { AdaptiveSessionKernelRunner } from "./adaptive-session-kernel.runner.js";
import { AdaptiveSessionRepository } from "./repositories/adaptive-session.repository.js";
import { OperationBoundProtectedInputRepository } from "./repositories/operation-bound-protected-input.repository.js";
import { AdaptiveOperationReconciliationRegistry } from "./adaptive-operation-reconciliation.registry.js";
import { PreparedProtectedOperationRepository } from "./repositories/prepared-protected-operation.repository.js";
import { compilePreparedProtectedOperation } from "./prepared-protected-operation.compiler.js";
import {
  OperationContractProviderRegistry,
  OperationContractRegistry,
} from "./operation-contract.registry.js";
import { deriveMissionAuthoringOperation } from "./mission-authoring-derivation.js";

export type MissionRunEvidenceContext = {
  veilPolicySnapshot: import("@scry/contracts").VeilPolicySnapshot;
  outputDirectoryFor(operation: AdaptiveSessionOperationInput): string;
  commit(input: {
    operation: AdaptiveSessionOperationInput;
    report: import("@scry/executor").ExecutionReport;
    outputDirectory: string;
  }): Promise<void>;
  beforeBusinessMutationDispatch(operation: AdaptiveSessionOperationInput): Promise<void>;
  preparedOperationAdmitted?(
    operation: AdaptiveSessionOperationInput,
    preparedExecutionCapabilityId: string,
  ): Promise<void>;
};

type PreparedExecutionProjection = Awaited<
  ReturnType<AdaptiveSessionRepository["projectProtectedOperationForAuthoring"]>
>;

@Injectable()
export class MissionFlowAuthoringService {
  private readonly inFlightTurns = new Map<string, Promise<MissionAuthoringTurnResult>>();
  private readonly inFlightProtectedOperations = new Map<string, Promise<void>>();
  private readonly inFlightPreparedExecutions = new Map<
    string,
    Promise<PreparedExecutionProjection>
  >();

  constructor(
    @Inject(AdaptiveSessionRepository) private readonly sessions: AdaptiveSessionRepository,
    @Inject(AdaptiveSessionKernelRunner) private readonly runner: AdaptiveSessionKernelRunner,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
    @Optional()
    @Inject(OperationBoundProtectedInputRepository)
    private readonly syntheticInputs?: OperationBoundProtectedInputRepository,
    @Optional()
    @Inject(AdaptiveOperationReconciliationRegistry)
    private readonly reconciliationRegistry?: AdaptiveOperationReconciliationRegistry,
    @Optional()
    @Inject(PreparedProtectedOperationRepository)
    private readonly preparedOperations?: PreparedProtectedOperationRepository,
    @Optional()
    @Inject(OperationContractProviderRegistry)
    private readonly operationContractProviders?: OperationContractProviderRegistry,
    @Optional()
    @Inject(OperationContractRegistry)
    private readonly operationContracts?: OperationContractRegistry,
  ) {}

  async start(principal: Principal, input: StartAdaptiveSessionInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    const result = await this.sessions.create(workspaceId(principal), input);
    const created = await this.sessions.get(workspaceId(principal), result.id);
    if (created.state === "provisioning") {
      try {
        await this.runner.initialize(result.id);
        await this.sessions.activateProvisionedSession(result.id);
      } catch (error) {
        await this.runner.close(result.id).catch(() => undefined);
        const concurrent = await this.sessions.get(workspaceId(principal), result.id);
        if (concurrent.state === "active") return { ...concurrent, replayed: true };
        if (result.replayed && concurrent.state === "provisioning") {
          throw new ConflictException({
            code: "AUTHORING_PROVISIONING_IN_PROGRESS",
            mutationOutcome: "not_applied",
            sessionId: result.id,
            safeActions: ["get_flow_authoring"],
          });
        }
        await this.sessions.failProvisionedSession(
          result.id,
          error instanceof Error && error.message.startsWith("SUCCESSOR_CHECKPOINT_")
            ? error.message
            : "AUTHORING_PROVISIONING_FAILED",
        );
        throw authoringProvisioningFailure(input, result.id, error);
      }
    }
    if (created.state === "failed") {
      throw authoringProvisioningFailure(input, result.id);
    }
    return {
      ...(await this.sessions.get(workspaceId(principal), result.id)),
      replayed: result.replayed,
    };
  }

  async prepare(principal: Principal, input: PrepareFlowAuthoringInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    const prepared = await this.sessions.prepare(workspaceId(principal), input);
    const session = await this.sessions.get(workspaceId(principal), prepared.authoringSessionId);
    if (session.state === "provisioning") {
      try {
        await this.runner.initialize(prepared.authoringSessionId);
        await this.sessions.activateProvisionedSession(prepared.authoringSessionId);
      } catch (error) {
        await this.runner.close(prepared.authoringSessionId).catch(() => undefined);
        const concurrent = await this.sessions.get(
          workspaceId(principal),
          prepared.authoringSessionId,
        );
        if (concurrent.state === "active") return { ...prepared, reused: true };
        if (prepared.reused && concurrent.state === "provisioning") {
          throw new ConflictException({
            code: "AUTHORING_PROVISIONING_IN_PROGRESS",
            mutationOutcome: "not_applied",
            sessionId: prepared.authoringSessionId,
            safeActions: ["get_flow_authoring"],
          });
        }
        await this.sessions.failProvisionedSession(
          prepared.authoringSessionId,
          error instanceof Error && error.message.startsWith("SUCCESSOR_CHECKPOINT_")
            ? error.message
            : "AUTHORING_PROVISIONING_FAILED",
        );
        throw authoringPreparationFailure(prepared, error);
      }
    }
    const current = await this.sessions.get(workspaceId(principal), prepared.authoringSessionId);
    if (current.state !== "active") throw authoringPreparationFailure(prepared);
    return prepared;
  }

  async recoverTrustedOrigins(principal: Principal, input: RecoverTrustedOriginsInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.sessions.recoverTrustedOrigins(workspaceId(principal), input);
  }

  async get(principal: Principal, sessionId: string) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    return {
      ...session,
      operations: await Promise.all(
        session.operations.map(async (operation: any) => {
          if (!operation.reconciliation) return operation;
          const authority = await this.sessions.getUnknownReconciliationAuthority(
            workspaceId(principal),
            sessionId,
            operation.operationId,
          );
          const available =
            this.runner.reconciliationAvailable(sessionId, operation.expectedEffect) ||
            Boolean(authority && this.reconciliationRegistry?.available(authority));
          return {
            ...operation,
            reconciliation: {
              ...operation.reconciliation,
              available,
              safeAction: available ? "reconcile_unknown_operation" : null,
            },
          };
        }),
      ),
    };
  }

  async observe(principal: Principal, sessionId: string) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    if (session.state !== "active" && session.state !== "suspended")
      throw new ConflictException({ code: "PRAXIS_SESSION_NOT_LIVE" });
    return this.runner.observe(sessionId);
  }

  async observeOperationContracts(principal: Principal, sessionId: string) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    if (!this.operationContracts)
      throw new ConflictException({ code: "OPERATION_CONTRACT_REGISTRY_UNAVAILABLE" });
    if (
      (session.state !== "active" && session.state !== "suspended") ||
      session.runtime.state !== "owned"
    )
      return { contracts: await this.operationContracts.readDurable(sessionId) };
    const current = await this.runner.observe(sessionId);
    const contracts = await this.currentOperationContracts(sessionId, current);
    return {
      contracts: contracts.map(({ interaction, ...entry }) => ({
        ...entry,
        ...(interaction
          ? {
              interaction: (({ runtimeOwnerId: _owner, fencingEpoch: _fence, ...safe }) => safe)(
                interaction,
              ),
            }
          : {}),
      })),
    };
  }

  async runtimeOwnership(principal: Principal, sessionId: string) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    return { sessionState: session.state, runtime: session.runtime };
  }

  async listMissionValues(principal: Principal, sessionId: string) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    if (!this.preparedOperations)
      throw new ConflictException({ code: "PREPARED_OPERATION_RUNTIME_UNAVAILABLE" });
    const { missionValueAssetsResultSchema } = await import("@scry/contracts");
    return missionValueAssetsResultSchema.parse(
      await this.preparedOperations.listMissionValues({
        projectId: session.projectId,
        environmentId: session.environmentId,
        missionId: session.missionId,
      }),
    );
  }

  async reservePreparedOperation(
    principal: Principal,
    sessionId: string,
    input: ReservePreparedProtectedOperationInput,
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    await this.sessions.get(workspaceId(principal), sessionId);
    if (!this.preparedOperations)
      throw new ConflictException({ code: "PREPARED_OPERATION_RUNTIME_UNAVAILABLE" });
    const current = await this.runner.observe(sessionId);
    const contracts = await this.currentOperationContracts(sessionId, current);
    if (
      !contracts.some(
        (contract) =>
          contract.revision.id === input.operationContractRevisionId &&
          contract.revision.digest === input.operationContractRevisionDigest &&
          contract.interaction?.id === input.runtimeInteractionCapabilityId &&
          contract.executableInteractionAvailable,
      )
    )
      throw new ConflictException({ code: "PREPARED_OPERATION_OBSERVATION_STALE" });
    return this.preparedOperations.reserve(sessionId, input);
  }

  async abandonPreparedReservations(principal: Principal, sessionId: string) {
    this.requireWrite(principal);
    await this.sessions.get(workspaceId(principal), sessionId);
    if (!this.preparedOperations)
      throw new ConflictException({ code: "PREPARED_OPERATION_RUNTIME_UNAVAILABLE" });
    return this.preparedOperations.abandonReservedForSession(sessionId);
  }

  async resumePreparedOperation(
    principal: Principal,
    sessionId: string,
    input: ResumePreparedProtectedOperationInput,
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    await this.sessions.get(workspaceId(principal), sessionId);
    if (!this.preparedOperations)
      throw new ConflictException({ code: "PREPARED_OPERATION_RUNTIME_UNAVAILABLE" });
    const current = await this.runner.observe(sessionId);
    const prepared = await this.preparedOperations.assertResumable(sessionId, input);
    if (current.documentEpoch !== prepared.documentEpoch)
      throw new ConflictException({ code: "PREPARED_OPERATION_DOCUMENT_REPLACED" });
    return {
      ...prepared,
      resumeAllowed: true as const,
      immutableReservation: true as const,
    };
  }

  async dispatchPreparedOperation(
    principal: Principal,
    sessionId: string,
    input: DispatchPreparedProtectedOperationInput,
    runEvidence?: MissionRunEvidenceContext,
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    await this.sessions.get(workspaceId(principal), sessionId);
    if (!this.preparedOperations)
      throw new ConflictException({ code: "PREPARED_OPERATION_RUNTIME_UNAVAILABLE" });
    const current = await this.runner.observe(sessionId);
    const material = await this.preparedOperations.executionMaterial(sessionId, input);
    if (current.documentEpoch !== material.documentEpoch)
      throw new ConflictException({ code: "PREPARED_OPERATION_DOCUMENT_REPLACED" });
    if (new URL(current.url).origin !== new URL(material.origin).origin)
      throw new ConflictException({ code: "PREPARED_OPERATION_ORIGIN_REPLACED" });
    const executionTimeoutMs = preparedExecutionTimeoutMs();
    const compiled = compilePreparedProtectedOperation({
      material,
      entryUrl: current.url,
      timeoutMs: Math.min(executionTimeoutMs, 60_000),
    });
    const protectedReservation = await this.preparedOperations.finalizeExecutionCapability(
      input.preparedExecutionCapabilityId,
      compiled.transaction,
    );
    const operation: AdaptiveSessionOperationInput = {
      operationId: material.publicOperationId,
      idempotencyKey: `prepared:${material.protectedOperationId}`,
      action: compiled.transaction,
      expectedEffect: { type: "none" },
      mode: "transact",
      protectedInputReferences: Object.values(compiled.transaction.inputs).flatMap((value) =>
        value.classification === "known_secret" ? [value.credentialRef] : [],
      ),
    };
    const claim = await this.sessions.beginMissionOperation({
      workspaceId: workspaceId(principal),
      sessionId,
      intent: compiled.intent,
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      action: operation.action,
      expectedEffect: operation.expectedEffect,
      mode: operation.mode,
      protectedReservation,
      earlyProtectedOperationId: material.protectedOperationId,
      preparedProtectedOperationId: material.protectedOperationId,
    });
    await this.preparedOperations.consumeGeneratedBindings(material.protectedOperationId);
    await runEvidence?.preparedOperationAdmitted?.(operation, input.preparedExecutionCapabilityId);
    const executionKey = `${sessionId}:${operation.operationId}`;
    const inFlightExecution = this.inFlightPreparedExecutions.get(executionKey);
    const projection = claim.replayed
      ? inFlightExecution
        ? await inFlightExecution
        : await this.sessions.projectProtectedOperationForAuthoring({
            sessionId,
            operationId: operation.operationId,
          })
      : await this.supervisePreparedExecution(
          sessionId,
          operation,
          executionTimeoutMs,
          runEvidence,
        );
    if (projection.status === "pending")
      throw new ConflictException({
        code: "PREPARED_EXECUTION_AUTHORITATIVE_SETTLEMENT_MISSING",
        state: projection.state,
      });
    return {
      protectedOperationId: material.protectedOperationId,
      publicOperationId: material.publicOperationId,
      state: projection.state,
      replayed: claim.replayed,
      sourceMutationRepeatable: false,
    };
  }

  private async supervisePreparedExecution(
    sessionId: string,
    operation: AdaptiveSessionOperationInput,
    timeoutMs: number,
    runEvidence?: MissionRunEvidenceContext,
  ) {
    const key = `${sessionId}:${operation.operationId}`;
    const existing = this.inFlightPreparedExecutions.get(key);
    if (existing) return existing;
    const work = this.runPreparedExecutionSupervisor(sessionId, operation, timeoutMs, runEvidence);
    this.inFlightPreparedExecutions.set(key, work);
    try {
      return await work;
    } finally {
      if (this.inFlightPreparedExecutions.get(key) === work)
        this.inFlightPreparedExecutions.delete(key);
    }
  }

  private async runPreparedExecutionSupervisor(
    sessionId: string,
    operation: AdaptiveSessionOperationInput,
    timeoutMs: number,
    runEvidence?: MissionRunEvidenceContext,
  ) {
    const startedAt = performance.now();
    const controller = new AbortController();
    let deadlineExpired = false;
    let cancellationWork: Promise<unknown> | undefined;
    await this.sessions.recordPreparedExecutionStage({
      sessionId,
      operationId: operation.operationId,
      stage: "supervisor_launched",
    });
    const timeout = setTimeout(() => {
      deadlineExpired = true;
      const error = Object.assign(new Error("PREPARED_EXECUTION_DEADLINE_EXCEEDED"), {
        code: "PREPARED_EXECUTION_DEADLINE_EXCEEDED",
      });
      controller.abort(error);
      cancellationWork = this.runner.cancelActiveOperation(sessionId).catch(() => undefined);
    }, timeoutMs);
    timeout.unref();
    try {
      await this.sessions.recordPreparedExecutionStage({
        sessionId,
        operationId: operation.operationId,
        stage: "protected_admission_requested",
      });
      await this.executeWithOnePreDispatchRetry(
        sessionId,
        operation,
        controller.signal,
        runEvidence,
      );
      await this.sessions.recordPreparedExecutionStage({
        sessionId,
        operationId: operation.operationId,
        stage: "protected_admission_acknowledged",
        durationMs: performance.now() - startedAt,
      });
      let projection = await this.sessions.projectProtectedOperationForAuthoring({
        sessionId,
        operationId: operation.operationId,
      });
      if (projection.status === "pending") {
        cancellationWork = this.runner.cancelActiveOperation(sessionId).catch(() => undefined);
        await cancellationWork;
        await this.sessions.settlePreparedExecutionDeadline({
          sessionId,
          operationId: operation.operationId,
          reasonCode: "PREPARED_EXECUTION_RETURNED_WITHOUT_SETTLEMENT",
        });
        projection = await this.sessions.projectProtectedOperationForAuthoring({
          sessionId,
          operationId: operation.operationId,
          missingFailureCode: "PREPARED_EXECUTION_RETURNED_WITHOUT_SETTLEMENT",
        });
      }
      await this.sessions.recordPreparedExecutionStage({
        sessionId,
        operationId: operation.operationId,
        stage: projection.status === "settled" ? "terminal_observed" : "execution_returned_pending",
        durationMs: performance.now() - startedAt,
      });
      return projection;
    } catch (error) {
      const code = deadlineExpired
        ? "PREPARED_EXECUTION_DEADLINE_EXCEEDED"
        : errorCode(error, "ADAPTIVE_SESSION_EXECUTION_FAILED");
      if (deadlineExpired) {
        await this.sessions.settlePreparedExecutionDeadline({
          sessionId,
          operationId: operation.operationId,
          reasonCode: code,
        });
      }
      const projection = await this.sessions.projectProtectedOperationForAuthoring({
        sessionId,
        operationId: operation.operationId,
        missingFailureCode: code,
      });
      await this.sessions.recordPreparedExecutionStage({
        sessionId,
        operationId: operation.operationId,
        stage: projection.status === "settled" ? "terminal_observed" : "execution_failed_pending",
        durationMs: performance.now() - startedAt,
        reasonCode: code,
      });
      return projection;
    } finally {
      clearTimeout(timeout);
      if (cancellationWork) await cancellationWork;
    }
  }

  async listMissionContinuations(principal: Principal, sessionId: string) {
    await this.sessions.get(workspaceId(principal), sessionId);
    if (!this.preparedOperations)
      throw new ConflictException({ code: "PREPARED_OPERATION_RUNTIME_UNAVAILABLE" });
    const { missionContinuationsResultSchema } = await import("@scry/contracts");
    return missionContinuationsResultSchema.parse(
      await this.preparedOperations.listContinuations(sessionId),
    );
  }

  async listMissionOperationCheckpoints(principal: Principal, sessionId: string) {
    await this.sessions.get(workspaceId(principal), sessionId);
    if (!this.preparedOperations)
      throw new ConflictException({ code: "PREPARED_OPERATION_RUNTIME_UNAVAILABLE" });
    return this.preparedOperations.listCheckpoints(sessionId);
  }

  private async currentOperationContracts(sessionId: string, current: PraxisObservation) {
    if (!this.operationContracts || !this.operationContractProviders)
      throw new ConflictException({ code: "OPERATION_CONTRACT_REGISTRY_UNAVAILABLE" });
    const generic = await this.runner.observeOperationContracts(sessionId);
    // DOM perception and the authoring owner have distinct epoch counters.
    // Correlate the same observed document first, then bind to the authoritative
    // owner epoch; never treat a perception counter as runtime authority.
    const correlated = generic.map((contract) => {
      if (
        contract.provenance.sourceDocumentEpoch !==
          current.semanticPageContext.authority.documentEpoch ||
        !contract.provenance.observationId.startsWith(
          `${current.semanticPageContext.authority.pageId}:operation-contract:`,
        ) ||
        contract.provenance.origin !== new URL(current.url).origin
      )
        throw new ConflictException({ code: "OPERATION_CONTRACT_OBSERVATION_CHANGED" });
      return {
        ...contract,
        provenance: { ...contract.provenance, sourceDocumentEpoch: current.documentEpoch },
        interaction: { ...contract.interaction, documentEpoch: current.documentEpoch },
      };
    });
    const projected = this.operationContractProviders.project(sessionId, current, correlated);
    return this.operationContracts.register(sessionId, projected);
  }

  async readPublicValue(
    principal: Principal,
    sessionId: string,
    input: import("@scry/contracts").ReadPraxisPublicValueInput,
  ) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);

    if (session.state !== "active" && session.state !== "suspended") {
      throw new ConflictException({ code: "PRAXIS_SESSION_NOT_LIVE" });
    }

    return this.runner.readPublicValue(sessionId, input);
  }

  async inspectRegion(
    principal: Principal,
    sessionId: string,
    input: import("@scry/contracts").InspectPraxisRegionInput,
  ) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);

    if (session.state !== "active" && session.state !== "suspended") {
      throw new ConflictException({ code: "PRAXIS_SESSION_NOT_LIVE" });
    }

    return this.runner.inspectRegion(sessionId, input);
  }

  async inspectBrowserResources(principal: Principal, sessionId: string) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    if (session.state !== "active" && session.state !== "suspended")
      throw new ConflictException({ code: "PRAXIS_SESSION_NOT_LIVE" });
    return this.runner.inspectBrowserResources(sessionId);
  }

  async readPublicResource(
    principal: Principal,
    sessionId: string,
    input: import("@scry/contracts").ReadPraxisPublicResourceInput,
  ) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    if (session.state !== "active" && session.state !== "suspended")
      throw new ConflictException({ code: "PRAXIS_SESSION_NOT_LIVE" });
    return this.runner.readPublicResource(sessionId, input);
  }

  async inspectStructure(principal: Principal, sessionId: string) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    if (session.state !== "active" && session.state !== "suspended")
      throw new ConflictException({ code: "PRAXIS_SESSION_NOT_LIVE" });
    return this.runner.inspectStructure(sessionId);
  }

  async readPublicStructureValue(
    principal: Principal,
    sessionId: string,
    input: import("@scry/contracts").ReadPraxisPublicStructureValueInput,
  ) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    if (session.state !== "active" && session.state !== "suspended")
      throw new ConflictException({ code: "PRAXIS_SESSION_NOT_LIVE" });
    return this.runner.readPublicStructureValue(sessionId, input);
  }

  async inspectRuntimeState(principal: Principal, sessionId: string) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    if (session.state !== "active" && session.state !== "suspended")
      throw new ConflictException({ code: "PRAXIS_SESSION_NOT_LIVE" });
    return this.runner.inspectRuntimeState(sessionId);
  }

  async readPublicRuntimeValue(
    principal: Principal,
    sessionId: string,
    input: import("@scry/contracts").ReadPraxisPublicRuntimeValueInput,
  ) {
    const session = await this.sessions.get(workspaceId(principal), sessionId);
    if (session.state !== "active" && session.state !== "suspended")
      throw new ConflictException({ code: "PRAXIS_SESSION_NOT_LIVE" });
    return this.runner.readPublicRuntimeValue(sessionId, input);
  }

  async reconcileUnknown(
    principal: Principal,
    sessionId: string,
    input: ReconcileAdaptiveOperationInput,
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    const claim = await this.sessions.beginUnknownReconciliation({
      workspaceId: workspaceId(principal),
      sessionId,
      ...input,
    });
    if (claim.state === "completed" && "result" in claim && claim.result && claim.reasonCode)
      return {
        sessionId,
        operationId: input.operationId,
        originalMutationOutcome: "unknown" as const,
        result: claim.result,
        redispatchAllowed: false as const,
        missionFenceCleared: claim.missionFenceCleared,
        reasonCode: claim.reasonCode,
        replayed: true,
        safeActions:
          claim.result === "still_unknown"
            ? ["get_flow_authoring"]
            : claim.authoringSessionState === "active"
              ? ["get_flow_authoring", "advance_flow_authoring"]
              : ["get_flow_authoring", "start_flow_authoring"],
        requiresFreshIdempotencyKey: claim.result === "still_unknown",
        ...(claim.result === "still_unknown" ? { nextAttemptId: randomUUID() } : {}),
      };
    if (claim.replayed)
      throw new ConflictException({
        code: "UNKNOWN_RECONCILIATION_IN_PROGRESS",
        mutationOutcome: "unknown",
        safeActions: ["get_flow_authoring"],
      });
    if (!claim.id || claim.fencingToken === undefined)
      throw new ConflictException({
        code: "UNKNOWN_RECONCILIATION_FENCE_LOST",
        mutationOutcome: "unknown",
        safeActions: ["get_flow_authoring"],
      });
    const readOnlyObservation =
      (claim.authority.action.type === "click" || claim.authority.action.type === "press") &&
      claim.authority.action.dispatchSemantics === "read_only"
        ? {
            result: "proven_not_applied" as const,
            reasonCode: "READ_ONLY_DISPATCH_HAS_NO_MUTATION_EFFECT",
            evidence: { dispatchSemantics: "read_only", functionalEffect: "unresolved" },
          }
        : null;
    const resourceObservation =
      readOnlyObservation ?? (await this.reconciliationRegistry?.reconcile(claim.authority));
    const observation =
      resourceObservation ??
      (claim.expectedEffect.type === "none"
        ? {
            result: "still_unknown" as const,
            reasonCode: "RECONCILIATION_EXPECTED_EFFECT_UNAVAILABLE",
            evidence: { expectedEffectType: "none" },
          }
        : await this.runner.reconcileUnknownEffect(
            sessionId,
            claim.expectedEffect,
            claim.baseline,
          ));
    const settled = await this.sessions.completeUnknownReconciliation({
      sessionId,
      missionId: input.missionId,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      reconciliationId: claim.id,
      fencingToken: claim.fencingToken,
      runtimeOwned: this.runner.hasRuntime(sessionId),
      ...observation,
    });
    return {
      sessionId,
      operationId: input.operationId,
      originalMutationOutcome: "unknown" as const,
      result: observation.result,
      redispatchAllowed: false as const,
      missionFenceCleared: settled.missionFenceCleared,
      reasonCode: observation.reasonCode,
      replayed: false,
      ...(observation.result === "proven_applied_output_unrecovered"
        ? {
            resourceEffect: {
              resource: observation.resource,
              outputState: observation.outputState,
            },
          }
        : {}),
      safeActions:
        observation.result !== "still_unknown"
          ? observation.result === "proven_applied_output_unrecovered"
            ? ["get_flow_authoring"]
            : settled.authoringSessionState === "active"
              ? ["get_flow_authoring", "advance_flow_authoring"]
              : ["get_flow_authoring", "start_flow_authoring"]
          : ["get_flow_authoring"],
      requiresFreshIdempotencyKey: observation.result === "still_unknown",
      ...(observation.result === "still_unknown" ? { nextAttemptId: randomUUID() } : {}),
    };
  }

  async captureRunSuccessorCheckpoint(principal: Principal, sessionId: string) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);

    // Authorization/read scope only. The runner still owns browser state.
    await this.sessions.get(workspaceId(principal), sessionId);

    return this.runner.captureSuccessorCheckpoint(sessionId);
  }

  async advance(
    principal: Principal,
    sessionId: string,
    input: MissionAuthoringAdvanceInput | AdvanceAdaptiveSessionInput,

    runEvidence?: MissionRunEvidenceContext,
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    if (!("kind" in input))
      throw new ConflictException({ code: "MISSION_AUTHORING_INTENT_REQUIRED" });
    const missionInput: MissionAuthoringAdvanceInput = input;
    if (missionInput.kind === "intents") {
      const key = `${sessionId}:${missionInput.idempotencyKey}`;
      const inFlight = this.inFlightTurns.get(key);
      if (inFlight) return this.awaitInFlightTurn(inFlight, missionInput.budgets.maxDurationMs);
      const owner = this.advanceOwned(principal, sessionId, missionInput, runEvidence);
      this.inFlightTurns.set(key, owner);
      try {
        return await owner;
      } finally {
        if (this.inFlightTurns.get(key) === owner) this.inFlightTurns.delete(key);
      }
    }
    return this.advanceOwned(principal, sessionId, missionInput, runEvidence);
  }

  private async advanceOwned(
    principal: Principal,
    sessionId: string,
    input: MissionAuthoringAdvanceInput,

    runEvidence?: MissionRunEvidenceContext,
  ) {
    let turn: {
      turnId: string;
      replayed: boolean;
      response: MissionAuthoringTurnResult | null;
      safeInput?: { intents?: MissionAuthoringIntent[] };
      nextIntentIndex: number;
    };
    if (input.kind === "intents") {
      const created = await this.sessions.beginTurn({
        workspaceId: workspaceId(principal),
        sessionId,
        idempotencyKey: input.idempotencyKey,
        inputDigest: digest({ intents: input.intents, budgets: input.budgets }),
        budgets: input.budgets,
        intents: input.intents,
        ...(input.recoveryBinding ? { recoveryBinding: input.recoveryBinding } : {}),
      });
      turn = {
        turnId: created.turnId,
        replayed: created.replayed,
        response: created.response,
        nextIntentIndex: 0,
      };
    } else {
      const continued = await this.sessions.continueTurn({
        workspaceId: workspaceId(principal),
        sessionId,
        turnId: input.turnId,
        idempotencyKey: input.idempotencyKey,
        budgets: input.budgets,
      });
      turn = {
        turnId: continued.id,
        replayed: continued.replayed,
        response: continued.safeResponse,
        safeInput: continued.safeInput,
        nextIntentIndex: continued.nextIntentIndex,
      };
    }
    if (turn.replayed && turn.response) return turn.response;
    if (turn.replayed) {
      throw new ConflictException({
        code: "MISSION_AUTHORING_TURN_IN_PROGRESS",
        turnId: turn.turnId,
      });
    }
    const intents = input.kind === "intents" ? input.intents : turn.safeInput?.intents;
    if (!intents?.length)
      throw new ConflictException({ code: "MISSION_AUTHORING_TURN_INPUT_UNAVAILABLE" });
    return this.executeTurn(
      principal,
      sessionId,
      turn.turnId,
      intents,
      input.budgets,
      turn.nextIntentIndex,
      input.kind === "continue" ? turn.response : null,
      runEvidence,
    );
  }

  private async awaitInFlightTurn(
    owner: Promise<MissionAuthoringTurnResult>,
    maxDurationMs: number,
  ): Promise<MissionAuthoringTurnResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        owner,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new ConflictException({ code: "MISSION_AUTHORING_TURN_IN_PROGRESS" })),
            Math.min(maxDurationMs, 60_000),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async executeTurn(
    principal: Principal,
    sessionId: string,
    turnId: string,
    intents: MissionAuthoringIntent[],
    budgets: { maxOperations: number; maxDurationMs: number },
    nextIntentIndex = 0,
    priorResult: MissionAuthoringTurnResult | null = null,

    runEvidence?: MissionRunEvidenceContext,
  ) {
    const startedAt = performance.now();
    const completed: MissionAuthoringTurnResult["completed"] = [...(priorResult?.completed ?? [])];
    const timings = {
      resolveMs: priorResult?.timings.resolveMs ?? 0,
      executeMs: priorResult?.timings.executeMs ?? 0,
      verifyMs: priorResult?.timings.verifyMs ?? 0,
      journalMs: priorResult?.timings.journalMs ?? 0,
    };
    let handoffChanged = Boolean(
      priorResult?.stateDelta.activeObjectiveId && priorResult.stateDelta.activeFlowDraftId,
    );
    let active =
      priorResult?.stateDelta.activeObjectiveId && priorResult.stateDelta.activeFlowDraftId
        ? {
            objectiveId: priorResult.stateDelta.activeObjectiveId,
            flowDraftId: priorResult.stateDelta.activeFlowDraftId,
          }
        : undefined;
    let safeState =
      priorResult?.stateDelta.url !== undefined &&
      priorResult.stateDelta.documentEpoch !== undefined
        ? { url: priorResult.stateDelta.url, documentEpoch: priorResult.stateDelta.documentEpoch }
        : undefined;
    let operationsThisAttempt = 0;
    const priorTotalMs = priorResult?.timings.totalMs ?? 0;
    for (let intentIndex = nextIntentIndex; intentIndex < intents.length; intentIndex += 1) {
      const intent = intents[intentIndex]!;
      if (
        operationsThisAttempt >= budgets.maxOperations ||
        performance.now() - startedAt >= budgets.maxDurationMs
      ) {
        const pending = turnResult({
          turnId,
          state: "pending",
          completed,
          handoffChanged,
          ...(active ? { active } : {}),
          ...(safeState ? { safeState } : {}),
          startedAt,
          elapsedBaseMs: priorTotalMs,
          phase: "budget",
          timings,
        });
        return this.sessions.persistPending({
          sessionId,
          turnId,
          result: pending,
          phase: "budget",
          nextIntentIndex: intentIndex,
        });
      }
      const resolveStartedAt = performance.now();
      let operation: AdaptiveSessionOperationInput;
      let replayedOperation: AdaptiveSessionOperationInput | null = null;
      try {
        await this.sessions.validateIntentAdmission({ sessionId, intent });
        const handoff = await this.sessions.handoff({
          workspaceId: workspaceId(principal),
          sessionId,
          objectiveId: intent.objectiveId,
          flowDraftId: intent.flowDraftId,
          idempotencyKey: `handoff:${turnId}:${intent.intentId}`,
          reason: "Intent Flow ownership changed",
        });
        handoffChanged ||= handoff.handedOff;
        if (handoff.handedOff)
          active = { objectiveId: intent.objectiveId, flowDraftId: intent.flowDraftId };
        let protectedTransaction;
        if (intent.action.kind === "acquire_protected_outputs") {
          throw new ConflictException({
            code: "PREPARED_EXECUTION_CAPABILITY_REQUIRED",
            recovery: "reserve_prepared_protected_operation",
          });
        }
        if (
          this.operationContracts &&
          (intent.action.kind === "activate" ||
            intent.action.kind === "press" ||
            intent.action.kind === "same_origin_request")
        ) {
          const action = intent.action;
          const current = await this.runner.observe(sessionId);
          const declared = await this.currentOperationContracts(sessionId, current);
          const selected = declared.filter((entry) => {
            if (!entry.interaction) return false;
            if (action.kind === "same_origin_request") {
              const expected = entry.revision.facts.operation;
              const parts = expected.pathTemplate.split("/");
              const actual = new URL(action.path, current.url).pathname.split("/");
              return (
                action.method === expected.method &&
                parts.length === actual.length &&
                parts.every((part, index) =>
                  /^\{[^}]+\}$/.test(part) ? Boolean(actual[index]) : part === actual[index],
                )
              );
            }
            return (
              entry.interaction.activationControlReference === action.target?.reference ||
              (action.kind === "press" &&
                action.key === "Enter" &&
                (!action.target ||
                  Object.values(entry.interaction.inputControlReferences).includes(
                    action.target.reference ?? "",
                  )))
            );
          });
          if (selected.length)
            throw new ConflictException({
              code: "PREPARED_EXECUTION_CAPABILITY_REQUIRED",
              recovery: "reserve_prepared_protected_operation",
              operationContractRevisionIds: selected.map((entry) => entry.revision.id),
            });
        }
        const derived =
          replayedOperation ??
          deriveMissionAuthoringOperation({
            turnId,
            intent,
            ...(protectedTransaction ? { protectedTransaction } : {}),
          });
        operation = {
          operationId: derived.operationId,
          idempotencyKey: derived.idempotencyKey,
          action: derived.action,
          expectedEffect: derived.expectedEffect,
          mode: derived.mode,
          protectedInputReferences: intent.protectedInputReferences,
        };
      } catch (error) {
        timings.resolveMs += performance.now() - resolveStartedAt;
        const decision = turnResult({
          turnId,
          state: "decision_required",
          completed,
          handoffChanged,
          ...(active ? { active } : {}),
          ...(safeState ? { safeState } : {}),
          startedAt,
          elapsedBaseMs: priorTotalMs,
          timings,
          decisionBoundary: admissionDecisionBoundary(error),
        });
        return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
      }
      const claim = await this.sessions.beginMissionOperation({
        workspaceId: workspaceId(principal),
        sessionId,
        intent,
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        action: operation.action,
        expectedEffect: operation.expectedEffect,
        mode: operation.mode,
      });
      timings.resolveMs += performance.now() - resolveStartedAt;
      if (
        operation.action.type !== "protectedTransaction" &&
        claim.replayed &&
        claim.state === "running"
      ) {
        const disposition = await this.sessions.replayDisposition(sessionId, operation.operationId);
        if (disposition.requiresReconciliation) {
          await this.sessions.markRunningOperationRecoveryRequired(
            sessionId,
            operation.operationId,
          );
          const decision = turnResult({
            turnId,
            state: "decision_required",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            timings,
            decisionBoundary: {
              type: "mutation_reconciliation_required",
              reasonCode: "ADAPTIVE_OPERATION_RECONCILIATION_REQUIRED",
              safeActions: ["get_flow_authoring", "do_not_retry"],
            },
          });
          return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
        }
        if (!disposition.canResume) {
          const pending = turnResult({
            turnId,
            state: "pending",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            phase: "operation_running",
            timings,
          });
          return this.sessions.persistPending({
            sessionId,
            turnId,
            result: pending,
            phase: "operation_running",
            nextIntentIndex: intentIndex,
          });
        }
      }
      if (operation.action.type === "protectedTransaction") {
        if (!claim.replayed) {
          operationsThisAttempt += 1;
          const pending = turnResult({
            turnId,
            state: "pending",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            phase: "protected_operation",
            timings,
          });
          const persisted = await this.sessions.persistPending({
            sessionId,
            turnId,
            result: pending,
            phase: "protected_operation",
            nextIntentIndex: intentIndex,
          });
          this.launchProtectedExecution(sessionId, operation, runEvidence);
          return persisted;
        }
        const projection = await this.sessions.projectProtectedOperationForAuthoring({
          sessionId,
          operationId: operation.operationId,
        });
        if (projection.status === "pending") {
          // Re-enter the execution kernel for every expired durable active state.
          // Its protected repository claim is the sole authority that fences the
          // prior owner and applies process-loss recovery classification.
          if (!projection.leaseActive) {
            this.launchProtectedExecution(sessionId, operation, runEvidence);
          }
          const pending = turnResult({
            turnId,
            state: "pending",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            phase: "protected_operation",
            timings,
          });
          return this.sessions.persistPending({
            sessionId,
            turnId,
            result: pending,
            phase: "protected_operation",
            nextIntentIndex: intentIndex,
          });
        }
        completed.push(compactSemanticDelta(intent.intentId, projection.outcome, true));
        if (
          projection.outcome.functionalResult !== "succeeded" ||
          projection.outcome.mutationOutcome === "unknown" ||
          projection.decisionBoundary.type !== "objective_completed"
        ) {
          const decision = turnResult({
            turnId,
            state: "decision_required",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            decisionBoundary: projection.decisionBoundary,
            timings,
          });
          return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
        }
        continue;
      }
      if (claim.replayed && "outcome" in claim && claim.state !== "running" && claim.outcome) {
        completed.push(
          compactSemanticDelta(intent.intentId, claim.outcome, requiresProtectedInterval(intent)),
        );
        if (
          claim.outcome.functionalResult !== "succeeded" ||
          claim.outcome.mutationOutcome === "unknown"
        ) {
          const decisionBoundary = claim.outcome.nextDecisionBoundary ?? {
            type: "environment_unavailable" as const,
            reasonCode: claim.outcome.reasonCode ?? "ADAPTIVE_SESSION_EXECUTION_FAILED",
            safeActions: ["get_flow_authoring"],
          };
          const decision = turnResult({
            turnId,
            state: "decision_required",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            decisionBoundary,
            timings,
          });
          return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
        }
        continue;
      }
      operationsThisAttempt += 1;
      try {
        const remainingMs = Math.floor(budgets.maxDurationMs - (performance.now() - startedAt));
        if (remainingMs < 100) {
          const pending = turnResult({
            turnId,
            state: "pending",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            phase: "budget",
            timings,
          });
          return this.sessions.persistPending({
            sessionId,
            turnId,
            result: pending,
            phase: "budget",
            nextIntentIndex: intentIndex,
          });
        }
        const result = await this.executeWithinTurnDeadline(
          sessionId,
          operation,
          remainingMs,
          runEvidence,
        );
        timings.resolveMs += result.timings.resolveMs;
        timings.executeMs += result.timings.executeMs;
        timings.verifyMs += result.timings.verifyMs;
        safeState = result.safeState;
        const journalStartedAt = performance.now();
        const settled = await this.sessions.settleMissionOperation({
          sessionId,
          turnId,
          operationId: operation.operationId,
          intent,
          action: operation.action,
          ...result,
        });
        timings.journalMs += performance.now() - journalStartedAt;
        completed.push(
          compactSemanticDelta(intent.intentId, settled.outcome, requiresProtectedInterval(intent)),
        );
        if (
          settled.outcome.functionalResult !== "succeeded" ||
          settled.outcome.mutationOutcome === "unknown" ||
          settled.decisionBoundary.type !== "objective_completed"
        ) {
          const decision = turnResult({
            turnId,
            state: "decision_required",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            decisionBoundary: settled.decisionBoundary,
            timings,
          });
          return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
        }
      } catch (error) {
        const code = errorCode(error, "ADAPTIVE_SESSION_EXECUTION_FAILED");
        await this.runner.close?.(sessionId).catch(() => undefined);
        const failure = await this.sessions.markOperationFailed(
          sessionId,
          operation.operationId,
          code,
          turnId,
        );
        if (failure?.outcome) {
          completed.push(
            compactSemanticDelta(
              intent.intentId,
              failure.outcome,
              requiresProtectedInterval(intent),
            ),
          );
        }
        const decision = turnResult({
          turnId,
          state: "decision_required",
          completed,
          handoffChanged,
          ...(active ? { active } : {}),
          ...(safeState ? { safeState } : {}),
          startedAt,
          elapsedBaseMs: priorTotalMs,
          timings,
          decisionBoundary:
            failure?.decisionBoundary ??
            (code === "EXECUTION_MODE_POLICY_DENIED"
              ? liveReadPolicyBoundary(intent)
              : {
                  type: "environment_unavailable",
                  reasonCode: code,
                  safeActions: ["get_flow_authoring"],
                }),
        });
        return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
      }
    }
    return this.settleTurn(
      sessionId,
      turnId,
      turnResult({
        turnId,
        state: "completed",
        completed,
        handoffChanged,
        ...(active ? { active } : {}),
        ...(safeState ? { safeState } : {}),
        startedAt,
        elapsedBaseMs: priorTotalMs,
        timings,
      }),
      timings,
      startedAt,
    );
  }

  private async settleTurn(
    sessionId: string,
    turnId: string,
    result: MissionAuthoringTurnResult,
    timings: { resolveMs: number; executeMs: number; verifyMs: number; journalMs: number },
    startedAt: number,
  ) {
    void timings;
    void startedAt;
    return this.sessions.settleTurn({ sessionId, turnId, result });
  }

  private async executeWithOnePreDispatchRetry(
    sessionId: string,
    operation: AdaptiveSessionOperationInput,
    signal?: AbortSignal,
    runEvidence?: MissionRunEvidenceContext,
  ) {
    const execute = async () => {
      if (!runEvidence) return this.runner.execute(sessionId, operation, signal);

      const outputDirectory = runEvidence.outputDirectoryFor(operation);

      const result = await this.runner.executeForRun({
        sessionId,
        operation,
        outputDirectory,
        veilPolicySnapshot: runEvidence.veilPolicySnapshot,
        beforeBusinessMutationDispatch: runEvidence.beforeBusinessMutationDispatch,
        ...(signal ? { signal } : {}),
      });

      if (!result.report)
        throw new ConflictException({
          code: "RUN_EVIDENCE_REPORT_MISSING",
          mutationOutcome: "not_applied",
        });

      await runEvidence.commit({
        operation,
        report: result.report,
        outputDirectory,
      });

      return result;
    };

    try {
      return await execute();
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error &&
        "preDispatchTransient" in error &&
        error.preDispatchTransient === true
      ))
        throw error;

      return execute();
    }
  }

  private async executeWithinTurnDeadline(
    sessionId: string,
    operation: AdaptiveSessionOperationInput,
    remainingMs: number,

    runEvidence?: MissionRunEvidenceContext,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("AUTHORING_TURN_BUDGET_EXHAUSTED"));
      void this.runner.cancelActiveOperation(sessionId);
    }, remainingMs);
    timeout.unref();
    const bounded = {
      ...operation,
      action: clampActionTimeout(operation.action, remainingMs),
    } satisfies AdaptiveSessionOperationInput;
    try {
      return await this.executeWithOnePreDispatchRetry(
        sessionId,
        bounded,
        controller.signal,
        runEvidence,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private launchProtectedExecution(
    sessionId: string,
    operation: AdaptiveSessionOperationInput,
    runEvidence?: MissionRunEvidenceContext,
  ) {
    const key = `${sessionId}:${operation.operationId}`;
    if (this.inFlightProtectedOperations.has(key)) return;
    const work = (async () => {
      try {
        await this.executeWithOnePreDispatchRetry(sessionId, operation, undefined, runEvidence);
        await this.sessions.projectProtectedOperationForAuthoring({
          sessionId,
          operationId: operation.operationId,
        });
      } catch (error) {
        await this.sessions.projectProtectedOperationForAuthoring({
          sessionId,
          operationId: operation.operationId,
          missingFailureCode: errorCode(error, "ADAPTIVE_SESSION_EXECUTION_FAILED"),
        });
      }
    })();
    this.inFlightProtectedOperations.set(key, work);
    const release = () => {
      if (this.inFlightProtectedOperations.get(key) === work)
        this.inFlightProtectedOperations.delete(key);
    };
    void work.then(release, release);
  }

  async close(principal: Principal, sessionId: string, idempotencyKey: string) {
    this.requireWrite(principal);
    try {
      await this.sessions.settleInvalidPredispatchProtectedAuthorizations({
        workspaceId: workspaceId(principal),
        sessionId,
      });
      return await this.sessions.closeAtSafeBoundary({
        workspaceId: workspaceId(principal),
        sessionId,
        idempotencyKey,
      });
    } finally {
      // A durable unknown-mutation conflict must remain visible to the caller,
      // but it cannot leave this process owning a browser or runtime lease.
      await this.runner.close(sessionId);
    }
  }

  async settleExternalOwnerLoss(
    principal: Principal,
    sessionId: string,
    reasonCode: string,
    idempotencyKey: string,
  ) {
    this.requireWrite(principal);
    try {
      return await this.sessions.settleExternalOwnerLoss({
        workspaceId: workspaceId(principal),
        sessionId,
        reasonCode,
        idempotencyKey,
      });
    } finally {
      await this.runner.close(sessionId);
    }
  }

  convergeExpiredRuntimeOwners() {
    return this.sessions.convergeExpiredRuntimeOwners();
  }

  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer") {
      throw new ForbiddenException("Workspace viewers have read-only access");
    }
  }
}

function liveReadPolicyBoundary(
  intent: import("@scry/contracts").MissionAuthoringIntent,
): NonNullable<MissionAuthoringTurnResult["decisionBoundary"]> {
  const semanticEffect =
    intent.action.kind === "activate" || intent.action.kind === "press"
      ? intent.action.semanticEffect
      : "resource_mutation";
  const readContext = semanticEffect === "read_context_transition";
  return {
    type: "policy_refused",
    reasonCode: "EXECUTION_MODE_POLICY_DENIED",
    safeActions: [],
    policyContext: {
      governingMode: "observe",
      requestedSemanticEffect: semanticEffect,
      gesture: intent.action.kind,
      effectApplied: false,
      strongerAuthorityCouldPermit: semanticEffect === "resource_mutation",
      recoverable: false,
      explanation: readContext
        ? "The declared read-context transition was not admitted; no dispatch occurred."
        : "Live-read authority does not permit resource mutations or interactions without a proven read-context-only effect.",
    },
  };
}

function workspaceId(principal: Principal) {
  return principal.kind === "user" ? principal.workspaceId : null;
}

function clampActionTimeout(action: CurrentAction, remainingMs: number): CurrentAction {
  if (!("timeoutMs" in action)) return action;
  return {
    ...action,
    timeoutMs: Math.max(100, Math.min(action.timeoutMs ?? remainingMs, remainingMs)),
  } as CurrentAction;
}

function errorCode(error: unknown, fallback: string) {
  const valid = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value);
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (valid(code)) return code;
  }
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: unknown }).response;
    if (typeof response === "object" && response && "code" in response) {
      const code = (response as { code?: unknown }).code;
      if (valid(code)) return code;
    }
  }
  return error instanceof Error && valid(error.message) ? error.message : fallback;
}

function preparedExecutionTimeoutMs() {
  const value = Number(process.env.SCRY_PREPARED_EXECUTION_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) ? Math.max(1_000, Math.min(600_000, Math.floor(value))) : 120_000;
}

function authoringProvisioningFailure(
  input: StartAdaptiveSessionInput,
  sessionId: string,
  error?: unknown,
) {
  const checkpointFailure = errorCode(error, "AUTHORING_PROVISIONING_FAILED").startsWith(
    "SUCCESSOR_CHECKPOINT_",
  );
  return new ConflictException({
    code: errorCode(error, "AUTHORING_PROVISIONING_FAILED"),
    mutationOutcome: "not_applied",
    environment: {
      environmentId: input.environmentId,
      resourceExists: true,
      executionReadiness: "unavailable",
    },
    ...(!checkpointFailure
      ? {
          recovery: {
            recoveryTool: "start_flow_authoring",
            requiresFreshIdempotencyKey: true,
            idempotencyKey: `authoring-recovery-${randomUUID()}`,
            failedAuthoringSessionId: sessionId,
            preservesMissionId: input.missionId,
            preservesObjectiveId: input.objectiveId,
            preservesFlowDraftId: input.flowDraftId,
          },
        }
      : {}),
    safeActions: checkpointFailure
      ? ["get_operating_context"]
      : ["get_operating_context", "start_flow_authoring"],
  });
}

function authoringPreparationFailure(
  prepared: Awaited<ReturnType<AdaptiveSessionRepository["prepare"]>>,
  error?: unknown,
) {
  const checkpointFailure = errorCode(error, "AUTHORING_PROVISIONING_FAILED").startsWith(
    "SUCCESSOR_CHECKPOINT_",
  );
  return new ConflictException({
    code: errorCode(error, "AUTHORING_PROVISIONING_FAILED"),
    mutationOutcome: "not_applied",
    environment: {
      environmentId: prepared.environmentId,
      resourceExists: true,
      executionReadiness: "unavailable",
    },
    ...(!checkpointFailure
      ? {
          recovery: {
            recoveryTool: "start_flow_authoring",
            requiresFreshIdempotencyKey: true,
            idempotencyKey: `authoring-recovery-${randomUUID()}`,
            failedAuthoringSessionId: prepared.authoringSessionId,
            preservesMissionId: prepared.missionId,
            preservesObjectiveId: prepared.objectiveId,
            preservesFlowDraftId: prepared.flowDraftId,
          },
        }
      : {}),
    safeActions: checkpointFailure
      ? ["get_operating_context"]
      : ["get_operating_context", "start_flow_authoring"],
  });
}

function admissionDecisionBoundary(
  error: unknown,
): NonNullable<MissionAuthoringTurnResult["decisionBoundary"]> {
  const code = errorCode(error, "MISSION_AUTHORING_ADMISSION_FAILED");
  if (code === "PREPARED_EXECUTION_CAPABILITY_REQUIRED") {
    return {
      type: "effect_observation_required",
      reasonCode: code,
      safeActions: [
        "observe_operation_contracts",
        "reserve_prepared_protected_operation",
        "dispatch_prepared_protected_operation",
      ],
    };
  }
  if (code === "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED") {
    return {
      type: "authorization_required",
      reasonCode: code,
      safeActions: ["authorize_environment_credentials", "dispatch_run_operation"],
      requiresFreshIntentId: true,
    };
  }
  if (code === "MISSION_AUTHORING_PROTECTED_SESSION_REQUIRED") {
    return {
      type: "authorization_required",
      reasonCode: code,
      safeActions: ["start_praxis_session", "attach_run_praxis_session"],
    };
  }
  if (code.includes("ORIGIN_NOT_ALLOWED") || code.includes("AUTHORIZATION")) {
    return { type: "policy_refused", reasonCode: code, safeActions: [] };
  }
  return {
    type: "environment_unavailable",
    reasonCode: code,
    safeActions: ["get_flow_authoring"],
  };
}

function compactSemanticDelta(
  intentId: string,
  outcome: import("@scry/contracts").OperationOutcome,
  privacyApplicable: boolean,
): MissionAuthoringTurnResult["completed"][number] {
  return {
    intentId,
    state: outcome.functionalResult === "succeeded" ? "completed" : "failed",
    effectVerified: outcome.functionalResult === "succeeded",
    ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
    functionalResult: outcome.functionalResult,
    mutationOutcome: outcome.mutationOutcome,
    privacyApplicable,
    privacyResult: outcome.privacyResult,
    evidence: {
      state: outcome.evidenceResult.some((channel) => channel.state === "failed")
        ? "failed"
        : outcome.evidenceResult.some((channel) => channel.state === "quarantined")
          ? "quarantined"
          : outcome.evidenceResult.some((channel) => channel.state === "suppressed")
            ? "suppressed"
            : "available",
      count: outcome.evidenceResult.length,
      reasonCodes: outcome.evidenceResult
        .flatMap((channel) => (channel.reasonCode ? [channel.reasonCode] : []))
        .slice(0, 8),
    },
    semanticEvidence: {
      count: outcome.resolvedTarget ? 1 : 0,
      ...(outcome.resolvedTarget ? { resolvedTarget: outcome.resolvedTarget } : {}),
    },
    ...(outcome.semanticPageContext ? { semanticPageContext: outcome.semanticPageContext } : {}),
    quality: {
      findingCount: outcome.qualityFindings.length,
      reasonCodes: outcome.qualityFindings
        .flatMap((finding) =>
          typeof finding.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(finding.code)
            ? [finding.code]
            : [],
        )
        .slice(0, 8),
    },
    ...(outcome.generatedReferences ? { generatedReferences: outcome.generatedReferences } : {}),
  };
}

function turnResult(input: {
  turnId: string;
  state: MissionAuthoringTurnResult["state"];
  completed: MissionAuthoringTurnResult["completed"];
  handoffChanged: boolean;
  active?: { objectiveId: string; flowDraftId: string };
  safeState?: { url: string; documentEpoch: number };
  startedAt: number;
  elapsedBaseMs?: number;
  timings: { resolveMs: number; executeMs: number; verifyMs: number; journalMs: number };
  phase?: string;
  decisionBoundary?: MissionAuthoringTurnResult["decisionBoundary"];
}): MissionAuthoringTurnResult {
  const failed = input.completed.some((delta) => delta.functionalResult !== "succeeded");
  const unknown = input.completed.some((delta) => delta.mutationOutcome === "unknown");
  const evidenceFailed = input.completed.some(
    (delta) => delta.evidence.state === "failed" || delta.evidence.state === "quarantined",
  );
  return {
    turnId: input.turnId,
    state: input.state,
    completed: input.completed,
    stateDelta: {
      ...(input.handoffChanged && input.active
        ? {
            activeObjectiveId: input.active.objectiveId,
            activeFlowDraftId: input.active.flowDraftId,
          }
        : {}),
      ...(input.safeState
        ? { url: input.safeState.url, documentEpoch: input.safeState.documentEpoch }
        : {}),
    },
    channels: {
      functional: { state: input.state === "pending" ? "pending" : failed ? "failed" : "passed" },
      mutation: { state: unknown ? "failed" : "passed" },
      privacy: privacyChannel(input.completed),
      evidence: {
        state: input.state === "pending" ? "pending" : evidenceFailed ? "failed" : "passed",
      },
      quality: {
        state: "passed",
        ...(input.completed.some((delta) => delta.quality.findingCount > 0)
          ? { reasonCode: "QUALITY_FINDINGS_PRESENT" }
          : {}),
      },
    },
    timings: {
      resolveMs: Math.round(input.timings.resolveMs),
      executeMs: Math.round(input.timings.executeMs),
      verifyMs: Math.round(input.timings.verifyMs),
      journalMs: Math.round(input.timings.journalMs),
      totalMs: Math.round((input.elapsedBaseMs ?? 0) + performance.now() - input.startedAt),
    },
    decisionBoundary: input.decisionBoundary ?? null,
    ...(input.state === "pending"
      ? { continuation: { turnId: input.turnId, phase: input.phase ?? "resume" } }
      : {}),
  };
}

function privacyChannel(
  completed: MissionAuthoringTurnResult["completed"],
): MissionAuthoringTurnResult["channels"]["privacy"] {
  const privacy = completed
    .filter((delta) => delta.privacyApplicable)
    .map((delta) => delta.privacyResult);
  if (!privacy.length) return { state: "not_applicable" };
  if (privacy.includes("degraded")) return { state: "failed", reasonCode: "PRIVACY_DEGRADED" };
  if (privacy.includes("unverified")) return { state: "failed", reasonCode: "PRIVACY_UNVERIFIED" };
  return { state: "passed" };
}

function requiresProtectedInterval(intent: MissionAuthoringIntent) {
  return (
    (intent.action.kind === "fill" && Boolean(intent.action.protectedReferenceId)) ||
    intent.action.kind === "authenticate" ||
    intent.action.kind === "same_origin_request"
  );
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
