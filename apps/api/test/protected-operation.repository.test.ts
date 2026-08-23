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
  return { repository: new ProtectedOperationRepository(database as never), client };
}

function runHarness(authorized: boolean) {
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
  };
  const client = {
    query: vi.fn(async (sql: string) =>
      sql.includes("FROM mission_authorizations")
        ? { rowCount: authorized ? 1 : 0, rows: authorized ? [{}] : [] }
        : { rowCount: 1, rows: [row] },
    ),
  };
  const database = {
    transaction: vi.fn((work: (value: typeof client) => unknown) => work(client)),
  };
  return { repository: new ProtectedOperationRepository(database as never), client };
}

describe("protected operation immutable claims", () => {
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

  it("revalidates a run authorization in the claim transaction", async () => {
    const { repository, client } = runHarness(true);
    await repository.claim({
      ownerKind: "run",
      ownerId: randomRunId,
      operationId: "generate",
      leaseOwner: "worker-a",
      leaseDurationMs: 30_000,
      binding: runBinding,
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("operation_id=$5"), [
      binding.authorizationId,
      binding.missionId,
      binding.objectiveId,
      binding.environmentId,
      "generate",
    ]);
  });

  it("refuses an expired, revoked, or cross-scope run authorization before dispatch", async () => {
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
    ).rejects.toThrow("PROTECTED_OPERATION_AUTHORIZATION_INVALID");
  });
});

const randomRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
