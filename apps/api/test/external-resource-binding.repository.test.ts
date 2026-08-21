import { describe, expect, it, vi } from "vitest";

import { ExternalResourceBindingRepository } from "../src/runtime/repositories/external-resource-binding.repository.js";

const input = {
  credentialId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  environmentId: "33333333-3333-4333-8333-333333333333",
  provider: "provider",
  resourceKind: "credential_record",
  resourceScope: "application-a",
};

describe("external resource binding resolution", () => {
  it("returns exactly one ownership-fenced active binding", async () => {
    const binding = {
      sourceProtectedOperationId: "operation",
      ...input,
      externalIdentity: "record-a",
      identityContractVersion: 1,
    };
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({
      rowCount: 1,
      rows: [binding],
    }));
    const database = { query };
    await expect(
      new ExternalResourceBindingRepository(database as never).resolveActiveForCredential(input),
    ).resolves.toEqual(binding);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("credential.security_status='active'");
    expect(sql).toContain("binding.required_for_destructive_lifecycle=true");
    expect(sql).toContain("value.value=binding.canonical_external_identity");
    expect(values).toEqual(Object.values(input));
  });

  it.each([0, 2])("fails closed for %s matching bindings", async (rowCount) => {
    const database = {
      query: vi.fn(async (_sql: string, _values: unknown[]) => ({ rowCount, rows: [] })),
    };
    await expect(
      new ExternalResourceBindingRepository(database as never).resolveActiveForCredential(input),
    ).rejects.toMatchObject({ response: { code: "EXTERNAL_RESOURCE_BINDING_UNAVAILABLE" } });
  });
});
