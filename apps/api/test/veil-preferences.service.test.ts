import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { VeilPreferencesService } from "../src/veil/preferences.service.js";

const environmentId = "11111111-1111-4111-8111-111111111111";
const principal = { kind: "service", subject: "scry-service" } as const;

describe("Veil environment preferences", () => {
  it("persists a strictly tighter profile with an audit record", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const database = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            policy: { allowedOrigins: ["https://example.test"] },
            preferences: null,
            updatedAt: null,
          },
        ],
      }),
      transaction: vi.fn(
        async (
          work: (client: {
            query: (text: string, values?: unknown[]) => Promise<unknown>;
          }) => Promise<unknown>,
        ) =>
          work({
            query: async (text, values) => {
              queries.push({ text, ...(values ? { values } : {}) });
              return { rowCount: 1, rows: [] };
            },
          }),
      ),
    };
    const repository = { requireWriteAccess: vi.fn() };
    const service = new VeilPreferencesService(database as never, repository as never);

    const result = await service.tighten(principal, environmentId, {
      profile: "private",
      reasonCode: "VEIL_USER_REQUESTED_PRIVACY",
    });

    expect(result.effectivePolicy).toMatchObject({
      profile: "private",
      controls: {
        video: false,
        diagnostics: false,
        maskSensitiveVisuals: true,
        quarantineUnknown: true,
      },
    });
    expect(queries.some(({ text }) => text.includes("veil_environment_preferences"))).toBe(true);
    expect(queries.some(({ text }) => text.includes("veil_preference_audit"))).toBe(true);
  });

  it("refuses channel re-enablement and leaves persistence untouched", async () => {
    const database = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            policy: { allowedOrigins: ["https://example.test"] },
            preferences: {
              profile: "minimal_capture",
              allowedOrigins: ["https://example.test"],
              controls: {
                screenshots: false,
                video: false,
                dom: false,
                accessibility: false,
                diagnostics: false,
                network: false,
                trace: false,
                clipboard: false,
                downloads: false,
                maskSensitiveVisuals: true,
                sanitizeStructuredEvidence: true,
                quarantineUnknown: true,
              },
              leaseTtlMs: 5_000,
            },
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
        ],
      }),
      transaction: vi.fn(),
    };
    const service = new VeilPreferencesService(
      database as never,
      { requireWriteAccess: vi.fn() } as never,
    );

    await expect(
      service.tighten(principal, environmentId, {
        controls: { screenshots: true },
        reasonCode: "VEIL_USER_REQUESTED_PRIVACY",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("refuses relabeling a minimal policy as balanced", async () => {
    const database = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            policy: { allowedOrigins: ["https://example.test"] },
            preferences: {
              profile: "minimal_capture",
              allowedOrigins: ["https://example.test"],
              controls: {
                screenshots: false,
                video: false,
                dom: false,
                accessibility: false,
                diagnostics: false,
                network: false,
                trace: false,
                clipboard: false,
                downloads: false,
                maskSensitiveVisuals: true,
                sanitizeStructuredEvidence: true,
                quarantineUnknown: true,
              },
              leaseTtlMs: 5_000,
            },
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
        ],
      }),
      transaction: vi.fn(),
    };
    const service = new VeilPreferencesService(
      database as never,
      { requireWriteAccess: vi.fn() } as never,
    );
    await expect(
      service.tighten(principal, environmentId, {
        profile: "balanced",
        reasonCode: "VEIL_USER_REQUESTED_PRIVACY",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
