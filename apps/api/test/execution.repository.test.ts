import { describe, expect, it, vi } from "vitest";

import { encryptCredential } from "../src/credential.crypto.js";
import { ExecutionRepository } from "../src/execution.repository.js";

describe("protected execution credentials", () => {
  it("resolves a credential only through the run's immutable allowlist", async () => {
    const encrypted = encryptCredential("allowed-secret");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [encrypted] });
    const repository = new ExecutionRepository({ query } as never);
    const credentialId = "11111111-1111-4111-8111-111111111111";

    await expect(repository.resolveCredential("run-id", credentialId)).resolves.toBe("allowed-secret");
    expect(query.mock.calls[0]?.[0]).toContain("environment_snapshot->'secretRefs'");
    expect(query.mock.calls[0]?.[0]).toContain("? ($2::uuid)::text");
    expect(query.mock.calls[0]?.[1]).toEqual(["run-id", credentialId]);
  });

  it("gives repeated generated credentials a unique safe display name", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes("SELECT project_id")) {
          return { rowCount: 1, rows: [{ project_id: "project-id", environment_id: "environment-id" }] };
        }
        if (text.includes("SELECT 1 FROM project_credentials")) return { rowCount: 1, rows: [{ exists: true }] };
        if (text.includes("INSERT INTO project_credentials")) return { rowCount: 1, rows: [{ id: values[0] }] };
        return { rowCount: 1, rows: [] };
      }),
    };
    const repository = new ExecutionRepository({
      transaction: (work: (transactionClient: typeof client) => Promise<unknown>) => work(client),
    } as never);

    const result = await repository.captureCredential("run-id", "Generated API secret", "one-time-value");
    const insert = queries.find(({ text }) => text.includes("INSERT INTO project_credentials"));

    expect(insert?.values[2]).toMatch(/^Generated API secret \([0-9a-f]{8}\)$/);
    expect(result.credentialId).toBe(insert?.values[0]);
    expect(JSON.stringify(queries)).not.toContain("one-time-value");
  });
});
