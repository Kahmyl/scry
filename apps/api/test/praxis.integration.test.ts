import { randomUUID } from "node:crypto";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { Database } from "../src/infrastructure/database.js";
import {
  AuthoringRuntimeCommandRepository,
  AuthoringRuntimeRepository,
} from "../src/authoring/index.js";
import { createAuthoringRuntimeOwner } from "../src/workers/index.js";
import { createAuthoringBrowserSession } from "@scry/executor";
import { PraxisRuntimeRepository } from "../src/praxis/index.js";
import { createPraxisProcessor } from "../src/workers/index.js";

const enabled = Boolean(process.env.SCRY_AUTHORING_TEST_DATABASE_URL);

describe.skipIf(!enabled)("Praxis candidate inspection lifecycle", () => {
  let database: Database;
  let repository: PraxisRuntimeRepository;

  const requestId = randomUUID();
  const probeSessionId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;

    database = new Database();
    repository = new PraxisRuntimeRepository(database);

    await database.query(
      `INSERT INTO praxis_candidate_requests(
        id,
        status,
        payload
      )
      VALUES($1,'queued',$2::jsonb)`,
      [
        requestId,
        JSON.stringify({
          intent: {
            concept: "Continue",
          },
          allowedOrigins: ["https://example.com"],
          probeSessionId,
        }),
      ],
    );
  });

  afterAll(async () => {
    await database.query(
      `DELETE FROM praxis_candidate_requests WHERE id=$1`,
      [requestId],
    );

    await database.onModuleDestroy();
  });

  it("claims, completes, and reads a Praxis inspection request", async () => {
    const runtime = await repository.claim(
      requestId,
      "worker-1",
      "claim-token",
    );

    expect(runtime).toMatchObject({
      id: requestId,
      workerId: "worker-1",
      claimToken: "claim-token",
    });

    await repository.complete(runtime!, {
      resolution: "resolved",
      candidates: [],
    });

    await expect(repository.get(requestId)).resolves.toMatchObject({
      id: requestId,
      status: "completed",
      result: {
        resolution: "resolved",
      },
    });
  });

  it("routes a claimed request through the owned authoring runtime boundary", async () => {
    const projectId = randomUUID();
    const draftId = randomUUID();
    const missionId = randomUUID();
    const objectiveId = randomUUID();
    const environmentId = randomUUID();
    const agentSessionId = randomUUID();
    const probeSessionId = randomUUID();
    const browserLeaseId = randomUUID();

    await database.query(
      `INSERT INTO projects(id,workspace_id,name)
       VALUES($1,'00000000-0000-4000-8000-000000000001',$2)`,
      [projectId, `praxis-${projectId}`],
    );

    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Preview','https://example.com',$3::jsonb)`,
      [
        environmentId,
        projectId,
        JSON.stringify({
          allowedOrigins: ["https://example.com"],
          allowPrivateNetwork: false,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 5,
          maxDurationMs: 30000,
          maxNavigations: 1,
        }),
      ],
    );

    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction)
       VALUES($1,$2,'Praxis test','Praxis test')`,
      [missionId, projectId],
    );

    await database.query(
      `INSERT INTO mission_objectives(
         id,mission_id,title,dependencies,completion_criteria,objective_order
       )
       VALUES($1,$2,'Objective','[]','[]',0)`,
      [objectiveId, missionId],
    );

    await database.query(
      `INSERT INTO agent_sessions(
         id,mission_id,provider,instruction_snapshot,idempotency_key
       )
       VALUES($1,$2,'scry_agent','Praxis test',$3)`,
      [agentSessionId, missionId, `session-${agentSessionId}`],
    );

    await database.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,created_by_agent_session_id,name,version,state,content,plan
       )
       VALUES($1,$2,$3,$4,$5,$6,'Praxis test',1,'editing',$7::jsonb,$8::jsonb)`,
      [
        draftId,
        projectId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        JSON.stringify({}),
        JSON.stringify({}),
      ],
    );

    await database.query(
      `INSERT INTO probe_sessions(
        id,
        draft_id,
        mission_id,
        objective_id,
        environment_id,
        draft_version,
        level,
        state,
        mode,
        created_by_agent_session_id,
        idempotency_key
      )
      VALUES(
        $1,
        $2,
        $3,
        $4,
        $5,
        1,
        'inspection',
        'running',
        'interactive',
        $6,
        $7
      )`,
      [
        probeSessionId,
        draftId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        `probe-${probeSessionId}`,
      ],
    );

    await database.query(
      `INSERT INTO authoring_browser_leases(
        id,
        probe_session_id,
        state,
        runtime_owner_id,
        expires_at
      )
      VALUES($1,$2,'active','worker-1',now()+interval '10 minutes')`,
      [browserLeaseId, probeSessionId],
    );

    await database.query(
      `INSERT INTO probe_authoring_sessions(
        probe_session_id,
        browser_lease_id,
        status,
        action_budget,
        duration_budget_ms,
        deadline_at
      )
      VALUES($1,$2,'active',5,30000,now()+interval '10 minutes')`,
      [probeSessionId, browserLeaseId],
    );

    await database.query(
      `UPDATE praxis_candidate_requests
       SET payload=$2::jsonb
       WHERE id=$1`,
      [
        requestId,
        JSON.stringify({
          intent: {
            concept: "Continue",
          },
          allowedOrigins: ["https://example.com"],
          probeSessionId,
        }),
      ],
    );

    const processor = createPraxisProcessor({
      workerId: "worker-1",
      releaseId: "development",
      schemaFingerprint: "development-baseline",
      praxis: repository,
      authoringRuntimeOwner: {
        inspect: async () => ({
          resolution: "resolved",
          candidates: [],
          policy: {
            allowsAgentCandidateChoice: false,
            allowsSelectorHint: false,
            requiresExplicitAuthorization: false,
          },
          diagnostic: {
            intentDigest: "a".repeat(64),
            documentEpoch: 1,
          },
        }),
      } as never,
    });

    await processor({
      data: {
        requestId,
        releaseId: "development",
        schemaFingerprint: "development-baseline",
      },
    } as never);

    await expect(repository.get(requestId)).resolves.toMatchObject({
      status: "completed",
    });
  });


});
