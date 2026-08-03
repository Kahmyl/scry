import { describe, expect, it, vi } from "vitest";

import { encryptCredential } from "../src/credential.crypto.js";
import { ExecutionRepository } from "../src/execution.repository.js";

describe("protected execution credentials", () => {
  it("rejects a contradictory terminal Praxis result for a true duplicate transaction id", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const repository = new ExecutionRepository({
      transaction: (work: (value: typeof client) => Promise<unknown>) => work(client),
    } as never);
    await expect(
      repository.recordPraxisResult("run-id", "attempt-id", {
        transactionId: "duplicate-transaction",
        timing: { totalMs: 1 },
        qualityFindings: [],
        report: { intentDigest: "a".repeat(64), artifactRefs: [] },
      } as never),
    ).rejects.toThrow("Contradictory terminal Praxis result");
    expect(client.query.mock.calls[0]?.[0]).toContain("praxis_transactions.result=EXCLUDED.result");
  });
  it("loads the immutable Veil policy snapshot for the worker", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ veilPolicySnapshot: { digest: "a".repeat(64) } }],
    });
    const repository = new ExecutionRepository({ query } as never);
    await expect(repository.loadExecution("run-id")).resolves.toMatchObject({
      veilPolicySnapshot: { digest: "a".repeat(64) },
    });
    expect(query.mock.calls[0]?.[0]).toContain('veil_policy_snapshot AS "veilPolicySnapshot"');
  });
  it("resolves a credential only through the run's immutable allowlist", async () => {
    const encrypted = encryptCredential("allowed-secret");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ projectId: "project-id", authorized: true }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...encrypted, securityStatus: "active" }] });
    const repository = new ExecutionRepository({ query } as never);
    const credentialId = "11111111-1111-4111-8111-111111111111";

    await expect(repository.resolveCredential("run-id", credentialId)).resolves.toBe(
      "allowed-secret",
    );
    expect(query.mock.calls[1]?.[0]).toContain("environment_snapshot->'secretRefs'");
    expect(query.mock.calls[1]?.[0]).toContain("? ($2::uuid)::text");
    expect(query.mock.calls[1]?.[1]).toEqual(["run-id", credentialId]);
  });

  it("refuses compromised credentials before decryption", async () => {
    const encrypted = encryptCredential("must-not-resolve");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ projectId: "project-id", authorized: true }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...encrypted, securityStatus: "compromised" }],
      });
    const repository = new ExecutionRepository({ query } as never);
    await expect(
      repository.lookupCredential("run-id", "11111111-1111-4111-8111-111111111111"),
    ).resolves.toEqual({ status: "compromised" });
  });

  it("resolves a captured run secret only inside its immutable run", async () => {
    const encrypted = encryptCredential("captured-secret");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...encrypted, securityStatus: "active" }] });
    const repository = new ExecutionRepository({ query } as never);
    await expect(
      repository.resolveCredential("run-id", "11111111-1111-4111-8111-111111111111"),
    ).resolves.toBe("captured-secret");
    expect(query.mock.calls[0]?.[0]).toContain("run_captured_secrets");
    expect(query.mock.calls[0]?.[1]).toEqual(["run-id", "11111111-1111-4111-8111-111111111111"]);
  });

  it("claims a protected mutation with a fenced compare-and-set transition", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ state: "mutation_started" }] });
    const repository = new ExecutionRepository({ query } as never);
    await expect(
      repository.transitionProtectedMutation("run-id", "lease-id", {
        operationId: "operation-id",
        fencingToken: 4,
        expected: "planned",
        next: "dispatching",
      }),
    ).resolves.toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain("fencing_token=$4");
  });

  it("stores run-scoped captured secrets encrypted", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const repository = new ExecutionRepository({ query } as never);
    await repository.persistCapturedSecret({
      runId: "run-id",
      operationId: "op",
      reference: "secret",
      name: "Secret",
      value: "canary-value",
      scope: "run",
    });
    expect(query.mock.calls[0]?.[0]).toContain("run_captured_secrets");
    expect(JSON.stringify(query.mock.calls)).not.toContain("canary-value");
  });

  it("scopes generated public aliases to the originating transaction run", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ projectId: "project-id" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const repository = new ExecutionRepository({ query } as never);

    await repository.persistGeneratedPublicValue({
      runId: "run-id",
      operationId: "issue",
      reference: "clientId",
      name: "Client ID",
      value: "public-value",
      scope: "project",
    });

    expect(query.mock.calls[1]?.[0]).toContain("source_run_id");
    expect(query.mock.calls[1]?.[1]?.slice(1, 5)).toEqual(["project-id", "run-id", null, "issue"]);
  });

  it("gives repeated generated credentials a unique safe display name", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes("SELECT project_id")) {
          return {
            rowCount: 1,
            rows: [{ project_id: "project-id", environment_id: "environment-id" }],
          };
        }
        if (text.includes("SELECT 1 FROM project_credentials"))
          return { rowCount: 1, rows: [{ exists: true }] };
        if (text.includes("INSERT INTO project_credentials"))
          return { rowCount: 1, rows: [{ id: values[0] }] };
        return { rowCount: 1, rows: [] };
      }),
    };
    const repository = new ExecutionRepository({
      transaction: (work: (transactionClient: typeof client) => Promise<unknown>) => work(client),
    } as never);

    const result = await repository.captureCredential(
      "run-id",
      "Generated API secret",
      "one-time-value",
    );
    const insert = queries.find(({ text }) => text.includes("INSERT INTO project_credentials"));

    expect(insert?.values[2]).toMatch(/^Generated API secret \([0-9a-f]{8}\)$/);
    expect(result.credentialId).toBe(insert?.values[0]);
    expect(JSON.stringify(queries)).not.toContain("one-time-value");
  });
});
