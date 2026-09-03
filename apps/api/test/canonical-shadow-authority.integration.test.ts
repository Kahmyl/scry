import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../src/infrastructure/index.js";

// A1 diagnostics against a completed disposable production shadow only. Every
// attempted state change rolls back; never point this at the user's Q5 scope.
const url = process.env.SCRY_CANONICAL_SHADOW_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration("production shadow canonical storage and projection authority", () => {
  let database: Database;
  let protectedAsset: { id: string; credentialId: string; environmentId: string };
  let publicAsset: { id: string; valueId: string };
  beforeAll(async () => {
    if (!/^\/scry_shadow_[a-f0-9]+$/.test(new URL(url!).pathname))
      throw new Error("DISPOSABLE_SHADOW_DATABASE_REQUIRED");
    process.env.DATABASE_URL = url;
    database = new Database();
    protectedAsset = (
      await database.query<any>(`SELECT id,project_credential_id AS "credentialId",environment_id AS "environmentId"
      FROM typed_value_assets WHERE classification='protected' AND state='active' LIMIT 1`)
    ).rows[0];
    publicAsset = (
      await database.query<any>(`SELECT id,generated_public_value_id AS "valueId"
      FROM typed_value_assets WHERE classification='public' AND state='active' LIMIT 1`)
    ).rows[0];
    expect(protectedAsset).toBeDefined();
    expect(publicAsset).toBeDefined();
  });
  afterAll(async () => database?.onModuleDestroy());
  async function rolledBack(work: (client: any) => Promise<void>) {
    await database.transaction(async (client) => {
      await client.query("SAVEPOINT shadow_authority_check");
      try {
        await work(client);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT shadow_authority_check");
      }
    });
  }
  it("rejects rewriting protected generated backing", async () => {
    await rolledBack(async (client) => {
      await expect(
        client.query("UPDATE project_credentials SET ciphertext='changed' WHERE id=$1", [
          protectedAsset.credentialId,
        ]),
      ).rejects.toThrow("GENERATED_VALUE_BACKING_IMMUTABLE");
    });
  });
  it("rejects rewriting generated-safe backing", async () => {
    await rolledBack(async (client) => {
      await expect(
        client.query("UPDATE generated_public_values SET value='changed' WHERE id=$1", [
          publicAsset.valueId,
        ]),
      ).rejects.toThrow("GENERATED_PUBLIC_VALUE_BACKING_IMMUTABLE");
    });
  });
  it("refuses generated credentials as Environment membership authority", async () => {
    await rolledBack(async (client) => {
      await expect(
        client.query(
          "UPDATE environments SET secret_refs=secret_refs || to_jsonb($2::text) WHERE id=$1",
          [protectedAsset.environmentId, protectedAsset.credentialId],
        ),
      ).rejects.toThrow("GENERATED_VALUES_REQUIRE_EXPLICIT_USE_GRANTS");
    });
  });
  it("revokes active assets on backing deletion without restoring consumed grants", async () => {
    await rolledBack(async (client) => {
      await client.query("UPDATE project_credentials SET deleted_at=now() WHERE id=$1", [
        protectedAsset.credentialId,
      ]);
      expect(
        (
          await client.query("SELECT state FROM typed_value_assets WHERE id=$1", [
            protectedAsset.id,
          ])
        ).rows[0].state,
      ).toBe("revoked");
      const grants = await client.query(
        "SELECT state,revoked_at FROM value_use_grants WHERE value_asset_id=$1",
        [protectedAsset.id],
      );
      expect(grants.rowCount).toBeGreaterThan(0);
      expect(grants.rows.every((row: any) => row.state === "consumed" && row.revoked_at)).toBe(
        true,
      );
    });
  });
  it("preserves read-only not-applied truth in the terminal adaptive projection", async () => {
    const mismatch = await database.query(`SELECT 1 FROM protected_operations protected
      JOIN adaptive_operations adaptive ON adaptive.session_id=protected.praxis_session_id AND adaptive.operation_id=protected.operation_id
      WHERE protected.state='completed' AND protected.mutation_outcome IS DISTINCT FROM adaptive.mutation_outcome`);
    expect(mismatch.rowCount).toBe(0);
    const read = (
      await database.query<any>(`SELECT praxis_session_id AS session,operation_id AS operation
      FROM protected_operations WHERE dispatch_semantics='read_only' AND state='completed'`)
    ).rows[0];
    expect(read).toBeDefined();
    await rolledBack(async (client) => {
      await expect(
        client.query(
          "UPDATE adaptive_operations SET mutation_outcome='applied' WHERE session_id=$1 AND operation_id=$2",
          [read.session, read.operation],
        ),
      ).rejects.toThrow("Completed adaptive protected projection disagrees with durable operation");
    });
  });
  it("has no authoritative Q5 attempt or live runtime owner", async () => {
    expect((await database.query("SELECT 1 FROM q5_authoritative_attempts")).rowCount).toBe(0);
    expect(
      (
        await database.query(
          "SELECT 1 FROM adaptive_session_runtime_leases WHERE lease_expires_at>now()",
        )
      ).rowCount,
    ).toBe(0);
  });
});
