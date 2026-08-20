import { describe, expect, it, vi } from "vitest";

import { ScryRepository } from "../src/access/index.js";

const principal = {
  kind: "user" as const,
  subject: "user",
  userId: "11111111-1111-4111-8111-111111111111",
  email: "user@example.test",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "member" as const,
};
const context = {
  missionId: "55555555-5555-4555-8555-555555555555",
  objectiveId: "66666666-6666-4666-8666-666666666666",
  agentSessionId: "77777777-7777-4777-8777-777777777777",
};
const database = (query: ReturnType<typeof vi.fn>) => ({
  query,
  transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
});
const policy = {
  allowedOrigins: ["https://example.test"],
  trustedScriptOrigins: [],
  allowPrivateNetwork: false,
  allowDownloads: false as const,
  allowPopups: false as const,
  maxActions: 10,
  maxDurationMs: 30_000,
  maxNavigations: 5,
};

describe("project credential creation", () => {
  it("lists bounded Project-safe metadata with truncation and no protected columns", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: `credential-${index}`,
      referenceId: `credential-${index}`,
      projectId: "44444444-4444-4444-8444-444444444444",
      name: `Credential ${index}`,
      securityStatus: index === 0 ? "revoked" : "active",
      eligibleForAuthorization: index !== 0,
      authorizedEnvironmentIds: [],
      authorizedEnvironmentIdsTruncated: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }));
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: rows.length, rows });
    const repository = new ScryRepository(database(query) as never);
    const result = await repository.listCredentialCandidates(
      principal,
      "44444444-4444-4444-8444-444444444444",
    );
    expect(result).toMatchObject({ truncated: true });
    expect(result.items).toHaveLength(100);
    expect(result.items[0]).toMatchObject({
      securityStatus: "revoked",
      eligibleForAuthorization: false,
      authorizedEnvironmentIdsTruncated: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /ciphertext|authenticationTag|initializationVector|value/,
    );
    expect(String(query.mock.calls[1]?.[0])).toContain("LIMIT 101");
  });

  it("creates a reusable Project credential without Mission state", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            projectId: "44444444-4444-4444-8444-444444444444",
            name: "Reusable login",
            securityStatus: "active",
            eligibleForAuthorization: true,
            authorizedEnvironmentIds: [],
            authorizedEnvironmentIdsTruncated: false,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      });
    const repository = new ScryRepository(database(query) as never);
    const created = await repository.createCredential(
      principal,
      "44444444-4444-4444-8444-444444444444",
      {
        name: "Reusable login",
        value: "dashboard-only-canary",
      },
    );
    expect(created).toMatchObject({ name: "Reusable login", securityStatus: "active" });
    expect(query).toHaveBeenCalledTimes(2);
    const insert = String(query.mock.calls[1]?.[0]);
    expect(insert).toContain("origin_mission_id");
    expect(query.mock.calls[1]?.[1]?.slice(-3)).toEqual([null, null, null]);
    expect(JSON.stringify(query.mock.calls)).not.toContain("dashboard-only-canary");
  });

  it("encrypts the supplied value and returns metadata only", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            projectId: "44444444-4444-4444-8444-444444444444",
            name: "Preview password",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const repository = new ScryRepository(database(query) as never);

    const created = await repository.createCredential(
      principal,
      "44444444-4444-4444-8444-444444444444",
      {
        ...context,
        name: "Preview password",
        value: "plaintext-canary",
      },
    );

    expect(created).not.toHaveProperty("value");
    expect(JSON.stringify(query.mock.calls)).not.toContain("plaintext-canary");
  });

  it("keeps agent provenance activity in the credential creation transaction", async () => {
    const outerQuery = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{}] });
    const transactionalQuery = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "33333333-3333-4333-8333-333333333333" }],
      })
      .mockRejectedValueOnce(new Error("activity unavailable"));
    const transaction = vi.fn(
      async (work: (client: { query: typeof transactionalQuery }) => unknown) =>
        work({ query: transactionalQuery }),
    );
    const repository = new ScryRepository({ query: outerQuery, transaction } as never);
    await expect(
      repository.createCredential(principal, "44444444-4444-4444-8444-444444444444", {
        ...context,
        name: "Atomic provenance",
        value: "transaction-canary",
      }),
    ).rejects.toThrow("activity unavailable");
    expect(transaction).toHaveBeenCalledOnce();
    expect(transactionalQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      expect.stringContaining("FROM missions"),
      expect.stringContaining("INSERT INTO project_credentials"),
      expect.stringContaining("INSERT INTO mission_activities"),
    ]);
  });

  it("returns a typed conflict instead of overwriting an existing credential", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
      .mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "23505" }));
    const repository = new ScryRepository(database(query) as never);

    await expect(
      repository.createCredential(principal, "44444444-4444-4444-8444-444444444444", {
        ...context,
        name: "Preview password",
        value: "replacement-must-not-win",
      }),
    ).rejects.toMatchObject({
      response: {
        code: "CREDENTIAL_NAME_CONFLICT",
        message:
          "An active credential with this name already exists. Existing credentials cannot be overwritten.",
      },
    });
  });

  it("rejects an authorized environment reference when the credential is not active", async () => {
    const credentialId = "33333333-3333-4333-8333-333333333333";
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ secretRefs: [credentialId] }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const repository = new ScryRepository({ query } as never);
    await expect(
      repository.validateCredentialReferences(principal, "88888888-8888-4888-8888-888888888888", {
        projectId: "44444444-4444-4444-8444-444444444444",
        secretRefs: [credentialId],
      }),
    ).resolves.toMatchObject({ valid: false, errors: [{ code: "CREDENTIAL_UNAVAILABLE" }] });
    expect(String(query.mock.calls[2]?.[0])).toContain("security_status='active'");
  });

  it("rejects non-active credentials on both environment authorization write paths", async () => {
    const credentialId = "33333333-3333-4333-8333-333333333333";
    const projectId = "44444444-4444-4444-8444-444444444444";
    const createQuery = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const createRepository = new ScryRepository(database(createQuery) as never);
    await expect(
      createRepository.createEnvironment(principal, projectId, {
        ...context,
        name: "Protected",
        baseOrigin: "https://example.test",
        policy,
        secretRefs: [credentialId],
      }),
    ).rejects.toThrow("invalid or unavailable");
    expect(String(createQuery.mock.calls[2]?.[0])).toContain("security_status='active'");

    const updateQuery = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ projectId, policy }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const updateRepository = new ScryRepository(database(updateQuery) as never);
    await expect(
      updateRepository.updateEnvironment(principal, "88888888-8888-4888-8888-888888888888", {
        ...context,
        baseOrigin: "https://example.test",
        policy,
        secretRefs: [credentialId],
      }),
    ).rejects.toThrow("invalid or unavailable");
    expect(String(updateQuery.mock.calls[2]?.[0])).toContain("security_status='active'");
  });
});
