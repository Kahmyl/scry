import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../src/infrastructure/index.js";
import { bootstrapQ5CanonicalScope } from "../src/runtime/q5-scope-bootstrap.js";
import { Q5ScopeBootstrapRepository } from "../src/runtime/repositories/q5-scope-bootstrap.repository.js";

const databaseUrl = process.env.SCRY_M6_BOOTSTRAP_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Q5 persisted canonical bootstrap", () => {
  const workspaceId = randomUUID();
  const facts = {
    sourceCommit: "a".repeat(40),
    sourceManifest: "b".repeat(64),
    schemaFingerprint: "c".repeat(64),
    migrationIdentity: "d".repeat(64),
  };
  let database: Database;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    await database.query(
      `INSERT INTO workspaces(id,name,slug) VALUES($1,'Q5 bootstrap integration',$2)`,
      [workspaceId, `q5-bootstrap-${workspaceId}`],
    );
  });

  afterAll(async () => database?.onModuleDestroy());

  it("creates generated Project/environment identities from empty persisted state", async () => {
    const result = await bootstrapQ5CanonicalScope(
      new Q5ScopeBootstrapRepository(database, workspaceId),
      facts,
    );
    expect(result).toMatchObject({
      status: "credential_issuance_required",
      code: "LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED",
      paidAttemptCreated: false,
    });
    if (result.status !== "credential_issuance_required") throw new Error("expected blocker");
    expect(result.projectId).not.toBe("6b3b5011-0f41-430c-a8a2-d4abfd9ff3f1");
    expect(result.environmentId).not.toBe("9a581bb0-2276-4888-9ddb-07b2485cddc3");
    expect(
      await database.query(
        `SELECT designation.project_id::text AS "projectId",
                designation.environment_id::text AS "environmentId",
                designation.application_identity AS "applicationIdentity",
                environment.base_origin AS "baseOrigin"
           FROM q5_canonical_scope_designations designation
           JOIN environments environment ON environment.id=designation.environment_id`,
      ),
    ).toMatchObject({
      rows: [
        {
          projectId: result.projectId,
          environmentId: result.environmentId,
          applicationIdentity: "vitract-preview-test",
          baseOrigin: "https://preview-api.vitract.com",
        },
      ],
    });
    expect(
      await database.query(`SELECT count(*)::int count FROM q5_authoritative_attempts`),
    ).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("reuses persisted scope and refuses fabricated credential rows as issuance provenance", async () => {
    const before = await database.query<any>(
      `SELECT project_id::text AS "projectId",environment_id::text AS "environmentId"
         FROM q5_canonical_scope_designations`,
    );
    const projectId = before.rows[0]!.projectId;
    await database.query(
      `INSERT INTO project_credentials(project_id,name,ciphertext,initialization_vector,authentication_tag)
       VALUES($1,'Vitract client id fabricated','x','123456789012','1234567890123456'),
             ($1,'Vitract client secret fabricated','y','123456789012','1234567890123456')`,
      [projectId],
    );
    const result = await bootstrapQ5CanonicalScope(
      new Q5ScopeBootstrapRepository(database, workspaceId),
      facts,
    );
    expect(result).toMatchObject({
      status: "credential_issuance_required",
      projectId: before.rows[0]!.projectId,
      environmentId: before.rows[0]!.environmentId,
      paidAttemptCreated: false,
    });
    expect(await database.query(`SELECT count(*)::int count FROM projects`)).toMatchObject({
      rows: [{ count: 1 }],
    });
    expect(await database.query(`SELECT count(*)::int count FROM environments`)).toMatchObject({
      rows: [{ count: 1 }],
    });
    expect(
      await database.query(`SELECT count(*)::int count FROM q5_prepared_scopes`),
    ).toMatchObject({
      rows: [{ count: 0 }],
    });
  });
});
