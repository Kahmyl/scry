import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { PraxisSessionController } from "../src/adaptive-sessions/adaptive-session.controller.js";
import { MissionFlowAuthoringService } from "../src/adaptive-sessions/mission-flow-authoring.service.js";

const principal = {
  kind: "user" as const,
  subject: "user:test",
  userId: randomUUID(),
  email: "owner@example.test",
  workspaceId: randomUUID(),
  role: "owner" as const,
};
const sessionId = randomUUID();
const input = {
  contextControlReference: "context-control-0123456789abcdef0123456789abcdef",
};
const inspection = {
  contextControlReference: input.contextControlReference,
  authority: {
    referenceVersion: 1 as const,
    pageId: "page-1",
    frameId: "frame-1",
    documentEpoch: 1,
    documentIdentity: "document-1",
  },
  region: { kind: "section" as const },
  readableValues: [],
  readableValueCompleteness: {
    kind: "bounded" as const,
    observed: 0,
    returned: 0,
    truncated: false,
  },
};

describe("Praxis region inspection API service", () => {
  it.each(["active", "suspended"] as const)(
    "delegates an observable %s session to the owned runtime without creating an operation",
    async (state) => {
      const beginMissionOperation = vi.fn();
      const repository = {
        get: vi.fn(async () => ({ id: sessionId, state })),
        beginMissionOperation,
      };
      const runner = { inspectRegion: vi.fn(async () => inspection) };
      const service = new MissionFlowAuthoringService(
        repository as never,
        runner as never,
        { assertAcceptingWork: vi.fn() } as never,
      );

      await expect(service.inspectRegion(principal, sessionId, input)).resolves.toBe(inspection);
      expect(repository.get).toHaveBeenCalledWith(principal.workspaceId, sessionId);
      expect(runner.inspectRegion).toHaveBeenCalledWith(sessionId, input);
      expect(beginMissionOperation).not.toHaveBeenCalled();
    },
  );

  it("refuses a non-live session consistently", async () => {
    const repository = { get: vi.fn(async () => ({ id: sessionId, state: "completed" })) };
    const runner = { inspectRegion: vi.fn() };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );

    await expect(service.inspectRegion(principal, sessionId, input)).rejects.toMatchObject({
      response: { code: "PRAXIS_SESSION_NOT_LIVE" },
    });
    expect(runner.inspectRegion).not.toHaveBeenCalled();
  });

  it("exposes the adjacent controller delegation", async () => {
    const service = { inspectRegion: vi.fn(async () => inspection) };
    const controller = new PraxisSessionController(service as never);

    await expect(controller.inspectRegion(principal, sessionId, input)).resolves.toBe(inspection);
    expect(service.inspectRegion).toHaveBeenCalledWith(principal, sessionId, input);
  });
});
