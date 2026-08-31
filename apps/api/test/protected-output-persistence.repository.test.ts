import { describe, expect, it, vi } from "vitest";

import { ProtectedOutputPersistenceRepository } from "../src/runtime/repositories/protected-output-persistence.repository.js";

const context = {
  protectedOperationId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  environmentId: "33333333-3333-4333-8333-333333333333",
  missionId: "44444444-4444-4444-8444-444444444444",
  objectiveId: "55555555-5555-4555-8555-555555555555",
  agentSessionId: "66666666-6666-4666-8666-666666666666",
  ownerKind: "authoring_session" as const,
  ownerId: "77777777-7777-4777-8777-777777777777",
  operationId: "generate-once",
  leaseOwner: "worker-a",
  fencingToken: 3,
  version: 7,
};

function outputs() {
  return [
    {
      reference: "clientSecret",
      classification: "protected" as const,
      storageName: "Qualification secret",
      value: "synthetic-canary-never-log",
      scope: "project" as const,
    },
    {
      reference: "clientId",
      classification: "public" as const,
      storageName: "Qualification client ID",
      value: "public-client-id",
      scope: "project" as const,
    },
  ];
}

function harness(failPattern?: RegExp, preparedManifest = false, canonical = false) {
  const committed: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, _values?: unknown[]) => {
      if (failPattern?.test(sql)) throw new Error("INJECTED_DATABASE_FAILURE");
      if (sql.includes('operation.authority_model AS "authorityModel"'))
        return {
          rowCount: 1,
          rows: [
            {
              state: "persisting",
              authorityModel: canonical ? "canonical" : "legacy",
              operationContractRevisionId: canonical
                ? "88888888-8888-4888-8888-888888888888"
                : null,
              applicationKey: canonical ? "example" : null,
              contractFacts: canonical
                ? {
                    response: {
                      outputs: [
                        {
                          key: "clientSecret",
                          classification: "protected",
                          extractor: { kind: "json_path", path: "$.clientSecret" },
                        },
                        {
                          key: "clientId",
                          classification: "public",
                          extractor: { kind: "json_path", path: "$.clientId" },
                          identityRole: "continuation_identity",
                        },
                      ],
                    },
                    resourceEffect: null,
                  }
                : null,
              safeOutputManifest: [
                {
                  [preparedManifest ? "key" : "reference"]: "clientSecret",
                  classification: "protected",
                },
                { [preparedManifest ? "key" : "reference"]: "clientId", classification: "public" },
              ],
            },
          ],
        };
      if (sql.includes("SELECT 1 FROM project_credentials")) return { rowCount: 0, rows: [] };
      if (sql.includes("UPDATE protected_operations SET state='persisted'"))
        return {
          rowCount: 1,
          rows: [
            {
              id: context.protectedOperationId,
              state: "persisted",
              version: "8",
              fencingToken: "3",
              persistedReferences: {},
            },
          ],
        };
      if (sql.includes("SELECT value FROM generated_public_values"))
        return { rowCount: 1, rows: [{ value: "public-client-id" }] };
      if (sql.includes("INSERT INTO project_credentials")) committed.push("credential");
      if (sql.includes("INSERT INTO run_captured_secrets")) committed.push("run-secret");
      if (sql.includes("INSERT INTO generated_public_values")) committed.push("public");
      if (sql.includes("INSERT INTO external_resource_bindings")) committed.push("binding");
      if (sql.includes("INSERT INTO typed_value_assets")) committed.push("asset");
      if (sql.includes("UPDATE environments SET secret_refs")) committed.push("allowlist");
      return { rowCount: 1, rows: [] };
    }),
  };
  const database = {
    transaction: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => {
      const before = [...committed];
      try {
        return await work(client);
      } catch (error) {
        committed.splice(0, committed.length, ...before);
        throw error;
      }
    }),
  };
  return {
    repository: new ProtectedOutputPersistenceRepository(database as never),
    database,
    client,
    committed,
  };
}

