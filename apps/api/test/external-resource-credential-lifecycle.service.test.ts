import { describe, expect, it, vi } from "vitest";
import { ExternalResourceCredentialLifecycleService } from "../src/runtime/services/external-resource-credential-lifecycle.service.js";
import type { ExternalRevocationReconciliation } from "../src/runtime/services/external-resource-credential-lifecycle.service.js";

function fixture() {
  let mutationState = "planned";
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM project_credentials")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("UPDATE project_credentials")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [{ credentialStatus: "revoked", bindingState: "invalidated" }] };
    }),
  };
  const database = {
    transaction: vi.fn(async (work: (value: { query: typeof client.query }) => unknown) =>
      work(client),
    ),
  };
  const kernel = {
    claimMutation: vi.fn(async () => ({ state: mutationState, fencingToken: 1 })),
    transitionMutation: vi.fn(
      async (_session: string, transition: { expected: string; next: string }) => {
        if (mutationState !== transition.expected) return false;
        mutationState = transition.next;
        return true;
      },
    ),
  };
  const service = new ExternalResourceCredentialLifecycleService(
    database as never,
    kernel as never,
  );
  const target = { revalidate: vi.fn(async () => undefined) };
  const input = {
    sessionId: "session",
    operationId: "revoke-existing",
    credentialId: "credential",
    projectId: "project",
    environmentId: "environment",
    provider: "provider",
    resourceKind: "credential",
    resourceScope: "application",
    target: target as never,
    dispatch: vi.fn(async () => undefined),
    reconcile: vi.fn<() => Promise<ExternalRevocationReconciliation>>(async () => ({
      state: "confirmed_revoked",
      requestObserved: true,
      responseObserved: true,
      statusClass: "2xx",
    })),
  };
  return { service, input, kernel, target, client };
}

describe("external resource credential lifecycle", () => {
  it("settles exactly one confirmed revoke and atomically invalidates local lifecycle", async () => {
    const { service, input, kernel, target, client } = fixture();
    await expect(service.revoke(input)).resolves.toMatchObject({
      outcome: "confirmed_revoked",
      dispatchCount: 1,
    });
    expect(target.revalidate).toHaveBeenCalledOnce();
    expect(input.dispatch).toHaveBeenCalledOnce();
    expect(input.reconcile).toHaveBeenCalledOnce();
    expect(kernel.transitionMutation).toHaveBeenLastCalledWith(
      "session",
      expect.objectContaining({ next: "reconciled_succeeded" }),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("security_status='revoked'"),
      ["credential", "project"],
    );
  });

  it("preserves uncertainty after dispatch and never settles local lifecycle", async () => {
    const { service, input, kernel, client } = fixture();
    input.reconcile = vi.fn(async () => ({
      state: "unknown" as const,
      requestObserved: true,
      responseObserved: false,
    }));
    await expect(service.revoke(input)).resolves.toMatchObject({
      outcome: "unknown",
      dispatchCount: 1,
    });
    expect(input.dispatch).toHaveBeenCalledOnce();
    expect(client.query).not.toHaveBeenCalled();
    expect(kernel.transitionMutation).toHaveBeenLastCalledWith(
      "session",
      expect.objectContaining({ next: "outcome_unknown" }),
    );
  });

  it("does not dispatch when target revalidation fails", async () => {
    const { service, input, target } = fixture();
    target.revalidate.mockRejectedValueOnce(new Error("PRAXIS_REVALIDATION_FAILED"));
    await expect(service.revoke(input)).rejects.toThrow("PRAXIS_REVALIDATION_FAILED");
    expect(input.dispatch).not.toHaveBeenCalled();
  });

  it("refuses replay after any prior dispatch state", async () => {
    const { service, input, kernel } = fixture();
    kernel.claimMutation.mockResolvedValueOnce({ state: "outcome_unknown", fencingToken: 1 });
    await expect(service.revoke(input)).rejects.toThrow("EXTERNAL_REVOKE_ALREADY_DISPATCHED");
    expect(input.dispatch).not.toHaveBeenCalled();
  });
});
