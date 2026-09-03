import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { BrowserProtectedValueCipher } from "../../src/browser-execution/protected-value-cipher.js";

const databaseUrl = process.env.BROWSER_V2_DATABASE_URL;
const origin = process.env.BROWSER_V2_FIXTURE_ORIGIN;
const cohort = process.env.BROWSER_V2_QUALIFICATION_COHORT ?? `portfolio-${Date.now()}`;
const outputPath = process.env.BROWSER_V2_PORTFOLIO_DESCRIPTOR;
const tokenOutputPath = process.env.BROWSER_V2_MCP_TOKEN_OUTPUT;
if (!databaseUrl) throw new Error("BROWSER_V2_DATABASE_URL_REQUIRED");
if (!origin || new URL(origin).origin !== origin)
  throw new Error("BROWSER_V2_FIXTURE_ORIGIN_REQUIRED");
if (!process.env.BROWSER_V2_PROTECTED_KEYS_JSON && !process.env.BROWSER_V2_PROTECTED_KEY_BASE64)
  throw new Error("BROWSER_V2_PROTECTED_KEY_REQUIRED");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const userId = randomUUID();
const workspaceId = randomUUID();
const mcpToken = `scry_mcp_${randomBytes(32).toString("base64url")}`;
const protectedValueCipher = new BrowserProtectedValueCipher();
const fixtures = [
  {
    journey: "vitract",
    publicSemantics: ["credentialId", "clientId", "orderId", "orderState"],
    objective: (entryUrl: string, protectedInputIds: string[]) =>
      `Complete this entire Vitract-shaped Preview/Test journey through the browser: sign in with email operator@example.test and the pre-provisioned login_password protected reference ${protectedInputIds[0]}; bind that reference in protectedInputIds when starting the Run and use it only as a protected fill; open Applications; create exactly one credential pair; retain its client secret only as an opaque protected reference; open the API documentation; create exactly one qualification order using that credential pair; retrieve the exact created order and verify it is completed; close the browser Run, finalize it as passed, and publish the Mission report. Entry URL: ${entryUrl}`,
    limits: { authenticationCommitLimit: 2, businessCommitLimit: 4 },
  },
  {
    journey: "inventory",
    publicSemantics: ["stockId"],
    objective: (entryUrl: string, _protectedInputIds: string[]) =>
      `Use the ordinary documentation at the entry URL to understand this unfamiliar inventory application. Create exactly one stock item with the prefilled SKU, obtain its exact stock identity from the owned response, retrieve that exact item through the browser, verify identity and SKU, then close and finalize the Run and publish the Mission report. Entry URL: ${entryUrl}`,
    limits: { authenticationCommitLimit: 0, businessCommitLimit: 1 },
  },
  {
    journey: "nested",
    publicSemantics: ["resourceId"],
    objective: (entryUrl: string, _protectedInputIds: string[]) =>
      `Create exactly one resource with the prefilled exact marker. The mutation response contains nested candidate arrays and decoys: correlate the exact created identity by marker, publish that public identity, retrieve the exact resource through the browser, verify identity and marker, then close and finalize the Run and publish the Mission report. Entry URL: ${entryUrl}`,
    limits: { authenticationCommitLimit: 0, businessCommitLimit: 1 },
  },
  {
    journey: "async",
    publicSemantics: ["workspaceId", "provisioningState", "activationState"],
    objective: (entryUrl: string, _protectedInputIds: string[]) =>
      `Submit asynchronous provisioning exactly once. Use only the documented read-only status control and poll no more than five times until ready. Durably capture the operation-owned result dialog, keep the access token protected, use its opaque protected reference to activate the exact workspace once, verify activation, then close and finalize the Run and publish the Mission report. Entry URL: ${entryUrl}`,
    limits: { authenticationCommitLimit: 0, businessCommitLimit: 2 },
  },
  {
    journey: "workspace",
    publicSemantics: ["workspaceId", "verified"],
    objective: (entryUrl: string, _protectedInputIds: string[]) =>
      `Complete this browser-only workspace journey. Submit the prefilled form exactly once. The one-time recovery code is available only in the operation-owned result dialog: durably capture the dialog, keep the code protected, use its opaque protected reference to confirm the workspace exactly once, verify completion, then close and finalize the Run and publish the Mission report. Entry URL: ${entryUrl}`,
    limits: { authenticationCommitLimit: 0, businessCommitLimit: 2 },
  },
] as const;

