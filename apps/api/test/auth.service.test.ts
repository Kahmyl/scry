import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../src/auth.service.js";
import type { IdentityRepository } from "../src/identity.repository.js";
import { ScryRepository } from "../src/repository.js";
import type { Database } from "../src/database.js";

const originalServiceToken = process.env.SCRY_SERVICE_TOKEN;
const originalSupabaseUrl = process.env.SUPABASE_URL;

afterEach(() => {
  restore("SCRY_SERVICE_TOKEN", originalServiceToken);
  restore("SUPABASE_URL", originalSupabaseUrl);
  vi.restoreAllMocks();
});

describe("AuthService", () => {
  it("accepts only the exact configured service token", async () => {
    process.env.SCRY_SERVICE_TOKEN = "service-token-with-enough-entropy";
    delete process.env.SUPABASE_URL;
    const service = new AuthService({} as IdentityRepository);

    await expect(service.authenticate("Bearer service-token-with-enough-entropy")).resolves.toEqual(
      { kind: "service", subject: "scry-service" },
    );
    await expect(service.authenticate("Bearer wrong-token")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("rejects missing and malformed authorization headers", async () => {
    delete process.env.SCRY_SERVICE_TOKEN;
    delete process.env.SUPABASE_URL;
    const service = new AuthService({} as IdentityRepository);

    await expect(service.authenticate(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.authenticate("Basic value")).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.authenticate("Bearer one two")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("enforces viewer read-only membership", () => {
    const repository = new ScryRepository({} as Database);
    expect(() =>
      repository.requireWriteAccess({
        kind: "user",
        subject: "00000000-0000-0000-0000-000000000001",
        userId: "user-1",
        email: "viewer@example.com",
        workspaceId: "workspace-1",
        role: "viewer",
      }),
    ).toThrow("Workspace viewers have read-only access");
    expect(() =>
      repository.requireWriteAccess({
        kind: "user",
        subject: "00000000-0000-0000-0000-000000000002",
        userId: "user-2",
        email: "member@example.com",
        workspaceId: "workspace-1",
        role: "member",
      }),
    ).not.toThrow();
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
