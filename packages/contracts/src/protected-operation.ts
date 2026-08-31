import { z } from "zod";

export const protectedOperationOwnerKindSchema = z.enum(["authoring_session", "run"]);

const safeReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const sha256CommitmentSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const protectedOperationStateSchema = z.enum([
  "reserved",
  "planned",
  "preparing",
  "ready_to_dispatch",
  "dispatching",
  "dispatched",
  "acquiring",
  "persisting",
  "persisted",
  "reconciling",
  "completed",
  "failed_not_applied",
  "recovery_required",
  "compromised",
  "revoked",
  "abandoned",
]);

export type ProtectedOperationState = z.infer<typeof protectedOperationStateSchema>;
export type ProtectedOperationOwnerKind = z.infer<typeof protectedOperationOwnerKindSchema>;

export const mutationReceiptSchema = z
  .object({
    receiptId: z.string().uuid(),
    operationId: z.string().trim().min(1).max(200),
    owner: z.object({ kind: protectedOperationOwnerKindSchema, id: z.string().uuid() }).strict(),
    correlation: z
      .object({
        projectId: z.string().uuid(),
        environmentId: z.string().uuid(),
        missionId: z.string().uuid(),
        objectiveId: z.string().uuid(),
        agentSessionId: z.string().uuid(),
        runId: z.string().uuid().optional(),
        praxisSessionId: z.string().uuid().optional(),
      })
      .strict(),
    operationClass: z.enum(["protected_mutation", "protected_read"]),
    commitments: z
      .object({
        program: sha256CommitmentSchema.nullable(),
        syntheticInputSet: sha256CommitmentSchema.nullable(),
        payload: sha256CommitmentSchema.nullable(),
        providerIdempotency: sha256CommitmentSchema.nullable(),
      })
      .strict(),
    preflight: z
      .object({
        state: z.enum(["not_started", "running", "validated", "failed"]),
        observedAt: z.string().datetime().optional(),
        reasonCode: safeReasonCodeSchema.optional(),
      })
      .strict(),
    dispatch: z
      .object({
        state: z.enum(["not_started", "authorized", "started", "acknowledged"]),
        armedAt: z.string().datetime().optional(),
      })
      .strict(),
    request: z
      .object({
        methodClass: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        endpointClass: z.string().startsWith("/").max(500).optional(),
        transportClasses: z.array(z.enum(["document", "fetch", "xhr"])).max(3),
        initiationObservedAt: z.string().datetime().optional(),
        ownedResponseObservedAt: z.string().datetime().optional(),
        responseEventObserved: z.boolean(),
        ownershipProof: z.enum(["not_started", "no_request", "unique", "ambiguous", "rejected"]),
      })
      .strict(),
    responseIdentities: z.array(
      z
        .object({
          bindingId: z.string().uuid(),
          publicValueId: z.string().uuid().optional(),
          provider: z.string().trim().min(1).max(100),
          resourceKind: z.string().trim().min(1).max(100),
          resourceScope: z.string().trim().min(1).max(500),
          identityContractVersion: z.number().int().min(1).max(1_000),
          provenance: z.enum(["response", "unavailable"]),
          lifecycleState: z.enum(["active", "unavailable", "invalidated", "desynchronized"]),
        })
        .strict(),
    ),
    persistence: z
      .object({
        state: z.enum(["not_started", "running", "committed", "failed", "uncertain"]),
        references: z.array(
          z
            .object({
              reference: z.string().trim().min(1).max(200),
              classification: z.enum(["public", "protected"]),
              credentialId: z.string().uuid().optional(),
              valueId: z.string().uuid().optional(),
              valueAssetId: z.string().uuid().optional(),
              scope: z.enum(["run", "project"]),
            })
            .strict(),
        ),
      })
      .strict(),
    mutationOutcome: z.enum(["not_attempted", "not_applied", "applied", "unknown"]),
    reconciliation: z
      .object({
        strategy: z.enum([
          "none",
          "persisted_outputs",
          "public_ui_state",
          "public_api_state",
          "adapter",
          "unknown",
        ]),
        state: z.enum([
          "not_configured",
          "pending",
          "proven_applied",
          "proven_not_applied",
          "unknown",
          "failed",
        ]),
        observations: z.array(
          z
            .object({
              observedAt: z.string().datetime(),
              result: z.enum([
                "not_configured",
                "pending",
                "proven_applied",
                "proven_not_applied",
                "unknown",
                "failed",
              ]),
              reasonCode: safeReasonCodeSchema.optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    redispatchAllowed: z.boolean(),
    reasonCodes: z.array(safeReasonCodeSchema).max(100),
    transitions: z.array(
      z
        .object({
          sequence: z.number().int().positive(),
          fromState: protectedOperationStateSchema.nullable(),
          toState: protectedOperationStateSchema,
          phase: z.string().trim().min(1).max(100),
          reasonCode: safeReasonCodeSchema.optional(),
          occurredAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.mutationOutcome === "unknown" && receipt.redispatchAllowed)
      context.addIssue({
        code: "custom",
        path: ["redispatchAllowed"],
        message: "unknown mutation truth cannot permit redispatch",
      });
  });

export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;

export type MutationReceiptProjectionSource = {
  receiptId: string;
  operationId: string;
  ownerKind: ProtectedOperationOwnerKind;
  ownerId: string;
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  runId?: string;
  praxisSessionId?: string;
  dispatchSemantics: "mutation" | "read_only";
  authorityModel?: "legacy" | "canonical";
  programDigest: string | null;
  syntheticInputSetCommitment: string | null;
  payloadCommitment: string | null;
  providerIdempotencyCommitment: string | null;
  state: ProtectedOperationState;
  dispatchState: "not_started" | "authorized" | "started" | "acknowledged";
  mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown";
  persistenceState: "not_started" | "running" | "committed" | "failed" | "uncertain";
  persistedReferences: Record<
    string,
    {
      classification: "public" | "protected";
      credentialId?: string;
      valueId?: string;
      valueAssetId?: string;
      scope: "run" | "project";
    }
  >;
  failureCode: string | null;
  transitions: Array<{
    sequence: number;
    fromState: ProtectedOperationState | null;
    toState: ProtectedOperationState;
    phase: string;
    reasonCode: string | null;
    safeDiagnostics: Record<string, unknown>;
    occurredAt: string;
  }>;
  responseIdentities: Array<{
    bindingId: string;
    publicValueId: string | null;
    provider: string;
    resourceKind: string;
    resourceScope: string;
    identityContractVersion: number;
    identitySource: "response" | null;
    lifecycleState: "active" | "unavailable" | "invalidated" | "desynchronized";
  }>;
};

/** Pure projection over authoritative protected-operation state and append-only evidence. */
export function projectMutationReceipt(source: MutationReceiptProjectionSource): MutationReceipt {
  const transitions = [...source.transitions].sort((left, right) => left.sequence - right.sequence);
  const findPhase = (phase: string) => transitions.find((item) => item.phase === phase);
  const ready = findPhase("ready_to_dispatch");
  const preflightFailure = transitions.find(
    (item) => item.toState === "failed_not_applied" && !ready,
  );
  const preparing = transitions.find((item) => item.toState === "preparing");
  const armed = transitions.find((item) => item.toState === "dispatching");
  const initiated = findPhase("request_initiated");
  const requestContract = transitions
    .map(({ safeDiagnostics }) => objectValue(safeDiagnostics.requestContract))
    .find(Boolean);
  const responseEvidence = [...transitions]
    .reverse()
    .map(({ safeDiagnostics }) => objectValue(safeDiagnostics.responseEvidence))
    .find(Boolean);
  const ownedResponse = transitions.find(({ safeDiagnostics }) => {
    const evidence = objectValue(safeDiagnostics.responseEvidence);
    return evidence?.eligibleResponseSelected === true && evidence.ownershipStatus === "unique";
  });
  const observedRequest = objectValue(initiated?.safeDiagnostics.mutation);
  const observedRequestFacts = objectValue(observedRequest?.request);
  const declaredTransports = Array.isArray(requestContract?.transports)
    ? requestContract.transports.filter(isReceiptTransport)
    : [];
  const observedTransport = isReceiptTransport(observedRequestFacts?.transport)
    ? [observedRequestFacts.transport]
    : [];
  const reconciliationStrategy = transitions
    .map(({ safeDiagnostics }) => safeDiagnostics.reconciliationStrategy)
    .find(isReconciliationStrategy);
  const observations = transitions.flatMap((item) => {
    const result = reconciliationResult(item.safeDiagnostics.reconciliation, item.phase);
    return result
      ? [
          {
            observedAt: item.occurredAt,
            result,
            ...(validReasonCode(item.reasonCode) ? { reasonCode: item.reasonCode } : {}),
          },
        ]
      : [];
  });
  const reconciliationState = deriveReconciliationState(source, observations.at(-1)?.result);
  const reasonCodes = [
    source.failureCode,
    ...transitions.map(({ reasonCode }) => reasonCode),
  ].filter(validReasonCode);

  return mutationReceiptSchema.parse({
    receiptId: source.receiptId,
    operationId: source.operationId,
    owner: { kind: source.ownerKind, id: source.ownerId },
    correlation: {
      projectId: source.projectId,
      environmentId: source.environmentId,
      missionId: source.missionId,
      objectiveId: source.objectiveId,
      agentSessionId: source.agentSessionId,
      ...(source.runId ? { runId: source.runId } : {}),
      ...(source.praxisSessionId ? { praxisSessionId: source.praxisSessionId } : {}),
    },
    operationClass:
      source.dispatchSemantics === "read_only" ? "protected_read" : "protected_mutation",
    commitments: {
      program: source.programDigest,
      syntheticInputSet: source.syntheticInputSetCommitment,
      payload: source.payloadCommitment,
      providerIdempotency: source.providerIdempotencyCommitment,
    },
    preflight: preflightFailure
      ? {
          state: "failed",
          observedAt: preflightFailure.occurredAt,
          ...(validReasonCode(preflightFailure.reasonCode)
            ? { reasonCode: preflightFailure.reasonCode }
            : {}),
        }
      : ready
        ? { state: "validated", observedAt: ready.occurredAt }
        : preparing
          ? { state: "running", observedAt: preparing.occurredAt }
          : { state: "not_started" },
    dispatch: {
      state: source.dispatchState,
      ...(armed ? { armedAt: armed.occurredAt } : {}),
    },
    request: {
      ...(isReceiptMethod(requestContract?.method)
        ? { methodClass: requestContract.method }
        : isReceiptMethod(observedRequestFacts?.method)
          ? { methodClass: observedRequestFacts.method }
          : {}),
      ...(typeof requestContract?.pathTemplate === "string"
        ? { endpointClass: requestContract.pathTemplate }
        : {}),
      transportClasses: [...new Set([...declaredTransports, ...observedTransport])],
      ...(initiated ? { initiationObservedAt: initiated.occurredAt } : {}),
      ...(ownedResponse ? { ownedResponseObservedAt: ownedResponse.occurredAt } : {}),
      responseEventObserved: responseEvidence?.responseEventObserved === true,
      ownershipProof: isOwnershipProof(responseEvidence?.ownershipStatus)
        ? responseEvidence.ownershipStatus
        : "not_started",
    },
    responseIdentities: source.responseIdentities.map((identity) => ({
      bindingId: identity.bindingId,
      ...(identity.publicValueId ? { publicValueId: identity.publicValueId } : {}),
      provider: identity.provider,
      resourceKind: identity.resourceKind,
      resourceScope: identity.resourceScope,
      identityContractVersion: identity.identityContractVersion,
      provenance: identity.identitySource ?? "unavailable",
      lifecycleState: identity.lifecycleState,
    })),
    persistence: {
      state: source.persistenceState,
      references: Object.entries(source.persistedReferences).map(([reference, value]) => ({
        reference,
        ...value,
      })),
    },
    mutationOutcome: source.mutationOutcome,
    reconciliation: {
      strategy: reconciliationStrategy ?? "unknown",
      state: reconciliationState,
      observations,
    },
    // A canonical capability is single-use even when its operation is read-only.
    // Historical receipts retain their historical projection, never new authority.
    redispatchAllowed:
      source.authorityModel !== "canonical" && source.mutationOutcome === "not_applied",
    reasonCodes: [...new Set(reasonCodes)],
    transitions: transitions.map(
      ({ sequence, fromState, toState, phase, reasonCode, occurredAt }) => ({
        sequence,
        fromState,
        toState,
        phase,
        ...(validReasonCode(reasonCode) ? { reasonCode } : {}),
        occurredAt,
      }),
    ),
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value);
}

function isReceiptMethod(value: unknown): value is "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(value));
}

function isReceiptTransport(value: unknown): value is "document" | "fetch" | "xhr" {
  return ["document", "fetch", "xhr"].includes(String(value));
}

function isOwnershipProof(
  value: unknown,
): value is "not_started" | "no_request" | "unique" | "ambiguous" | "rejected" {
  return ["not_started", "no_request", "unique", "ambiguous", "rejected"].includes(String(value));
}

function isReconciliationStrategy(
  value: unknown,
): value is "none" | "persisted_outputs" | "public_ui_state" | "public_api_state" | "adapter" {
  return ["none", "persisted_outputs", "public_ui_state", "public_api_state", "adapter"].includes(
    String(value),
  );
}

function reconciliationResult(value: unknown, phase: string) {
  if (value === "succeeded") return "proven_applied" as const;
  if (value === "not_applied") return "proven_not_applied" as const;
  if (value === "unknown") return "unknown" as const;
  if (value === "failed") return "failed" as const;
  if (value === "not_configured") return "not_configured" as const;
  if (phase === "reconciliation" || phase === "reconciling") return "pending" as const;
  return undefined;
}

function deriveReconciliationState(
  source: MutationReceiptProjectionSource,
  observed: MutationReceipt["reconciliation"]["state"] | undefined,
): MutationReceipt["reconciliation"]["state"] {
  if (source.dispatchState === "not_started" || source.dispatchState === "authorized")
    return "not_configured";
  if (source.mutationOutcome === "applied") return "proven_applied";
  if (source.mutationOutcome === "not_applied") return "proven_not_applied";
  if (source.mutationOutcome === "unknown") return "unknown";
  if (source.state === "reconciling") return "pending";
  return observed ?? "not_configured";
}

export type ProtectedOperationClaim = {
  id: string;
  state: ProtectedOperationState;
  version: number;
  fencingToken: number;
  mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown";
  persistedReferences?: Record<
    string,
    {
      classification: "public" | "protected";
      credentialId?: string;
      valueId?: string;
      valueAssetId?: string;
      scope: "run" | "project";
    }
  >;
};

export type ProtectedTransactionStore = {
  claim(input: {
    operationId: string;
    mutationKind: "one_time" | "repeatable";
    dispatchSemantics?: "mutation" | "read_only";
    programDigest: string;
    inputSchemaDigest: string;
    inputDigest: string;
    mutationIdentity: string;
    preparedExecutionCapabilityId?: string;
    safeOutputManifest: Array<{
      reference: string;
      classification: "public" | "protected";
      storageName: string;
    }>;
  }): Promise<ProtectedOperationClaim>;
  transition(input: {
    id: string;
    operationId: string;
    version: number;
    fencingToken: number;
    expected: ProtectedOperationState;
    next: ProtectedOperationState;
    phase: string;
    reasonCode?: string;
    facts?: Record<string, unknown>;
  }): Promise<ProtectedOperationClaim>;
  record(input: {
    operationId: string;
    fencingToken: number;
    phase: string;
    facts?: Record<string, unknown>;
  }): Promise<void>;
  settleMutationOutcome(input: {
    id: string;
    operationId: string;
    version: number;
    fencingToken: number;
    outcome: "applied" | "not_applied";
  }): Promise<ProtectedOperationClaim>;
  heartbeat?(claim: ProtectedOperationClaim): Promise<void>;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
};

const transitions = {
  reserved: ["planned", "failed_not_applied"],
  planned: ["preparing", "failed_not_applied"],
  preparing: ["ready_to_dispatch", "failed_not_applied"],
  ready_to_dispatch: ["dispatching", "failed_not_applied"],
  dispatching: ["dispatched", "failed_not_applied", "recovery_required"],
  dispatched: ["acquiring", "failed_not_applied", "recovery_required"],
  acquiring: ["persisting", "failed_not_applied", "recovery_required", "compromised"],
  persisting: ["persisted", "failed_not_applied", "recovery_required", "compromised"],
  persisted: ["reconciling", "failed_not_applied", "recovery_required"],
  reconciling: ["completed", "failed_not_applied", "recovery_required", "compromised"],
  recovery_required: ["acquiring", "reconciling", "compromised", "revoked", "abandoned"],
  compromised: ["revoked", "abandoned"],
  completed: [],
  failed_not_applied: [],
  revoked: [],
  abandoned: [],
} as const satisfies Record<ProtectedOperationState, readonly ProtectedOperationState[]>;

export const protectedOperationTerminalStates = new Set<ProtectedOperationState>([
  "completed",
  "failed_not_applied",
  "revoked",
  "abandoned",
]);

export function canTransitionProtectedOperation(
  current: ProtectedOperationState,
  next: ProtectedOperationState,
) {
  return (transitions[current] as readonly ProtectedOperationState[]).includes(next);
}

export function assertProtectedOperationTransition(
  current: ProtectedOperationState,
  next: ProtectedOperationState,
) {
  if (!canTransitionProtectedOperation(current, next)) {
    throw new Error(`PROTECTED_OPERATION_TRANSITION_INVALID:${current}:${next}`);
  }
}

export function protectedOperationDispatchMayBegin(
  current: ProtectedOperationState,
  next: ProtectedOperationState,
) {
  return current === "ready_to_dispatch" && next === "dispatching";
}

export function protectedOperationLeaseExpiryState(
  current: ProtectedOperationState,
  dispatchSemantics: "mutation" | "read_only" = "mutation",
) {
  if (["reserved", "planned", "preparing", "ready_to_dispatch"].includes(current)) return current;
  if (protectedOperationTerminalStates.has(current) || current === "compromised") return current;
  if (dispatchSemantics === "read_only") return "failed_not_applied" as const;
  return "recovery_required" as const;
}
