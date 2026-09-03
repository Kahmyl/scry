import { describe, expect, it } from "vitest";

import {
  mutationReceiptSchema,
  projectMutationReceipt,
  type MutationReceiptProjectionSource,
  type ProtectedOperationState,
} from "../src/index.js";

const ids = {
  receiptId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  environmentId: "44444444-4444-4444-8444-444444444444",
  missionId: "55555555-5555-4555-8555-555555555555",
  objectiveId: "66666666-6666-4666-8666-666666666666",
  agentSessionId: "77777777-7777-4777-8777-777777777777",
  runId: "88888888-8888-4888-8888-888888888888",
  valueId: "99999999-9999-4999-8999-999999999999",
  bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

it("projects canonical typed assets in persisted Run receipts without dropping authority references", () => {
  const references = {
    clientId: {
      classification: "public",
      valueId: ids.valueId,
      valueAssetId: ids.bindingId,
      scope: "project",
    },
    clientSecret: {
      classification: "protected",
      credentialId: ids.valueId,
      valueAssetId: ids.receiptId,
      scope: "project",
    },
  };
  const receipt = projectMutationReceipt(
    source({
      state: "completed",
      persistenceState: "committed",
      persistedReferences: references as never,
    }),
  );
  expect(receipt.persistence.references).toEqual(
    Object.entries(references).map(([reference, value]) => ({ reference, ...value })),
  );
});

function transition(
  sequence: number,
  fromState: ProtectedOperationState | null,
  toState: ProtectedOperationState,
  phase: string,
  safeDiagnostics: Record<string, unknown> = {},
  reasonCode: string | null = null,
) {
  return {
    sequence,
    fromState,
    toState,
    phase,
    reasonCode,
    safeDiagnostics,
    occurredAt: new Date(sequence * 1_000).toISOString(),
  };
}

function source(
  override: Partial<MutationReceiptProjectionSource> = {},
): MutationReceiptProjectionSource {
  return {
    receiptId: ids.receiptId,
    operationId: "create-client",
    ownerKind: "authoring_session",
    ownerId: ids.ownerId,
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    missionId: ids.missionId,
    objectiveId: ids.objectiveId,
    agentSessionId: ids.agentSessionId,
    runId: ids.runId,
    praxisSessionId: ids.ownerId,
    dispatchSemantics: "mutation",
    programDigest: "a".repeat(64),
    syntheticInputSetCommitment: "b".repeat(64),
    payloadCommitment: "c".repeat(64),
    providerIdempotencyCommitment: null,
    state: "planned",
    dispatchState: "not_started",
    mutationOutcome: "not_attempted",
    persistenceState: "not_started",
    persistedReferences: {},
    failureCode: null,
    transitions: [transition(1, null, "planned", "planned")],
    responseIdentities: [],
    ...override,
  };
}

const ready = [
  transition(1, null, "planned", "planned"),
  transition(2, "planned", "preparing", "preparation"),
  transition(3, "preparing", "ready_to_dispatch", "ready_to_dispatch"),
  transition(4, "ready_to_dispatch", "ready_to_dispatch", "dispatch_authorized", {
    requestContract: {
      method: "POST",
      pathTemplate: "/clients/{clientId}",
      transports: ["fetch"],
    },
    reconciliationStrategy: "public_api_state",
    ignoredSecret: "super-secret-never-project",
  }),
];
const dispatched = [
  ...ready,
  transition(5, "ready_to_dispatch", "dispatching", "mutation_dispatching"),
];
const initiated = [
  ...dispatched,
  transition(6, "dispatching", "dispatching", "request_initiated", {
    mutation: {
      request: { status: "initiated", method: "POST", transport: "fetch", envelopeMatched: true },
    },
  }),
];
const ownedResponse = [
  ...initiated,
  transition(7, "dispatching", "dispatching", "response_settled", {
    responseEvidence: {
      responseEventObserved: true,
      eligibleResponseSelected: true,
      ownershipStatus: "unique",
      rawBody: "super-secret-never-project",
    },
  }),
  transition(8, "dispatching", "dispatched", "mutation_dispatched"),
];

describe("defensible mutation receipt projection", () => {
  it.each(["mutation", "read_only"] as const)(
    "never offers replay of a canonical %s capability",
    (dispatchSemantics) => {
      expect(
        projectMutationReceipt(
          source({
            authorityModel: "canonical",
            dispatchSemantics,
            state: "completed",
            mutationOutcome: "not_applied",
          }),
        ).redispatchAllowed,
      ).toBe(false);
    },
  );
  it.each([
    {
      name: "pre-send failure",
      input: source({
        state: "failed_not_applied",
        mutationOutcome: "not_applied",
        failureCode: "PREFLIGHT_FAILED",
        transitions: [
          transition(1, null, "planned", "planned"),
          transition(2, "planned", "preparing", "preparation"),
          transition(
            3,
            "preparing",
            "failed_not_applied",
            "failed_not_applied",
            {},
            "PREFLIGHT_FAILED",
          ),
        ],
      }),
      expected: {
        mutationOutcome: "not_applied",
        redispatchAllowed: true,
        preflight: { state: "failed" },
        dispatch: { state: "not_started" },
      },
    },
    {
      name: "after initiation before response",
      input: source({
        state: "recovery_required",
        dispatchState: "started",
        mutationOutcome: "unknown",
        transitions: [
          ...initiated,
          transition(
            7,
            "dispatching",
            "recovery_required",
            "recovery_required",
            {},
            "PROTECTED_RESPONSE_TIMEOUT",
          ),
        ],
      }),
      expected: {
        mutationOutcome: "unknown",
        redispatchAllowed: false,
        request: { responseEventObserved: false, ownershipProof: "not_started" },
      },
    },
    {
      name: "after response before persistence",
      input: source({
        state: "acquiring",
        dispatchState: "acknowledged",
        mutationOutcome: "unknown",
        transitions: [
          ...ownedResponse,
          transition(9, "dispatched", "acquiring", "acquisition_running"),
        ],
      }),
      expected: {
        mutationOutcome: "unknown",
        persistence: { state: "not_started" },
        request: { responseEventObserved: true, ownershipProof: "unique" },
      },
    },
    {
      name: "after persistence before final acknowledgement",
      input: source({
        state: "persisted",
        dispatchState: "acknowledged",
        mutationOutcome: "unknown",
        persistenceState: "committed",
        persistedReferences: {
          clientId: { classification: "public", valueId: ids.valueId, scope: "project" },
        },
        transitions: [
          ...ownedResponse,
          transition(9, "dispatched", "acquiring", "acquisition_running"),
          transition(10, "acquiring", "persisting", "persistence_running"),
          transition(11, "persisting", "persisted", "persistence_committed"),
        ],
      }),
      expected: {
        mutationOutcome: "unknown",
        redispatchAllowed: false,
        persistence: { state: "committed" },
      },
    },
    {
      name: "lease loss before dispatch",
      input: source({
        state: "preparing",
        transitions: [
          transition(1, null, "planned", "planned"),
          transition(2, "planned", "preparing", "preparation"),
        ],
      }),
      expected: {
        mutationOutcome: "not_attempted",
        redispatchAllowed: false,
        dispatch: { state: "not_started" },
      },
    },
    {
      name: "lease loss after possible dispatch",
      input: source({
        state: "recovery_required",
        dispatchState: "started",
        mutationOutcome: "unknown",
        failureCode: "PROTECTED_OPERATION_LEASE_EXPIRED",
        transitions: [
          ...dispatched,
          transition(
            6,
            "dispatching",
            "recovery_required",
            "lease_expired",
            {},
            "PROTECTED_OPERATION_LEASE_EXPIRED",
          ),
        ],
      }),
      expected: { mutationOutcome: "unknown", redispatchAllowed: false },
    },
    {
      name: "reconciliation proves applied",
      input: source({
        state: "completed",
        dispatchState: "acknowledged",
        mutationOutcome: "applied",
        persistenceState: "committed",
        transitions: [
          ...ownedResponse,
          transition(9, "persisted", "reconciling", "reconciliation"),
          transition(10, "reconciling", "reconciling", "completed", {
            reconciliation: "succeeded",
          }),
          transition(11, "reconciling", "completed", "completed"),
        ],
      }),
      expected: {
        mutationOutcome: "applied",
        redispatchAllowed: false,
        reconciliation: { state: "proven_applied" },
      },
    },
    {
      name: "reconciliation proves not applied",
      input: source({
        state: "failed_not_applied",
        dispatchState: "acknowledged",
        mutationOutcome: "not_applied",
        transitions: [
          ...ownedResponse,
          transition(9, "persisted", "reconciling", "reconciliation"),
          transition(10, "reconciling", "reconciling", "failed_not_applied", {
            reconciliation: "not_applied",
          }),
          transition(11, "reconciling", "failed_not_applied", "failed_not_applied"),
        ],
      }),
      expected: {
        mutationOutcome: "not_applied",
        redispatchAllowed: true,
        reconciliation: { state: "proven_not_applied" },
      },
    },
    {
      name: "reconciliation remains unknown",
      input: source({
        state: "recovery_required",
        dispatchState: "acknowledged",
        mutationOutcome: "unknown",
        transitions: [
          ...ownedResponse,
          transition(9, "persisted", "reconciling", "reconciliation"),
          transition(10, "reconciling", "recovery_required", "recovery_required", {
            reconciliation: "unknown",
          }),
        ],
      }),
      expected: {
        mutationOutcome: "unknown",
        redispatchAllowed: false,
        reconciliation: { state: "unknown" },
      },
    },
    {
      name: "late stale evidence cannot overwrite terminal truth",
      input: source({
        state: "completed",
        dispatchState: "acknowledged",
        mutationOutcome: "applied",
        transitions: [
          ...ownedResponse,
          transition(9, "reconciling", "completed", "completed"),
          transition(10, "completed", "completed", "late_worker_ignored", {
            reconciliation: "not_applied",
          }),
        ],
      }),
      expected: {
        mutationOutcome: "applied",
        redispatchAllowed: false,
        reconciliation: { state: "proven_applied" },
      },
    },
  ])("projects truthful chronology for $name", ({ input, expected }) => {
    const receipt = projectMutationReceipt(input);
    expect(receipt).toMatchObject(expected);
    expect(mutationReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("super-secret-never-project");
  });

  it("returns response provenance and reference identities without the provider identity value", () => {
    const receipt = projectMutationReceipt(
      source({
        state: "persisted",
        dispatchState: "acknowledged",
        mutationOutcome: "unknown",
        persistenceState: "committed",
        transitions: ownedResponse,
        responseIdentities: [
          {
            bindingId: ids.bindingId,
            publicValueId: ids.valueId,
            provider: "provider",
            resourceKind: "client",
            resourceScope: "sandbox",
            identityContractVersion: 1,
            identitySource: "response",
            lifecycleState: "active",
          },
        ],
      }),
    );
    expect(receipt.responseIdentities[0]).toEqual({
      bindingId: ids.bindingId,
      publicValueId: ids.valueId,
      provider: "provider",
      resourceKind: "client",
      resourceScope: "sandbox",
      identityContractVersion: 1,
      provenance: "response",
      lifecycleState: "active",
    });
    expect(receipt.responseIdentities[0]).not.toHaveProperty("canonicalExternalIdentity");
  });
});
