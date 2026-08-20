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
      requiredCredentialReferences: [], authorizeDistinctMissionForReadOnlyUnknown: false,
    });
    expect(result).toMatchObject({ selection: { project: null, requiresProjectSelection: true },
      credentials: { items: [] }, continuation: { blockerCode: "PROJECT_SELECTION_REQUIRED" } });
    expect(query.mock.calls.some(([text]) => String(text).includes("project_credentials"))).toBe(false);
  });

  it("correlates readiness to the compatible reusable environment and bounds corrupt resume data", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM projects")) return { rowCount: 1, rows: [{ id: projectId, name: "One", description: "" }] };
      if (text.includes("FROM missions")) return { rowCount: 1, rows: [{ id: missionId, title: "Mission",
        status: "awaiting_user", revision: 1, currentObjectiveId: objectiveId,
        resumePointer: { objectiveId, recommendedAction: "await_user", explanation: "ok",
          secret: "must-not-project", externalInput: {
            condition: "USER_INPUT_REQUIRED", cause: "A credential is required.", effectState: "not_applied",
            authority: { required: true, type: "user", reason: "Only the user can supply it." },
            availableCapabilities: ["resume_mission"], constraints: ["Do not guess."], consequences: [],
            continuation: { retryCurrentOperation: false, freshObservationRequired: true,
              newOperationRequired: true, newDraftRequired: false, newSessionRequired: false },
            waiting: true, terminal: false, resumeRef: objectiveId,
          } } }] };
      if (text.includes("project_credentials")) return { rowCount: 1, rows: [{
        referenceId: objectiveId, name: "Credential", securityStatus: "active",
        eligibleForAuthorization: true, authorizedEnvironmentIds: [environmentId],
        authorizedEnvironmentIdsTruncated: false,
        createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
      }] };
      if (text.includes("FROM environments")) return { rowCount: 2, rows: [
        { id: environmentId, name: "Compatible", baseOrigin: "https://example.test", secretRefs: [objectiveId],
          policy: { allowedOrigins: ["https://example.test"] }, executionReadiness: "runtime_required" },
        { id: "88888888-8888-4888-8888-888888888888", name: "Other", baseOrigin: "https://other.test", secretRefs: [],
          policy: { allowedOrigins: ["https://other.test"] }, executionReadiness: "runtime_admitted" },
      ] };
      if (text.includes("session.state='recovery_required'")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM adaptive_sessions")) return { rowCount: 1, rows: [{ sessionId, missionId,
        objectiveId, flowDraftId, environmentId: "88888888-8888-4888-8888-888888888888", state: "active",
        _categoryRank: 1 }] };
      return { rowCount: 0, rows: [] };
    });
    const repository = new ProjectConfigurationRepository({ transaction: (work: any) => work({ query }) } as never);
    const result = await repository.operatingContext({ kind: "service", subject: "scry-service" }, {
      projectId, missionId, requiredOrigin: "https://example.test",
      requiredCredentialReferences: [objectiveId],
      authorizeDistinctMissionForReadOnlyUnknown: false,
    });
    expect(result.authoring).toMatchObject({ ready: false, reusable: { items: [] } });
    expect(result.environments.items[0]).toMatchObject({
      resourceExists: true, policyValid: true, executionReadiness: "runtime_required",
    });
    expect(result.continuation.deterministicPreparationAvailable).toBe(false);
    expect(result.credentials.items[0]).toMatchObject({
      name: "Credential", securityStatus: "active", eligibleForAuthorization: true,
      authorizedEnvironmentIds: [environmentId],
    });
    expect(result.missions.candidates.items[0]?.resumePointer?.externalInput).toMatchObject({
      fulfillmentPaths: [],
      lifecycle: { terminal: false, taskStillActive: true, sameMissionResumable: true,
        sameObjectiveResumable: true, shouldFinalize: false, shouldPublishFinalReport: false,
        shouldCreateReplacementMission: false,
        requiredNextStep: "fulfill_human_prerequisite_then_resume" },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-project");
    expect(JSON.stringify(result)).not.toMatch(/"_[^"]+"\s*:/);
  });

  it("normalizes database timestamps and never exposes internal projection fields", async () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM projects")) return { rowCount: 1, rows: [{ id: projectId, name: "One", description: "" }] };
      if (text.includes("FROM missions")) return { rowCount: 1, rows: [{ id: missionId, title: "Mission",
        status: "running", revision: 1, currentObjectiveId: objectiveId, resumePointer: null }] };
      if (text.includes("project_credentials")) return { rowCount: 1, rows: [{
        referenceId: objectiveId, name: "Credential", securityStatus: "active",
        eligibleForAuthorization: true, authorizedEnvironmentIds: [environmentId],
        authorizedEnvironmentIdsTruncated: false, createdAt, updatedAt: createdAt,
      }] };
      if (text.includes("FROM environments")) return { rowCount: 1, rows: [{ id: environmentId,
        name: "Compatible", baseOrigin: "https://example.test", secretRefs: [objectiveId],
        policy: { allowedOrigins: ["https://example.test"] }, executionReadiness: "runtime_admitted" }] };
      if (text.includes("session.state='recovery_required'")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM adaptive_sessions")) return { rowCount: 1, rows: [{ sessionId, missionId,
        objectiveId, flowDraftId, environmentId, state: "active", decisionBoundary: null,
        turnId: null, turnState: null, operationId: null, mutationOutcome: null,
        operationObjectiveId: null, operationFlowDraftId: null, _categoryRank: 1 }] };
      return { rowCount: 0, rows: [] };
    });
    const repository = new ProjectConfigurationRepository({ transaction: (work: any) => work({ query }) } as never);
    const result = await repository.operatingContext({ kind: "service", subject: "scry-service" }, {
      projectId, missionId, requiredCredentialReferences: [], authorizeDistinctMissionForReadOnlyUnknown: false,
    });
    expect(result.credentials.items[0]).toMatchObject({
      createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
    });
    expect(JSON.stringify(result)).not.toMatch(/"_[^"]+"\s*:/);
  });

  it("projects the exact unresolved UNKNOWN inspection target without advertising redispatch", async () => {
    const operationId = "uncertain-operation";
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM projects")) return { rowCount: 1, rows: [{ id: projectId, name: "One", description: "" }] };
      if (text.includes("session.state='recovery_required'")) return { rowCount: 1, rows: [{
        sessionId, missionId, objectiveId, flowDraftId, environmentId, operationId,
        dispatchSemantics: "read_only",
      }] };
      if (text.includes("FROM missions")) return { rowCount: 1, rows: [{ id: missionId, title: "Mission",
        status: "running", revision: 1, currentObjectiveId: objectiveId, resumePointer: null }] };
      if (text.includes("project_credentials")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM environments")) return { rowCount: 1, rows: [{ id: environmentId,
        name: "Recovery", baseOrigin: "https://example.test", secretRefs: [],
        policy: { allowedOrigins: ["https://example.test"] }, executionReadiness: "recovery_required" }] };
      if (text.includes("FROM adaptive_sessions")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const repository = new ProjectConfigurationRepository({ transaction: (work: any) => work({ query }) } as never);
    const result = await repository.operatingContext({ kind: "service", subject: "scry-service" }, {
      projectId, missionId, requiredCredentialReferences: [],
      authorizeDistinctMissionForReadOnlyUnknown: true,
    });
    expect(result.authoring.uncertain.items).toEqual([expect.objectContaining({
      sessionId, operationId, originalMutationOutcome: "unknown", redispatchAllowed: false,
      inspectionTool: "get_flow_authoring", reconciliationAvailable: false,
      distinctMissionAlternative: {
        available: true, tool: "start_mission", requiresExplicitUserAuthority: true,
        preservesCurrentMissionFence: true, basis: "uncertain_operation_declared_read_only",
      },
    })]);
    expect(result.continuation.safeActions).toEqual(["get_flow_authoring", "start_mission"]);
    expect(result.continuation.deterministicPreparationAvailable).toBe(false);
    const uncertainQuery = query.mock.calls.map(([text]) => String(text))
      .find((text) => text.includes("session.state='recovery_required'"));
    expect(uncertainQuery).toContain("PARTITION BY session.mission_id");
    expect(uncertainQuery).toContain("JOIN candidate_missions mission");

    const withoutAuthority = await repository.operatingContext(
      { kind: "service", subject: "scry-service" },
      { projectId, missionId, requiredCredentialReferences: [], authorizeDistinctMissionForReadOnlyUnknown: false },
    );
    expect(withoutAuthority.authoring.uncertain.items[0]?.distinctMissionAlternative).toBeUndefined();
    expect(withoutAuthority.continuation.safeActions).toEqual(["get_flow_authoring"]);
    expect(withoutAuthority.continuation.userAuthorityRequired).toBe(true);
  });

  it("does not auto-select a sole Mission without explicit user authority", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM projects"))
        return { rowCount: 1, rows: [{ id: projectId, name: "One", description: "" }] };
      if (text.includes("session.state='recovery_required'"))
        return { rowCount: 0, rows: [] };
      if (text.includes("FROM missions"))
        return { rowCount: 1, rows: [{
          id: missionId,
          title: "Potentially related Mission",
          status: "running",
          revision: 1,
          currentObjectiveId: objectiveId,
          resumePointer: null,
        }] };
      if (text.includes("project_credentials"))
        return { rowCount: 0, rows: [] };
      if (text.includes("FROM environments"))
        return { rowCount: 0, rows: [] };
      if (text.includes("FROM adaptive_sessions"))
        return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });

    const repository = new ProjectConfigurationRepository({
      transaction: (work: any) => work({ query }),
    } as never);

    const result = await repository.operatingContext(
      { kind: "service", subject: "scry-service" },
      {
        projectId,
        requiredCredentialReferences: [],
        authorizeDistinctMissionForReadOnlyUnknown: false,
      },
    );

    expect(result.missions.selectedMissionId).toBeUndefined();
    expect(result.continuation.userAuthorityRequired).toBe(true);
    expect(result.continuation.safeActions).toEqual(["list_missions"]);
    expect(result.continuation.blockerCode).toBe("MISSION_SELECTION_REQUIRED");
  });

  it("projects factual Mission credential use without treating environment authorization as Mission authority", async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("FROM projects"))
        return { rowCount: 1, rows: [{ id: projectId }] };

      if (text.includes('AS "usedInMission"')) {
        return {
          rowCount: 1,
          rows: [{
            id: objectiveId,
            referenceId: objectiveId,
            projectId,
            name: "Preview password",
            securityStatus: "active",
            eligibleForAuthorization: true,
            authorizedEnvironmentIds: [environmentId],
            authorizedEnvironmentIdsTruncated: false,
            usedInMission: values?.[2] ? true : null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          }],
        };
      }

      return { rowCount: 0, rows: [] };
    });

    const repository = new ProjectConfigurationRepository({ query } as never);

    const missionScoped = await repository.listCredentialCandidates(
      { kind: "service", subject: "scry-service" },
      projectId,
      { missionId },
    );

    expect(missionScoped.items[0]).toMatchObject({
      referenceId: objectiveId,
      usedInMission: true,
      authorizedEnvironmentIds: [environmentId],
    });

    const unscoped = await repository.listCredentialCandidates(
      { kind: "service", subject: "scry-service" },
      projectId,
      {},
    );

    expect(unscoped.items[0]).toMatchObject({
      referenceId: objectiveId,
      usedInMission: null,
    });

    const candidateCall = query.mock.calls.find(
      (call) => String(call[0]).includes('AS "usedInMission"'),
    );

    expect(candidateCall).toBeDefined();
    expect(String(candidateCall![0])).toContain("origin_mission_id");
    expect(String(candidateCall![0])).toContain("adaptive_operations");
    expect(String(candidateCall![0])).toContain("protectedInputReferences");
    expect(candidateCall![1]).toEqual([projectId, null, missionId]);
  });

});
