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

describe("project credential creation", () => {
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
    const repository = new ScryRepository({ query } as never);

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

  it("returns a typed conflict instead of overwriting an existing credential", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
      .mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "23505" }));
    const repository = new ScryRepository({ query } as never);

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
});
