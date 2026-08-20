import { beforeEach, describe, expect, it, vi } from "vitest";

import { observeAuthenticatedJsonResource } from "@scry/praxis";
import { decryptCredential } from "../src/access/credential.crypto.js";
import type { UnknownOperationAuthority } from "../src/adaptive-sessions/adaptive-operation-reconciliation.registry.js";
import { VitractCredentialResourceEffectProvider } from "../src/adaptive-sessions/vitract-credential-resource-effect.provider.js";

vi.mock("@scry/praxis", () => ({
  observeAuthenticatedJsonResource: vi.fn(),
}));

vi.mock("../src/access/credential.crypto.js", () => ({
  decryptCredential: vi.fn(),
}));

const emailReference = "11111111-1111-4111-8111-111111111111";
const passwordReference = "22222222-2222-4222-8222-222222222222";

function authority(
  preparationFacts: NonNullable<UnknownOperationAuthority["preparationFacts"]>,
): UnknownOperationAuthority {
  return {
    projectId: "project",
    environmentId: "environment",
    missionId: "mission",
    objectiveId: "objective",
    flowDraftId: "flow",
    sessionId: "session",
    operationId: "operation",
    idempotencyKey: "dispatch-key",
    dispatchBoundary: "acknowledged",
    dispatchIdentity: { operationCreatedAt: "2026-08-19T00:00:00Z" },
    expectedEffect: { type: "none" },
    baseline: null,
    action: { type: "protectedTransaction" } as never,
    preparationFacts,
  };
}

function successfulDatabase() {
  return {
    query: vi.fn(async (_sql: string, _params: unknown[]) => ({
      rows: [
        {
          id: emailReference,
          ciphertext: Buffer.from([1]),
          initializationVector: Buffer.alloc(12),
          authenticationTag: Buffer.alloc(16),
          policy: {
            allowedOrigins: ["https://preview.vitract.com"],
            trustedScriptOrigins: [],
          },
        },
        {
          id: passwordReference,
          ciphertext: Buffer.from([2]),
          initializationVector: Buffer.alloc(12),
          authenticationTag: Buffer.alloc(16),
          policy: {
            allowedOrigins: ["https://preview.vitract.com"],
            trustedScriptOrigins: [],
          },
        },
      ],
    })),
  };
}

async function observe(
  provider: VitractCredentialResourceEffectProvider,
  inputAuthority: UnknownOperationAuthority,
) {
  return (
    provider as unknown as {
      observe(input: {
        resourceScope: string;
        authority: Readonly<UnknownOperationAuthority>;
      }): Promise<unknown>;
    }
  ).observe({
    resourceScope: "vtr_app_sandbox_test",
    authority: inputAuthority,
  });
}

describe("Vitract credential reconciliation authentication facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(decryptCredential).mockReturnValue("opaque-protected-fixture");

    vi.mocked(observeAuthenticatedJsonResource).mockResolvedValue({
      bodies: [
        {
          data: [
            {
              id: "credential-1",
              label: "qualification-label",
              clientId: "public-client-id",
              status: "active",
            },
          ],
        },
      ],
    } as never);
  });

  it("accepts canonical atomic authenticate preparation facts", async () => {
    const database = successfulDatabase();
    const provider = new VitractCredentialResourceEffectProvider(
      { register: vi.fn() } as never,
      database as never,
    );

    await expect(
      observe(
        provider,
        authority([
          {
            intentId: "authenticate",
            actionKind: "authenticate",
            protectedReferenceId: emailReference,
            targetConcept: "login email",
          },
          {
            intentId: "authenticate",
            actionKind: "authenticate",
            protectedReferenceId: passwordReference,
            targetConcept: "login password",
          },
        ]),
      ),
    ).resolves.toMatchObject({
      source: "authoritative_supported_resource_listing",
      records: [
        {
          identity: "credential-1",
          label: "qualification-label",
          state: "active",
        },
      ],
    });

    expect(database.query).toHaveBeenCalledOnce();
    expect(database.query.mock.calls[0]![1]).toEqual([
      "environment",
      "project",
      [emailReference, passwordReference],
    ]);
    expect(observeAuthenticatedJsonResource).toHaveBeenCalledOnce();
  });

  it("preserves legacy protected fill authentication compatibility", async () => {
    const database = successfulDatabase();
    const provider = new VitractCredentialResourceEffectProvider(
      { register: vi.fn() } as never,
      database as never,
    );

    await expect(
      observe(
        provider,
        authority([
          {
            intentId: "email-fill",
            actionKind: "fill",
            protectedReferenceId: emailReference,
            targetPlaceholder: "Enter your email",
          },
          {
            intentId: "password-fill",
            actionKind: "fill",
            protectedReferenceId: passwordReference,
            targetPlaceholder: "Enter your password",
          },
        ]),
      ),
    ).resolves.toMatchObject({
      source: "authoritative_supported_resource_listing",
    });

    expect(database.query).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "missing password",
      [
        {
          intentId: "authenticate",
          actionKind: "authenticate",
          protectedReferenceId: emailReference,
          targetConcept: "login email",
        },
      ],
    ],
    [
      "duplicate email",
      [
        {
          intentId: "authenticate",
          actionKind: "authenticate",
          protectedReferenceId: emailReference,
          targetConcept: "login email",
        },
        {
          intentId: "legacy-email",
          actionKind: "fill",
          protectedReferenceId: emailReference,
          targetPlaceholder: "Enter your email",
        },
        {
          intentId: "authenticate",
          actionKind: "authenticate",
          protectedReferenceId: passwordReference,
          targetConcept: "login password",
        },
      ],
    ],
  ])("fails closed for %s authentication facts", async (_name, preparationFacts) => {
    const database = successfulDatabase();
    const provider = new VitractCredentialResourceEffectProvider(
      { register: vi.fn() } as never,
      database as never,
    );

    await expect(
      observe(
        provider,
        authority(preparationFacts),
      ),
    ).rejects.toThrow(
      "VITRACT_RECONCILIATION_AUTHENTICATION_CONTRACT_UNAVAILABLE",
    );

    expect(database.query).not.toHaveBeenCalled();
    expect(decryptCredential).not.toHaveBeenCalled();
    expect(observeAuthenticatedJsonResource).not.toHaveBeenCalled();
  });
});
