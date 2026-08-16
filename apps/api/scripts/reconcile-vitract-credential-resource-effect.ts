/**
 * R0.7 production-shaped reconciliation composition.
 *
 * This script performs one read-only supported Vitract resource listing, passes
 * only non-secret resource facts through the production adapter, and settles
 * the append-only UNKNOWN ledger. It never dispatches or retries a mutation.
 */
import { randomUUID } from "node:crypto";

import { chromium, type Response } from "playwright";

import { decryptCredential } from "../src/access/credential.crypto.js";
import { AdaptiveSessionRepository } from "../src/adaptive-sessions/adaptive-session.repository.js";
import { VitractCredentialResourceEffectAdapter } from "../src/adaptive-sessions/vitract-credential-resource-effect.adapter.js";
import { Database } from "../src/infrastructure/database.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

const sessionId = required("RECONCILIATION_SESSION_ID");
const operationId = required("RECONCILIATION_OPERATION_ID");
const missionId = required("RECONCILIATION_MISSION_ID");
const emailReference = required("RECONCILIATION_EMAIL_REFERENCE");
const passwordReference = required("RECONCILIATION_PASSWORD_REFERENCE");

const database = new Database();
const repository = new AdaptiveSessionRepository(database);

try {
  const authority = await repository.getUnknownReconciliationAuthority(null, sessionId, operationId);
  if (!authority) throw new Error("UNKNOWN_RECONCILIATION_AUTHORITY_UNAVAILABLE");
  const credentials = await database.query<{
    id: string; ciphertext: Buffer; initializationVector: Buffer; authenticationTag: Buffer;
  }>(
    `SELECT credential.id::text,credential.ciphertext,
            credential.initialization_vector AS "initializationVector",
            credential.authentication_tag AS "authenticationTag"
       FROM adaptive_sessions session
       JOIN environments environment ON environment.id=session.environment_id
       JOIN project_credentials credential ON credential.project_id=session.project_id
      WHERE session.id=$1 AND credential.id=ANY($2::uuid[])
        AND environment.secret_refs ? credential.id::text
        AND credential.security_status='active' AND credential.deleted_at IS NULL`,
    [sessionId, [emailReference, passwordReference]],
  );
  const byId = new Map(credentials.rows.map((row) => [row.id, row]));
  const decrypt = (reference: string) => {
    const row = byId.get(reference);
    if (!row) throw new Error("RECONCILIATION_LOGIN_REFERENCE_UNAVAILABLE");
    return decryptCredential(row);
  };
  let email = decrypt(emailReference);
  let password = decrypt(passwordReference);
  const browserChannel = process.env.SCRY_BROWSER_CHANNEL ?? "chrome";
  const browser = await chromium.launch({
    headless: true,
    ...(browserChannel === "chromium" ? {} : { channel: browserChannel }),
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://preview.vitract.com/login", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByPlaceholder("Enter your email", { exact: true }).fill(email);
    await page.getByPlaceholder("Enter your password", { exact: true }).fill(password);
    email = ""; password = "";
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await page.waitForURL((url) => url.origin === "https://preview.vitract.com" && url.pathname !== "/login", { timeout: 30_000 });

    const adapter = new VitractCredentialResourceEffectAdapter(async ({ resourceScope }) => {
      const responses: Array<Promise<unknown | undefined>> = [];
      const listener = (response: Response) => {
        if (response.request().method() !== "GET" || response.status() < 200 || response.status() >= 300) return;
        const responseUrl = new URL(response.url());
        if (!["https://preview.vitract.com", "https://preview-api.vitract.com"].includes(responseUrl.origin)
          || responseUrl.pathname !== `/api/v1/partners/applications/${encodeURIComponent(resourceScope)}/credentials`) return;
        responses.push(response.json().catch(() => undefined));
      };
      page.on("response", listener);
      try {
        await page.goto(`https://preview.vitract.com/partner/developer/applications/${encodeURIComponent(resourceScope)}/credentials`,
          { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.getByRole("button", { name: "Add credential", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForTimeout(750);
      } finally {
        page.off("response", listener);
      }
      const records = (await Promise.all(responses)).flatMap(providerRecords);
      if (responses.length === 0) throw new Error("VITRACT_AUTHORITATIVE_RESOURCE_RESPONSE_UNAVAILABLE");
      const unique = new Map(records.map((record) => [record.identity, record]));
      return {
        source: "authoritative_supported_resource_listing" as const,
        observationId: randomUUID(),
        records: [...unique.values()],
      };
    });
    if (!adapter.supports(authority)) throw new Error("VITRACT_RESOURCE_EFFECT_CONTRACT_UNAVAILABLE");
    const reconciliationKey = `resource-effect-${randomUUID()}`;
    const claim = await repository.beginUnknownReconciliation({
      workspaceId: null, sessionId, missionId, operationId,
      idempotencyKey: reconciliationKey,
    });
    if (claim.state !== "observing") throw new Error("RECONCILIATION_ATTEMPT_NOT_OBSERVING");
    const observation = await adapter.observe(authority);
    const settled = await repository.completeUnknownReconciliation({
      sessionId, missionId, operationId, idempotencyKey: reconciliationKey,
      result: observation.result,
      reasonCode: observation.reasonCode,
      evidence: observation.evidence,
      runtimeOwned: false,
    });
    process.stdout.write(JSON.stringify({
      result: observation.result,
      reasonCode: observation.reasonCode,
      resource: "resource" in observation ? observation.resource : undefined,
      outputState: "outputState" in observation ? observation.outputState : undefined,
      missionFenceCleared: settled.missionFenceCleared,
    }) + "\n");
  } finally {
    email = ""; password = "";
    await browser.close();
  }
} finally {
  await database.onModuleDestroy();
}

function providerRecords(value: unknown): Array<{ identity: string; label: string; state: string }> {
  const records: Array<{ identity: string; label: string; state: string }> = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
    if (!candidate || typeof candidate !== "object") return;
    const object = candidate as Record<string, unknown>;
    if (typeof object.id === "string" && typeof object.label === "string" && Object.hasOwn(object, "clientId"))
      records.push({ identity: object.id, label: object.label, state: typeof object.status === "string" ? object.status : "present" });
    Object.values(object).forEach(visit);
  };
  visit(value);
  return records;
}