try {
  await pool.query("BEGIN");
  await pool.query("INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3)", [
    userId,
    randomUUID(),
    `${cohort}@example.test`,
  ]);
  await pool.query("INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)", [
    workspaceId,
    "Browser v2 qualification",
    cohort
      .toLowerCase()
      .replace(/[^a-z0-9-]/gu, "-")
      .slice(0, 80),
  ]);
  await pool.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [workspaceId, userId],
  );
  await pool.query(
    `INSERT INTO mcp_access_tokens(workspace_id,user_id,name,token_hash,token_prefix,expires_at)
     VALUES($1,$2,'Isolated qualification',$3,$4,now()+interval '24 hours')`,
    [
      workspaceId,
      userId,
      createHash("sha256").update(mcpToken).digest("hex"),
      `${mcpToken.slice(0, 17)}…`,
    ],
  );
  const descriptor = { cohort, workspaceId, fixtures: [] as Array<Record<string, unknown>> };
  for (const fixture of fixtures) {
    const projectId = randomUUID();
    const environmentId = randomUUID();
    const namespace = `${cohort}-${fixture.journey}`.replace(/[^A-Za-z0-9_-]/gu, "-");
    const entryUrl = `${origin}/${fixture.journey}/${namespace}/`;
    await pool.query("INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)", [
      projectId,
      workspaceId,
      `${fixture.journey} qualification`,
    ]);
    await pool.query(
      "INSERT INTO environments(id,project_id,name,base_origin,disclosure_mode) VALUES($1,$2,$3,$4,'trusted_application_output')",
      [environmentId, projectId, `${fixture.journey} fixture`, origin],
    );
    const protectedInputIds: string[] = [];
    if (fixture.journey === "vitract") {
      const protectedValueId = randomUUID();
      const displayName = "login_password";
      const encrypted = protectedValueCipher.encrypt("fixture-login-pass", {
        projectId,
        protectedValueId,
        canonicalName: displayName,
        sourceKind: "user_input",
      });
      await pool.query(
        `INSERT INTO protected_values(id,project_id,source_kind,display_name,external_reference,ciphertext,nonce,
           authentication_tag,value_digest,key_version,state,expires_at,idempotency_key)
         VALUES($1,$2,'user_input',$3,$4,$5,$6,$7,$8,$9,'active',now()+interval '24 hours',$10)`,
        [
          protectedValueId,
          projectId,
          displayName,
          `protected://browser-v2/${protectedValueId}`,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authenticationTag,
          encrypted.valueDigest,
          encrypted.keyVersion,
          `${cohort}-login-password`,
        ],
      );
      protectedInputIds.push(protectedValueId);
    }
    const missionInstruction = fixture.objective(entryUrl, protectedInputIds);
    descriptor.fixtures.push({
      journey: fixture.journey,
      namespace,
      projectId,
      environmentId,
      entryUrl,
      oracleUrl: `${origin}/__oracle/${fixture.journey}/${namespace}`,
      protectedInputIds,
      publicSemantics: fixture.publicSemantics,
      objective: `${missionInstruction} Project ID: ${projectId}. Environment ID: ${environmentId}. Create one Mission, one required Objective, and at least one agent-directed Flow for this objective. Use the returned IDs exactly. Expected public output meanings include: ${fixture.publicSemantics.join(", ")}. The trusted application boundary authorizes contextually ordinary public values within the Run's scoped capture kinds and sinks; after the Run starts, observe that policy and propose exact meanings and paths from each durable capture's structural index. ${JSON.stringify(fixture.limits)}`,
    });
  }
  await pool.query("COMMIT");
  const serialized = `${JSON.stringify(descriptor, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized);
  if (tokenOutputPath) await writeFile(tokenOutputPath, `${mcpToken}\n`, { mode: 0o600 });
  process.stdout.write(serialized);
} catch (error) {
  await pool.query("ROLLBACK");
  throw error;
} finally {
  await pool.end();
}
