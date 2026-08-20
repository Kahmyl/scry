import { describe, expect, it, vi } from "vitest";
import { updateEnvironmentSchema } from "@scry/contracts";

import { ProjectConfigurationRepository } from "../src/access/repositories/project-configuration.repository.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";
const missionId = "33333333-3333-4333-8333-333333333333";
const objectiveId = "44444444-4444-4444-8444-444444444444";
const agentSessionId = "55555555-5555-4555-8555-555555555555";
const existingCredentialId = "66666666-6666-4666-8666-666666666666";
const selectedCredentialId = "77777777-7777-4777-8777-777777777777";

const policy = {
  allowedOrigins: ["https://example.test"],
  allowPrivateNetwork: false,
  allowDownloads: false as const,
  allowPopups: false as const,
  maxActions: 20,
  maxDurationMs: 60_000,
  maxNavigations: 2,
};

describe("Project environment Mission credential admission", () => {
  it("requires every Mission-selected credential to also be environment-authorized", () => {
    const parsed = updateEnvironmentSchema.safeParse({
      missionId,
      objectiveId,
      agentSessionId,
      baseOrigin: "https://example.test",
      policy,
      secretRefs: [existingCredentialId],
      missionCredentialSelectionRefs: [selectedCredentialId],
    });

    expect(parsed.success).toBe(false);

    if (parsed.success) throw new Error("EXPECTED_SCHEMA_REJECTION");

    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["missionCredentialSelectionRefs", 0],
        }),
      ]),
    );
  });

  it("projects only the explicit Mission-selected subset into matching Praxis sessions", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];

    const query = vi.fn(
      async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });

        if (text.includes('SELECT environment.project_id AS "projectId"')) {
          return {
            rowCount: 1,
            rows: [{ projectId, policy }],
          };
        }

        if (text.includes("SELECT 1 FROM missions m")) {
          return {
            rowCount: 1,
            rows: [{}],
          };
        }

        if (text.includes("SELECT id::text FROM project_credentials")) {
          return {
            rowCount: 2,
            rows: [
              { id: existingCredentialId },
              { id: selectedCredentialId },
            ],
          };
        }

        if (text.includes("WITH updated_environment AS")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: environmentId,
                projectId,
                name: "Environment",
                baseOrigin: "https://example.test",
                policy,
                secretRefs: [
                  existingCredentialId,
                  selectedCredentialId,
                ],
                createdAt: "2026-08-16T00:00:00.000Z",
                admittedPraxisSessionCount: 1,
              },
            ],
          };
        }

        throw new Error(`UNEXPECTED_QUERY:${text.slice(0, 80)}`);
      },
    );

    const repository = new ProjectConfigurationRepository({
      query,
    } as never);

    const result = await repository.updateEnvironment(
      {
        kind: "service",
        subject: "scry-service",
      } as never,
      environmentId,
      {
        missionId,
        objectiveId,
        agentSessionId,
        baseOrigin: "https://example.test",
        policy,
        secretRefs: [
          existingCredentialId,
          selectedCredentialId,
        ],
        missionCredentialSelectionRefs: [
          selectedCredentialId,
        ],
      },
    );

    expect(result).toMatchObject({
      id: environmentId,
      admittedPraxisSessionCount: 1,
    });

    const mutation = calls.find(({ text }) =>
      text.includes("WITH updated_environment AS"),
    );

    expect(mutation).toBeDefined();

    expect(mutation!.text).toContain(
      "session.protected_reference_allowlist || $6::jsonb",
    );
    expect(mutation!.text).toContain(
      "session.mission_id=$7",
    );
    expect(mutation!.text).toContain(
      "session.active_objective_id=$8",
    );
    expect(mutation!.text).toContain(
      "session.agent_session_id=$9",
    );
    expect(mutation!.text).toContain(
      "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED",
    );

    expect(mutation!.values[3]).toBe(
      JSON.stringify([
        existingCredentialId,
        selectedCredentialId,
      ]),
    );

    expect(mutation!.values[5]).toBe(
      JSON.stringify([selectedCredentialId]),
    );

    expect(mutation!.values[6]).toBe(missionId);
    expect(mutation!.values[7]).toBe(objectiveId);
    expect(mutation!.values[8]).toBe(agentSessionId);

    expect(String(mutation!.values[5])).not.toContain(
      existingCredentialId,
    );
  });
});
