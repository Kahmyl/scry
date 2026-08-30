import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Vitract live issuance production authority", () => {
  it("keeps the legacy command as a delegation-only compatibility wrapper", async () => {
    const source = await readFile(
      new URL("../scripts/vitract-live-issuance-binding-qualification.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('import("./vitract-production-credential-issuance.js")');
    expect(source).not.toMatch(
      /acquire_protected_outputs|executeSingleIssuance|secret_refs|vtr_app_/,
    );
  });

  it("makes the canonical command traverse the supported production service", async () => {
    const source = await readFile(
      new URL("../scripts/vitract-production-credential-issuance.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("VitractCredentialIssuancePreparationService");
    expect(source).toContain("preparation.createLifecycle");
    expect(source).toContain("preparation.prepareObservedSurface");
    expect(source).toContain("preparation.reserveObserved");
    expect(source).toContain("waitForExactAuthorization");
    expect(source).toContain("preparation.executeAuthorized");
    expect(source).toContain("`${input.idempotencyKey}-failure-close`");
    expect(source).not.toMatch(
      /754d45de-3aea-4665-a852-a55665c1f034|0d2fe496-156c-43db-85cd-85fa8aac5add|aa41b84e-af43-4619-b811-700cbe4a5df2|vtr_app_sandbox_/,
    );
  });
});
