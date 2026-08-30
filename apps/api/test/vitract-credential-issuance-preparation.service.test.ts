import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { VitractCredentialIssuancePreparationService } from "../src/adaptive-sessions/services/vitract-credential-issuance-preparation.js";

const id = () => randomUUID();

describe("production Vitract credential issuance preparation", () => {
  it("creates generated lifecycle state and reserves the observed typed issuance without dispatch", async () => {
    const projectId = id();
    const environmentId = id();
    const lifecycle = {
      replayed: false,
      reused: false,
      missionId: id(),
      agentSessionId: id(),
      objectiveId: id(),
      environmentId,
      flowDraftId: id(),
      authoringSessionId: id(),
      authoringReady: true as const,
      continuation: { nextSafeCapability: "advance_flow_authoring" as const },
    };
    const database = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            environmentAuthorized: true,
            baseOrigin: "https://preview-api.vitract.com",
            policy: {
              allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
              trustedScriptOrigins: [
                "https://static.cloudflareinsights.com",
                "https://js.stripe.com",
                "https://maps.googleapis.com",
              ],
            },
          }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ projectId }] }),
    };
    const contract = {
      id: id(),
      digest: "a".repeat(64),
      praxisSessionId: lifecycle.authoringSessionId,
      documentEpoch: 4,
      origin: "https://preview.vitract.com",
      sourceKind: "runtime_observation" as const,
      observationId: "vitract-issued-contract",
      operation: {
        key: "issuePartnerCredential",
        label: "Add credential",
        method: "POST" as const,
        pathTemplate: "/api/v1/partners/applications/{applicationId}/credentials",
        transports: ["fetch" as const],
        classification: "mutation" as const,
        activationControlReference: `context-control-${"1".repeat(32)}`,
      },
      inputs: [
        {
          key: "credentialName",
          label: "Name",
          aliases: [],
          required: true,
          classification: "public" as const,
          acceptedPresentations: ["plain_text" as const],
          controlReference: `context-control-${"2".repeat(32)}`,
        },
      ],
      auth: { presentationClasses: [] },
      response: {
        statusClasses: [2],
        confirmedNotAppliedStatuses: [400],
        safeOutputKeys: ["credentialRecordId", "clientId", "clientSecret"],
        safeOutputs: [
          { key: "credentialRecordId", label: "id", classification: "public" as const },
          { key: "clientId", label: "Client ID", classification: "public" as const },
          { key: "clientSecret", label: "Client secret", classification: "protected" as const },
        ],
        continuation: "none" as const,
      },
    };
    const authoring = {
      prepare: vi.fn().mockResolvedValue(lifecycle),
      close: vi.fn().mockResolvedValue({ state: "completed" }),
      start: vi.fn().mockResolvedValue({ id: lifecycle.authoringSessionId }),
      abandonPreparedReservations: vi.fn().mockResolvedValue({ abandoned: [] }),
      observeOperationContracts: vi.fn().mockResolvedValue({ contracts: [contract] }),
      reservePreparedOperation: vi.fn().mockResolvedValue({
        protectedOperationId: id(),
        state: "reserved",
        authorizationRequired: true,
      }),
    };
    const service = new VitractCredentialIssuancePreparationService(
      database as never,
      authoring as never,
    );
    const principal = {
      kind: "user" as const,
      subject: id(),
      userId: id(),
      email: "operator@example.test",
      workspaceId: id(),
      role: "owner" as const,
    };
    const created = await service.createLifecycle(principal, {
      projectId,
      environmentId,
      loginEmailReferenceId: id(),
      loginPasswordReferenceId: id(),
      applicationResourceScope: "vtr_app_generated",
      credentialName: "Scry final Q5",
      idempotencyKey: `vitract-q5-${id()}`,
      distinctMissionReason: "This test requires generated distinct setup work.",
      distinctMissionAuthority: {
        confirmedUserAuthorized: true,
        selection: "start_distinct_mission",
        source: "current_request_explicit",
      },
    });
    expect(created).toStrictEqual(lifecycle);
    expect(authoring.close).toHaveBeenCalledWith(
      principal,
      lifecycle.authoringSessionId,
      expect.stringMatching(/-bootstrap-close$/),
    );
    expect(authoring.start).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        protection: "protected",
        initialProtectedReferenceIds: expect.any(Array),
      }),
    );
    expect(authoring.prepare).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        kind: "create",
        projectId,
        environmentId,
        mission: expect.not.objectContaining({ id: expect.anything() }),
        authoring: expect.objectContaining({ initialProtectedReferenceIds: expect.any(Array) }),
      }),
    );
    await service.reserveObserved(principal, {
      lifecycle,
      credentialName: "Scry final Q5",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    expect(authoring.reservePreparedOperation).toHaveBeenCalledWith(
      principal,
      lifecycle.authoringSessionId,
      expect.objectContaining({
        projectId,
        environmentId,
        missionId: lifecycle.missionId,
        praxisSessionId: lifecycle.authoringSessionId,
        observedOperationContractDigest: contract.digest,
        values: [
          expect.objectContaining({
            canonicalFieldKey: "credentialName",
            source: { kind: "literal_public", value: "Scry final Q5" },
          }),
        ],
        expectedOutputs: [
          { key: "credentialRecordId", classification: "public" },
          { key: "clientId", classification: "public" },
          { key: "clientSecret", classification: "protected" },
        ],
      }),
    );
  });

  it("fails closed before lifecycle creation when login provenance is not canonical", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const authoring = { prepare: vi.fn() };
    const service = new VitractCredentialIssuancePreparationService(
      database as never,
      authoring as never,
    );
    await expect(
      service.createLifecycle({ kind: "service", subject: "scry-service" }, {
        projectId: id(),
        environmentId: id(),
        loginEmailReferenceId: id(),
        loginPasswordReferenceId: id(),
        applicationResourceScope: "vtr_app_generated",
      credentialName: "Scry final Q5",
      idempotencyKey: `vitract-q5-${id()}`,
      distinctMissionReason: "This test requires generated distinct setup work.",
      distinctMissionAuthority: {
        confirmedUserAuthorized: true,
        selection: "start_distinct_mission",
        source: "current_request_explicit",
      },
      }),
    ).rejects.toMatchObject({ response: { code: "VITRACT_ISSUANCE_CANONICAL_SCOPE_INVALID" } });
    expect(authoring.prepare).not.toHaveBeenCalled();
  });

  it("uses safe perception to await the SPA login control before presenting protected values", async () => {
    const authoringSessionId = id();
    const lifecycle = {
      objectiveId: id(),
      flowDraftId: id(),
      authoringSessionId,
    } as never;
    const authoring = {
      advance: vi.fn().mockResolvedValue({ state: "completed" }),
      observe: vi.fn().mockResolvedValue({
        semanticPageContext: {
          controls: [
            {
              role: "textbox",
              name: "Enter your email",
              reference: `context-control-${"1".repeat(32)}`,
            },
            {
              role: "textbox",
              name: "identity suppressed",
              reference: `context-control-${"2".repeat(32)}`,
              valueProtected: true,
              semanticPurpose: "password",
            },
          ],
        },
      }),
    };
    const service = new VitractCredentialIssuancePreparationService(
      { query: vi.fn() } as never,
      authoring as never,
    );
    await service.prepareObservedSurface(
      { kind: "service", subject: "scry-service" },
      {
        lifecycle,
        loginEmailReferenceId: id(),
        loginPasswordReferenceId: id(),
        applicationResourceScope: "vtr_app_generated",
        idempotencyKey: `vitract-q5-${id()}`,
      },
    );
    expect(authoring.advance.mock.calls[0]![2].intents).toEqual([
      expect.objectContaining({ action: { kind: "navigate", url: "https://preview.vitract.com/login" } }),
    ]);
    expect(authoring.observe).toHaveBeenCalledWith(
      expect.anything(),
      authoringSessionId,
    );
    const intents = authoring.advance.mock.calls[1]![2].intents;
    expect(intents.map((intent: { action: { kind: string } }) => intent.action.kind)).toEqual([
      "fill",
      "fill",
      "activate",
      "navigate",
      "activate",
    ]);
    expect(intents[0]).toMatchObject({
      action: {
        kind: "fill",
        target: {
          role: "textbox",
          placeholder: "Enter your email",
          exact: true,
          reference: `context-control-${"1".repeat(32)}`,
        },
      },
      protectedInputReferences: [expect.any(String)],
    });
    expect(intents[1]).toMatchObject({
      action: {
        kind: "fill",
        target: { reference: `context-control-${"2".repeat(32)}` },
      },
    });
  });
});
