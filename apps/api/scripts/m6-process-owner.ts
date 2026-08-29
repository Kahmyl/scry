import { createHash, randomUUID } from "node:crypto";

import { openPraxisBrowserSession, navigateAndWaitNative } from "@scry/praxis";

import { Database } from "../src/infrastructure/index.js";
import { ProtectedOperationRepository } from "../src/runtime/repositories/protected-operation.repository.js";
import { QualificationCampaignRepository } from "../src/runtime/repositories/qualification-campaign.repository.js";

const [mode, runId, operationId, mutationIdentity, fixtureOrigin, adaptiveSessionId] =
  process.argv.slice(2);
if (!mode) throw new Error("M6_PROCESS_MODE_REQUIRED");

const database = new Database();
const campaigns = new QualificationCampaignRepository(database);
const protectedOperations = new ProtectedOperationRepository(database);

try {
  if (mode === "before_consumption") {
    ready(mode);
  } else if (mode === "after_consumption") {
    await consume();
    ready(mode);
  } else if (mode === "request_initiated") {
    await consume();
    const cookie = await authenticate();
    void createResource(cookie);
    ready(mode);
  } else if (mode === "after_external_commit") {
    await consume();
    const cookie = await authenticate();
    await createResource(cookie).catch(() => undefined);
    ready(mode);
  } else if (mode === "after_verification") {
    await consume();
    const cookie = await authenticate();
    await createResource(cookie);
    const response = await fetch(
      `${fixtureOrigin}/api/resources/by-idempotency/${mutationIdentity}`,
      {
        headers: { cookie },
      },
    );
    if (!response.ok) throw new Error("M6_OWNER_VERIFICATION_FAILED");
    const digest = createHash("sha256")
      .update(await response.text())
      .digest("hex");
    ready(mode, { observationDigest: digest });
  } else if (mode === "after_settlement") {
    await consume();
    const cookie = await authenticate();
    await createResource(cookie);
    await campaigns.settleMutation(required(runId), required(operationId), "applied");
    ready(mode);
  } else if (mode === "run_finalization") {
    await campaigns.settleRun(required(runId), "succeeded");
    ready(mode);
  } else if (mode === "run_attempt_owner") {
    const attemptId = randomUUID();
    const claimToken = randomUUID();
    await database.transaction(async (client) => {
      await client.query(
        `INSERT INTO attempts(
           id,run_id,attempt_number,state,started_at,heartbeat_at,worker_id,claim_token
         ) VALUES($1,$2,1,'running',now(),now(),'m6-killed-worker',$3)`,
        [attemptId, required(runId), claimToken],
      );
      await client.query(
        `UPDATE runs SET state='running',phase='executing_action',updated_at=now() WHERE id=$1`,
        [required(runId)],
      );
    });
    ready(mode, { attemptId, claimToken });
  } else if (mode === "reconciliation_owner") {
    const claim = await database.query<{ id: string; fencingToken: number }>(
      `INSERT INTO adaptive_operation_reconciliations(
         session_id,operation_id,mission_id,objective_id,flow_draft_id,idempotency_key,
         request_digest,attempt,state,strategy,expected_effect,original_outcome,lease_expires_at
       ) SELECT operation.session_id,operation.operation_id,operation.mission_id,
                operation.objective_id,operation.flow_draft_id,$3,$4,
                COALESCE(max(reconciliation.attempt),0)+1,'observing',
                CASE WHEN operation.expected_effect->>'type'='none'
                     THEN 'unavailable' ELSE 'browser_effect' END,
                operation.expected_effect,operation.safe_outcome,
                now()+interval '750 milliseconds'
           FROM adaptive_operations operation
           LEFT JOIN adaptive_operation_reconciliations reconciliation
             ON reconciliation.session_id=operation.session_id
            AND reconciliation.operation_id=operation.operation_id
          WHERE operation.session_id=$1 AND operation.operation_id=$2
          GROUP BY operation.session_id,operation.operation_id,operation.mission_id,
                   operation.objective_id,operation.flow_draft_id,operation.expected_effect,
                   operation.safe_outcome
       RETURNING id,fencing_token AS "fencingToken"`,
      [
        required(adaptiveSessionId),
        required(operationId),
        required(mutationIdentity),
        "a".repeat(64),
      ],
    );
    ready(mode, {
      reconciliationId: claim.rows[0]!.id,
      fencingToken: claim.rows[0]!.fencingToken,
      idempotencyKey: mutationIdentity,
    });
  } else if (mode === "protected_operation_owner") {
    let claim = await protectedOperations.claim({
      ownerKind: "authoring_session",
      ownerId: required(adaptiveSessionId),
      operationId: required(operationId),
      leaseOwner: `m6-protected-owner-${process.pid}`,
      leaseDurationMs: 750,
      binding: protectedBinding(),
    });
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const)
      claim = await protectedOperations.transition({
        id: claim.id,
        leaseOwner: claim.leaseOwner!,
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    ready(mode, {
      protectedOperationId: claim.id,
      leaseOwner: claim.leaseOwner,
      fencingToken: claim.fencingToken,
      version: claim.version,
    });
  } else if (mode === "runtime_lease_owner") {
    const ownerId = randomUUID();
    const lease = await database.query<{ fencingToken: number }>(
      `INSERT INTO adaptive_session_runtime_leases(session_id,owner_id,fencing_token,lease_expires_at)
       VALUES($1,$2,1,now()+interval '750 milliseconds')
       ON CONFLICT(session_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,
         fencing_token=adaptive_session_runtime_leases.fencing_token+1,
         lease_expires_at=EXCLUDED.lease_expires_at,claimed_at=now(),heartbeat_at=now()
       WHERE adaptive_session_runtime_leases.lease_expires_at<=now()
       RETURNING fencing_token AS "fencingToken"`,
      [required(adaptiveSessionId), ownerId],
    );
    if (!lease.rowCount) throw new Error("M6_RUNTIME_LEASE_HELD");
    ready(mode, {
      ownerId,
      fencingToken: lease.rows[0]!.fencingToken,
    });
  } else if (mode === "browser_owner") {
    const opened = await openPraxisBrowserSession({
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    await navigateAndWaitNative(
      opened.page,
      `${required(fixtureOrigin)}/docs`,
      [fixtureOrigin!],
      10_000,
    );
    ready(mode);
  } else if (mode === "agent_owner") {
    const updated = await database.query(
      `UPDATE agent_sessions SET heartbeat_at=now(),lease_expires_at=now()+interval '750 milliseconds'
        WHERE id=$1 AND status='active' RETURNING id`,
      [required(adaptiveSessionId)],
    );
    if (!updated.rowCount) throw new Error("M6_AGENT_OWNER_UNAVAILABLE");
    ready(mode);
  } else {
    throw new Error(`M6_PROCESS_MODE_UNKNOWN:${mode}`);
  }
  await new Promise<void>(() => {
    setInterval(() => undefined, 60_000);
  });
} finally {
  await database.onModuleDestroy();
}

async function consume() {
  await campaigns.consumeBusinessMutation({
    runId: required(runId),
    operationId: required(operationId),
    mutationIdentity: required(mutationIdentity),
  });
}

async function authenticate() {
  const response = await fetch(`${required(fixtureOrigin)}/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "m6-local-user",
      password: process.env.M6_FIXTURE_PASSWORD!,
    }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("M6_OWNER_AUTHENTICATION_FAILED");
  return cookie;
}

function createResource(cookie: string) {
  return fetch(`${required(fixtureOrigin)}/api/resources`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": required(mutationIdentity),
      "x-operation-correlation": required(operationId),
    },
    body: JSON.stringify({ label: "m6 process-loss resource", quantity: 1 }),
  }).then((response) => {
    if (!response.ok) throw new Error(`M6_OWNER_HTTP_${response.status}`);
    return response;
  });
}

function ready(phase: string, facts: Record<string, unknown> = {}) {
  process.stdout.write(
    `${JSON.stringify({ phase, pid: process.pid, timestamp: new Date().toISOString(), ...facts })}\n`,
  );
}

function required(value: string | undefined): string {
  if (!value) throw new Error("M6_PROCESS_ARGUMENT_REQUIRED");
  return value;
}

function protectedBinding() {
  return {
    mutationIdentity: required(mutationIdentity),
    projectId: required(process.env.M6_PROJECT_ID),
    environmentId: required(process.env.M6_ENVIRONMENT_ID),
    missionId: required(process.env.M6_MISSION_ID),
    objectiveId: required(process.env.M6_OBJECTIVE_ID),
    agentSessionId: required(process.env.M6_AGENT_SESSION_ID),
    programDigest: "a".repeat(64),
    flowDraftId: required(process.env.M6_FLOW_DRAFT_ID),
    authorizationId: required(process.env.M6_PROTECTED_AUTHORIZATION_ID),
    safeOutputManifest: [],
  };
}
