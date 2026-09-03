import { describe, expect, it, vi } from "vitest";

import { ProtectedOperationRepository } from "../src/runtime/repositories/protected-operation.repository.js";

const binding = {
  mutationIdentity: "generate-once",
  projectId: "11111111-1111-4111-8111-111111111111",
  environmentId: "22222222-2222-4222-8222-222222222222",
  missionId: "33333333-3333-4333-8333-333333333333",
  objectiveId: "44444444-4444-4444-8444-444444444444",
  agentSessionId: "55555555-5555-4555-8555-555555555555",
  flowDraftId: "66666666-6666-4666-8666-666666666666",
  authorizationId: "77777777-7777-4777-8777-777777777777",
  programDigest: "a".repeat(64),
  safeOutputManifest: [
    {
      reference: "clientSecret",
      classification: "protected" as const,
      storageName: "Client secret",
    },
  ],
};
const { flowDraftId: _flowDraftId, ...bindingWithoutDraft } = binding;
const runBinding = {
  ...bindingWithoutDraft,
  flowRevisionId: "99999999-9999-4999-8999-999999999999",
  preparedExecutionCapabilityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

function harness() {
  const row = {
    id: "88888888-8888-4888-8888-888888888888",
    state: "acquiring",
    phase: "acquisition",
    version: "7",
    fencingToken: "3",
    leaseOwner: "worker-a",
    leaseExpiresAt: new Date(Date.now() + 30_000),
    dispatchState: "acknowledged",
    mutationOutcome: "unknown",
    persistedReferences: {},
    ...binding,
    dispatchSemantics: "mutation",
    flowRevisionId: null,
  };
  const client = { query: vi.fn(async () => ({ rowCount: 1, rows: [row] })) };
  const database = {
    transaction: vi.fn((work: (value: typeof client) => unknown) => work(client)),
  };
  return { repository: new ProtectedOperationRepository(database as never), client, row };
}

function runHarness(capabilityValid: boolean) {
  const row = {
    id: "88888888-8888-4888-8888-888888888888",
    state: "planned",
    phase: "planned",
    version: "1",
    fencingToken: "0",
    leaseOwner: null,
    leaseExpiresAt: null,
    dispatchState: "not_started",
    mutationOutcome: "not_attempted",
    persistedReferences: {},
    ...binding,
    flowDraftId: null,
    flowRevisionId: "99999999-9999-4999-8999-999999999999",
    dispatchSemantics: "mutation",
    authorityModel: "canonical",
    preparedExecutionCapabilityId: runBinding.preparedExecutionCapabilityId,
  };
  const client = {
    query: vi.fn(async (sql: string) =>
      sql.includes("FROM prepared_execution_capabilities")
        ? { rowCount: capabilityValid ? 1 : 0, rows: capabilityValid ? [{}] : [] }
        : { rowCount: 1, rows: [row] },
    ),
  };
  const database = {
    transaction: vi.fn((work: (value: typeof client) => unknown) => work(client)),
  };
  return { repository: new ProtectedOperationRepository(database as never), client };
}

describe("protected operation immutable claims", () => {
  it("refuses an undispatched historical row after the canonical cutoff", async () => {
    const { repository, row } = harness();
    row.state = "planned";
    row.dispatchState = "not_started";
    await expect(
      repository.claim({
        ownerKind: "authoring_session",
        ownerId: "99999999-9999-4999-8999-999999999999",
        operationId: "generate",
        leaseOwner: "old-worker",
        leaseDurationMs: 30_000,
        binding,
      }),
    ).rejects.toThrow("LEGACY_PROTECTED_OPERATION_DISPATCH_FORBIDDEN");
  });

  it("refuses canonical worker admission without the exact prepared capability", async () => {
    const { repository } = runHarness(true);
    const { preparedExecutionCapabilityId: _capability, ...oldBinding } = runBinding;
    await expect(
      repository.claim({
        ownerKind: "run",
        ownerId: randomRunId,
        operationId: "generate",
        leaseOwner: "old-worker",
        leaseDurationMs: 30_000,
        binding: oldBinding,
      }),
    ).rejects.toThrow("PREPARED_EXECUTION_CAPABILITY_REQUIRED");
  });
  it("persists non-state receipt observations as fenced append-only self transitions", async () => {
    const { repository, client } = harness();
    await repository.record({
      id: "88888888-8888-4888-8888-888888888888",
      leaseOwner: "worker-a",
      fencingToken: 3,
      phase: "request_initiated",
      safeDiagnostics: {
        mutation: {
          request: { status: "initiated", method: "POST", transport: "fetch" },
        },
      },
    });

    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO protected_operation_transitions"),
      expect.arrayContaining(["acquiring", "acquiring", "request_initiated"]),
    );
  });

  it("returns an idempotent same-owner claim without rotating its fence", async () => {
    const { repository, client } = harness();
    const claim = await repository.claim({
      ownerKind: "authoring_session",
      ownerId: "99999999-9999-4999-8999-999999999999",
      operationId: "generate",
      leaseOwner: "worker-a",
      leaseDurationMs: 30_000,
      binding,
    });
    expect(claim.fencingToken).toBe(3);
    expect(client.query).toHaveBeenCalledOnce();
  });

  it("rejects changed semantics before lease or dispatch ownership can be reused", async () => {
    const { repository, client } = harness();
    await expect(
      repository.claim({
        ownerKind: "authoring_session",
        ownerId: "99999999-9999-4999-8999-999999999999",
        operationId: "generate",
        leaseOwner: "worker-a",
        leaseDurationMs: 30_000,
        binding: { ...binding, mutationIdentity: "different-mutation" },
      }),
    ).rejects.toThrow("PROTECTED_OPERATION_BINDING_MISMATCH");
    expect(client.query).toHaveBeenCalledOnce();
  });

  it("revalidates the exact finalized prepared capability in the claim transaction", async () => {
    const { repository, client } = runHarness(true);
    await repository.claim({
      ownerKind: "run",
      ownerId: randomRunId,
      operationId: "generate",
      leaseOwner: "worker-a",
      leaseDurationMs: 30_000,
      binding: runBinding,
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM prepared_execution_capabilities"),
      [
        runBinding.preparedExecutionCapabilityId,
        "88888888-8888-4888-8888-888888888888",
        binding.programDigest,
        binding.mutationIdentity,
      ],
    );
    expect(
      client.query.mock.calls.some(([sql]) => sql.includes("FROM mission_authorizations")),
    ).toBe(false);
  });

  it("refuses a missing, expired or non-finalized prepared capability before dispatch", async () => {
    const { repository } = runHarness(false);
    await expect(
      repository.claim({
        ownerKind: "run",
        ownerId: randomRunId,
        operationId: "generate",
        leaseOwner: "worker-a",
        leaseDurationMs: 30_000,
        binding: runBinding,
      }),
    ).rejects.toThrow("PREPARED_EXECUTION_CAPABILITY_INVALID");
  });
});

const randomRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
