import { describe, expect, it } from "vitest";

import { getOperatingContextSchema, operatingContextSchema } from "../src/index.js";

describe("operating context contracts", () => {
  it("accepts bounded explicit requirements and rejects unknown input", () => {
    expect(
      getOperatingContextSchema.parse({
        projectId: "11111111-1111-4111-8111-111111111111",
        requiredOrigin: "https://example.test",
        requiredCredentialReferences: ["22222222-2222-4222-8222-222222222222"],
      }),
    ).toMatchObject({ requiredOrigin: "https://example.test" });
    expect(
      getOperatingContextSchema.parse({ requiredOrigin: "https://EXAMPLE.test:443/path" })
        .requiredOrigin,
    ).toBe("https://example.test");
    expect(() => getOperatingContextSchema.parse({ arbitrary: true })).toThrow();
  });

  it("does not admit protected values or unbounded collections", () => {
    const base = {
      selection: {
        project: null,
        requiresProjectSelection: false,
        projectCandidates: { items: [], truncated: false },
      },
      missions: {
        candidates: { items: [], truncated: false },
        policy: {
          decision: "selection_required",
          freshPrimaryMissionPermitted: false,
          continuationAvailable: false,
          historicalMissionCount: 0,
        },
      },
      credentials: { items: [], truncated: false },
      environments: { items: [], truncated: false },
      authoring: {
        reusable: { items: [], truncated: false },
        recoverable: { items: [], truncated: false },
        uncertain: { items: [], truncated: false },
        ready: false,
        missing: [
          "project",
          "mission",
          "objective",
          "environment",
          "flow_draft",
          "authoring_session",
        ],
      },
      continuation: {
        deterministicPreparationAvailable: false,
        userAuthorityRequired: false,
        safeActions: ["create_project_in_dashboard"],
        blockerCode: "NO_PROJECT",
      },
    };
    expect(operatingContextSchema.parse(base)).toEqual(base);
    expect(
      operatingContextSchema.parse({
        ...base,
        credentials: {
          items: [
            {
              referenceId: "22222222-2222-4222-8222-222222222222",
              name: "Preview password",
              securityStatus: "active",
              eligibleForAuthorization: true,
              authorizedEnvironmentIds: ["33333333-3333-4333-8333-333333333333"],
              authorizedEnvironmentIdsTruncated: false,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          truncated: false,
        },
      }),
    ).toMatchObject({
      credentials: {
        items: [
          { name: "Preview password", securityStatus: "active", eligibleForAuthorization: true },
        ],
      },
    });
    expect(() =>
      operatingContextSchema.parse({
        ...base,
        credentials: {
          items: [
            {
              referenceId: "22222222-2222-4222-8222-222222222222",
              name: "login",
              securityStatus: "active",
              eligibleForAuthorization: true,
              authorizedEnvironmentIds: [],
              authorizedEnvironmentIdsTruncated: false,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              value: "secret",
            },
          ],
          truncated: false,
        },
      }),
    ).toThrow();
  });
});
