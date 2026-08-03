import { describe, expect, it, vi } from "vitest";
import { CalibrationService } from "../src/calibration/index.js";

describe("CalibrationService", () => {
  const context = {
    missionId: "11111111-1111-4111-8111-111111111111",
    objectiveId: "22222222-2222-4222-8222-222222222222",
    agentSessionId: "33333333-3333-4333-8333-333333333333",
    confirmedUserAuthorized: true as const,
  };
  it("requires owner or admin approval and records an append-only decision", async () => {
    const client = {
      query: vi.fn(async (text: string) =>
        text.includes("SELECT attestation.id")
          ? { rowCount: 1, rows: [{ id: "attestation" }] }
          : { rowCount: 1, rows: [] },
      ),
    };
    const service = new CalibrationService(
      { transaction: (work: (value: typeof client) => Promise<unknown>) => work(client) } as never,
      { assertAcceptingWork: vi.fn(async () => undefined) } as never,
    );
    await expect(
      service.decide(
        { kind: "user", subject: "s", userId: "u", email: "e", workspaceId: "w", role: "member" },
        "c",
        "r",
        "approved",
        context,
      ),
    ).rejects.toThrow("owner or admin");
    await expect(
      service.decide(
        { kind: "user", subject: "s", userId: "u", email: "e", workspaceId: "w", role: "owner" },
        "c",
        "r",
        "approved",
        context,
      ),
    ).resolves.toMatchObject({ status: "approved" });
    expect(
      client.query.mock.calls.some(([sql]) => String(sql).includes("calibration_decisions")),
    ).toBe(true);
  });

  it("refuses approval until a worker attestation has passed", async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) };
    const service = new CalibrationService(
      { transaction: (work: (value: typeof client) => Promise<unknown>) => work(client) } as never,
      { assertAcceptingWork: vi.fn(async () => undefined) } as never,
    );
    await expect(
      service.decide(
        { kind: "user", subject: "s", userId: "u", email: "e", workspaceId: "w", role: "owner" },
        "c",
        "r",
        "approved",
        context,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "CALIBRATION_ATTESTATION_REQUIRED" }),
    });
  });
});