describe("atomic protected output persistence", () => {
  it("encrypts a complete response set for crash recovery and never sends plaintext to SQL", async () => {
    let encrypted:
      { ciphertext: Buffer; initializationVector: Buffer; authenticationTag: Buffer } | undefined;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO protected_response_output_staging")) {
        encrypted = {
          ciphertext: values?.[5] as Buffer,
          initializationVector: values?.[6] as Buffer,
          authenticationTag: values?.[7] as Buffer,
        };
        return { rowCount: 1, rows: [{ protected_operation_id: context.protectedOperationId }] };
      }
      if (sql.includes("FROM protected_response_output_staging staged"))
        return { rowCount: 1, rows: [encrypted] };
      return { rowCount: 0, rows: [] };
    });
    const repository = new ProtectedOutputPersistenceRepository({ query } as never);
    const acquired = outputs();
    await repository.stageResponseOutputs(context, acquired);
    expect(acquired.every((output) => output.value === "")).toBe(true);
    expect(JSON.stringify(query.mock.calls)).not.toContain("synthetic-canary-never-log");
    const recovered = await repository.recoverStagedResponseOutputs({
      ...context,
      version: context.version,
    });
    expect(recovered).toMatchObject([
      {
        reference: "clientSecret",
        classification: "protected",
        value: "synthetic-canary-never-log",
      },
      { reference: "clientId", classification: "public", value: "public-client-id" },
    ]);
  });

  it("commits the complete mixed output set and opaque reference map in one transaction", async () => {
    const { repository, database, client, committed } = harness();
    const acquired = outputs();
    const persisted = await repository.persistOutputsAtomically(context, acquired);
    const references = persisted.references;
    expect(database.transaction).toHaveBeenCalledOnce();
    expect(committed).toEqual(["credential", "public"]);
    expect(references.clientSecret).toMatchObject({
      classification: "protected",
      scope: "project",
    });
    expect(references.clientId).toMatchObject({ classification: "public", scope: "project" });
    expect(JSON.stringify(references)).not.toContain("synthetic-canary-never-log");
    expect(JSON.stringify(client.query.mock.calls)).not.toContain("synthetic-canary-never-log");
    expect(acquired.every((output) => output.value === "")).toBe(true);
    expect(
      client.query.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_xact_lock")),
    ).toBe(true);
  });

  it("accepts the canonical key descriptors emitted by prepared reservations", async () => {
    const { repository, committed } = harness(undefined, true);
    await expect(repository.persistOutputsAtomically(context, outputs())).resolves.toBeDefined();
    expect(committed).toEqual(["credential", "public"]);
  });

  it("persists canonical typed assets and output provenance before settlement", async () => {
    const { repository, committed } = harness(undefined, true, true);
    const persisted = await repository.persistOutputsAtomically(context, outputs());
    expect(committed).toEqual(["credential", "asset", "public", "asset"]);
    expect(persisted.references.clientSecret?.valueAssetId).toMatch(/^[a-f0-9-]{36}$/);
    expect(persisted.references.clientId?.valueAssetId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("binds a response-provided project public identity in the same transaction", async () => {
    const { repository, committed, client } = harness();
    await repository.persistOutputsAtomically(context, outputs(), [
      {
        status: "active",
        identityReference: "clientId",
        provider: "provider",
        resourceKind: "credential_record",
        resourceScope: "application-a",
        identityContractVersion: 1,
        identitySource: "response",
        requiredForDestructiveLifecycle: true,
      },
    ]);
    expect(committed).toEqual(["credential", "public", "binding"]);
    const binding = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO external_resource_bindings"),
    );
    expect(binding?.[1]).toContain("public-client-id");
  });

  it("persists an explicit unavailable state for protected-only issuance", async () => {
    const { repository, committed } = harness();
    await repository.persistOutputsAtomically(context, outputs(), [
      {
        status: "unavailable",
        provider: "provider",
        resourceKind: "credential_record",
        resourceScope: "application-a",
        identityContractVersion: 1,
        requiredForDestructiveLifecycle: true,
      },
    ]);
    expect(committed).toEqual(["credential", "public", "binding"]);
  });

  it("rejects arbitrary or protected outputs as binding identity", async () => {
    const { repository, database } = harness();
    await expect(
      repository.persistOutputsAtomically(context, outputs(), [
        {
          status: "active",
          identityReference: "clientSecret",
          provider: "provider",
          resourceKind: "credential_record",
          resourceScope: "application-a",
          identityContractVersion: 1,
          identitySource: "response",
          requiredForDestructiveLifecycle: true,
        },
      ]),
    ).rejects.toThrow("EXTERNAL_RESOURCE_BINDING_PUBLIC_VALUE_REQUIRED");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("rolls back credential, public value, and binding when binding insertion fails", async () => {
    const { repository, committed } = harness(/INSERT INTO external_resource_bindings/);
    await expect(
      repository.persistOutputsAtomically(context, outputs(), [
        {
          status: "active",
          identityReference: "clientId",
          provider: "provider",
          resourceKind: "credential_record",
          resourceScope: "application-a",
          identityContractVersion: 1,
          identitySource: "response",
          requiredForDestructiveLifecycle: true,
        },
      ]),
    ).rejects.toThrow("INJECTED_DATABASE_FAILURE");
    expect(committed).toEqual([]);
  });

  for (const [label, pattern] of [
    ["credential insertion", /INSERT INTO project_credentials/],
    ["public-value insertion", /INSERT INTO generated_public_values/],
  ] as const) {
    it(`rolls back the complete set on ${label} failure`, async () => {
      const { repository, committed } = harness(pattern);
      const acquired = outputs();
      await expect(repository.persistOutputsAtomically(context, acquired)).rejects.toThrow(
        "INJECTED_DATABASE_FAILURE",
      );
      expect(committed).toEqual([]);
      expect(acquired.every((output) => output.value === "")).toBe(true);
    });
  }

  it("commits a mixed Run-scoped output set atomically", async () => {
    const { repository, database, client, committed } = harness();
    const acquired = [
      { ...outputs()[0]!, scope: "run" as const },
      { ...outputs()[1]!, scope: "run" as const },
    ];
    const persisted = await repository.persistOutputsAtomically(
      {
        ...context,
        ownerKind: "run",
        ownerId: "77777777-7777-4777-8777-777777777777",
      },
      acquired,
    );
    expect(database.transaction).toHaveBeenCalledOnce();
    expect(committed).toEqual(["run-secret", "public"]);
    expect(persisted.references).toMatchObject({
      clientSecret: { classification: "protected", scope: "run" },
      clientId: { classification: "public", scope: "run" },
    });
    const publicInsert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO generated_public_values"),
    );
    expect(publicInsert?.[1]).toMatchObject({
      2: context.ownerId,
      3: null,
      4: context.ownerId,
      8: "run",
    });
    expect(acquired.every((output) => output.value === "")).toBe(true);
  });

  it("rolls back every Run output when a later Run value fails", async () => {
    const { repository, committed } = harness(/INSERT INTO generated_public_values/);
    const acquired = [
      { ...outputs()[0]!, scope: "run" as const },
      { ...outputs()[1]!, scope: "run" as const },
    ];
    await expect(
      repository.persistOutputsAtomically(
        {
          ...context,
          ownerKind: "run",
          ownerId: "77777777-7777-4777-8777-777777777777",
        },
        acquired,
      ),
    ).rejects.toThrow("INJECTED_DATABASE_FAILURE");
    expect(committed).toEqual([]);
    expect(acquired.every((output) => output.value === "")).toBe(true);
  });
});
