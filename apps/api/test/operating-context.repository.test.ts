import { describe, expect, it, vi } from "vitest";

import { ProjectConfigurationRepository } from "../src/access/repositories/project-configuration.repository.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const missionId = "22222222-2222-4222-8222-222222222222";
const objectiveId = "33333333-3333-4333-8333-333333333333";
const environmentId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const flowDraftId = "66666666-6666-4666-8666-666666666666";

describe("operating context repository", () => {
  it("fails closed across ambiguous projects without reading scoped resources", async () => {
    const query = vi.fn(async (text: string) => text.includes("FROM projects")
      ? { rowCount: 2, rows: [
          { id: projectId, name: "One", description: "" },
          { id: "77777777-7777-4777-8777-777777777777", name: "Two", description: "" },
        ] }
      : { rowCount: 0, rows: [] });
    const repository = new ProjectConfigurationRepository({
      transaction: (work: any) => work({ query }),
    } as never);
    const result = await repository.operatingContext({ kind: "service", subject: "scry-service" }, {
      requiredCredentialReferences: [],
    });
    expect(result).toMatchObject({ selection: { project: null, requiresProjectSelection: true },
      credentials: { items: [] }, continuation: { blockerCode: "PROJECT_SELECTION_REQUIRED" } });
    expect(query.mock.calls.some(([text]) => String(text).includes("project_credentials"))).toBe(false);
  });

  it("correlates readiness to the compatible reusable environment and bounds corrupt resume data", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM projects")) return { rowCount: 1, rows: [{ id: projectId, name: "One", description: "" }] };
      if (text.includes("FROM missions")) return { rowCount: 1, rows: [{ id: missionId, title: "Mission",
        status: "running", revision: 1, currentObjectiveId: objectiveId,
        resumePointer: { objectiveId, recommendedAction: "await_user", explanation: "ok", secret: "must-not-project" } }] };
      if (text.includes("project_credentials")) return { rowCount: 1, rows: [{ referenceId: objectiveId, name: "Credential" }] };
      if (text.includes("FROM environments")) return { rowCount: 2, rows: [
        { id: environmentId, name: "Compatible", baseOrigin: "https://example.test", secretRefs: [objectiveId],
          policy: { allowedOrigins: ["https://example.test"] } },
        { id: "88888888-8888-4888-8888-888888888888", name: "Other", baseOrigin: "https://other.test", secretRefs: [],
          policy: { allowedOrigins: ["https://other.test"] } },
      ] };
      if (text.includes("FROM adaptive_sessions")) return { rowCount: 1, rows: [{ sessionId, missionId,
        objectiveId, flowDraftId, environmentId: "88888888-8888-4888-8888-888888888888", state: "active" }] };
      return { rowCount: 0, rows: [] };
    });
    const repository = new ProjectConfigurationRepository({ transaction: (work: any) => work({ query }) } as never);
    const result = await repository.operatingContext({ kind: "service", subject: "scry-service" }, {
      projectId, missionId, requiredOrigin: "https://example.test",
      requiredCredentialReferences: [objectiveId],
    });
    expect(result.authoring).toMatchObject({ ready: false, reusable: { items: [] } });
    expect(result.continuation.deterministicPreparationAvailable).toBe(false);
    expect(JSON.stringify(result)).not.toContain("must-not-project");
  });
});
