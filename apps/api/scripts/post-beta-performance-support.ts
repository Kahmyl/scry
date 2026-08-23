import { randomUUID } from "node:crypto";

import { currentPlanSchema, type PraxisObservation } from "@scry/contracts";
import pg from "pg";

import {
  adaptiveFixturePlan,
  generatedCoreCampaignSpec,
  type CampaignContext,
} from "./adaptive-campaign-support.js";
import { initializeMcp, rejectToolError } from "./deployed-adaptive-campaign.js";

export const POST_BETA_SCENARIO = { id: "ordinary-agent-directed-fixture", version: 1 } as const;

export type PerformanceJourney = {
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  flowDraftId: string;
  flowRevisionId: string;
  fixtureOrigin: string;
};

export async function provisionPerformanceJourney(
  context: CampaignContext,
): Promise<PerformanceJourney> {
  await generatedCoreCampaignSpec(context, "M1");
  const projectId = required(context.campaignProjectId, "CAMPAIGN_PROJECT_ID_MISSING");
  const environmentId = required(context.campaignEnvironmentId, "CAMPAIGN_ENVIRONMENT_ID_MISSING");
  const missionId = required(context.campaignMissionId, "CAMPAIGN_MISSION_ID_MISSING");
  const objectiveId = required(context.campaignObjectiveId, "CAMPAIGN_OBJECTIVE_ID_MISSING");
  const agentSessionId = required(
    context.campaignAgentSessionId,
    "CAMPAIGN_AGENT_SESSION_ID_MISSING",
  );
  const flowDraftId = required(context.campaignFlowDraftId, "CAMPAIGN_FLOW_DRAFT_ID_MISSING");
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const source = adaptiveFixturePlan(context.fixture.origin);
  const selected = new Set(["navigate", "malformed", "details"]);
  const plan = currentPlanSchema.parse({
    ...source,
    name: "Ordinary agent-directed fixture",
    objective: "Exercise one referenced control and verify Execution complete",
    steps: source.steps.filter((step) => selected.has(step.id)),
  });
  const content = {
    objective: plan.objective,
    preconditions: [],
    expectedOutcomes: ["The Execution complete heading is observed"],
    prohibitedSideEffects: ["Do not use credentials or mutate an external provider"],
  };
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO flows(
         id,project_id,name,description,latest_revision_id,visibility,purpose,
         origin_mission_id,origin_objective_id,owner_mission_id,owner_objective_id,
         created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,'mission_local','primary',$6,$7,$6,$7,$8)`,
      [
        flowId,
        projectId,
        `Ordinary performance fixture ${context.campaignId}`,
        "Item 08 canonical current-lifecycle performance journey",
        flowRevisionId,
        missionId,
        objectiveId,
        agentSessionId,
      ],
    );
    await client.query(
      `INSERT INTO flow_revisions(
         id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason,
         publication_state
       ) VALUES($1,$2,1,$3::jsonb,$4::jsonb,'{"valid":true}'::jsonb,$5,$6,'published')`,
      [
        flowRevisionId,
        flowId,
        JSON.stringify(content),
        JSON.stringify(plan),
        agentSessionId,
        "Canonical Item 08 performance fixture",
      ],
    );
    await client.query(
      `INSERT INTO mission_flow_links(
         mission_id,objective_id,flow_id,visibility,purpose,reason,created_by_agent_session_id
       ) VALUES($1,$2,$3,'mission_local','primary',$4,$5)`,
      [missionId, objectiveId, flowId, "Canonical Item 08 performance fixture", agentSessionId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  return {
    projectId,
    environmentId,
    missionId,
    objectiveId,
    agentSessionId,
    flowDraftId,
    flowRevisionId,
    fixtureOrigin: context.fixture.origin,
  };
}

export async function runScriptedPerformanceJourney(
  input: PerformanceJourney & {
    correlationId: string;
    onCall?: (name: string, durationMs: number, bytes: number) => void;
    onFailure?: (name: string, facts: Record<string, unknown>) => void;
  },
) {
  const mcp = await initializeMcp();
  let praxisSessionId = "";
  let runId = "";
  let closed = false;
  const calls: Array<{ name: string; durationMs: number; bytes: number }> = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const startedAt = performance.now();
    const response = await mcp.call({ name, arguments: args });
    const durationMs = performance.now() - startedAt;
    const bytes = Buffer.byteLength(JSON.stringify(response));
    calls.push({ name, durationMs, bytes });
    input.onCall?.(name, durationMs, bytes);
    try {
      rejectToolError(response);
    } catch (error) {
      input.onFailure?.(name, publicFailureFacts(response));
      const reasonCode = responseReasonCode(response);
      throw new Error(
        `PERFORMANCE_${safeCode(name)}_${reasonCode ?? safeCode(error instanceof Error ? error.message : String(error))}`,
      );
    }
    return structured(response);
  };
  try {
    const started = await call("start_praxis_session", {
      projectId: input.projectId,
      environmentId: input.environmentId,
      missionId: input.missionId,
      objectiveId: input.objectiveId,
      flowDraftId: input.flowDraftId,
      agentSessionId: input.agentSessionId,
      objective: "Exercise one referenced control and verify the Execution complete heading",
      allowedOrigins: [input.fixtureOrigin],
      correlationId: input.correlationId,
      protection: "ordinary",
      idempotencyKey: `performance-praxis-${input.correlationId}`,
    });
    praxisSessionId = object(started.session).id as string;
    let observation = observationFrom(await call("observe_praxis_session", { praxisSessionId }));
    const opened = await call("start_run", {
      projectId: input.projectId,
      missionId: input.missionId,
      objectiveId: input.objectiveId,
      agentSessionId: input.agentSessionId,
      environmentId: input.environmentId,
      flowRevisionId: input.flowRevisionId,
      praxisSessionId,
      role: "candidate",
      idempotencyKey: `performance-run-${input.correlationId}`,
    });
    runId = object(opened.run).runId as string;
    for (const [index, operation] of [
      { kind: "activate" as const, role: "button", name: "Open controls" },
      { kind: "navigate" as const, url: `${input.fixtureOrigin}/details` },
    ].entries()) {
      const control =
        operation.kind === "activate"
          ? exactControl(observation, operation.role, operation.name)
          : undefined;
      await call("dispatch_run_operation", {
        runId,
        praxisSessionId,
        intent: {
          intentId: `performance-intent-${index + 1}`,
          objectiveId: input.objectiveId,
          flowDraftId: input.flowDraftId,
          action:
            operation.kind === "navigate"
              ? { kind: "navigate", url: operation.url }
              : {
                  kind: "activate",
                  activationMechanism: "dom",
                  target: {
                    concept: "open_controls",
                    reference: control!.reference,
                    role: control!.role,
                    name: control!.name,
                  },
                },
          expectedEffect:
            operation.kind === "navigate"
              ? { kind: "navigation", url: operation.url, match: "exact" }
              : { kind: "none" },
          constraints: { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false },
          authorization: { kind: "ordinary" },
          protectedInputReferences: [],
        },
      });
      observation = observationFrom(await call("observe_praxis_session", { praxisSessionId }));
    }
    exactControl(observation, "heading", "Execution complete");
    const finalized = await call("finalize_run", {
      runId,
      praxisSessionId,
      outcome: "passed",
      reason: "Execution complete heading observed on the current document",
      idempotencyKey: `performance-finalize-${input.correlationId}`,
    });
    await call("close_praxis_session", {
      praxisSessionId,
      idempotencyKey: `performance-close-${input.correlationId}`,
    });
    closed = true;
    return { calls, praxisSessionId, runId, observation, finalized };
  } finally {
    if (praxisSessionId && !closed) {
      await call("close_praxis_session", {
        praxisSessionId,
        idempotencyKey: `performance-cleanup-${input.correlationId}`,
      }).catch(() => undefined);
    }
    await mcp.close();
  }
}

export async function performanceJourneyOracle(input: PerformanceJourney) {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const result = await pool.query<{
      passedRun: boolean;
      completedPraxis: boolean;
      completedOperations: number;
    }>(
      `SELECT
         EXISTS(
           SELECT 1 FROM runs
            WHERE mission_id=$1 AND objective_id=$2 AND flow_revision_id=$3 AND state='passed'
         ) AS "passedRun",
         EXISTS(
           SELECT 1 FROM adaptive_sessions
            WHERE mission_id=$1 AND objective_id=$2 AND state='completed'
         ) AS "completedPraxis",
         (SELECT count(*)::int FROM run_operation_links link
           JOIN runs run ON run.id=link.run_id
          WHERE run.mission_id=$1 AND run.objective_id=$2
            AND link.safe_result->>'functionalResult'='succeeded') AS "completedOperations"`,
      [input.missionId, input.objectiveId, input.flowRevisionId],
    );
    const facts = result.rows[0] ?? {
      passedRun: false,
      completedPraxis: false,
      completedOperations: 0,
    };
    return {
      ...facts,
      scenarioCompleted: facts.passedRun && facts.completedPraxis && facts.completedOperations >= 2,
    };
  } finally {
    await pool.end();
  }
}

function exactControl(observation: PraxisObservation, role: string, name: string) {
  const matches = observation.semanticPageContext.controls.filter(
    (control) => control.role === role && control.name === name,
  );
  if (matches.length !== 1) throw new Error(`PERFORMANCE_EXACT_CONTROL_${safeCode(name)}_MISSING`);
  return matches[0]!;
}

function observationFrom(value: Record<string, unknown>): PraxisObservation {
  return value.observation as PraxisObservation;
}

function structured(value: unknown): Record<string, unknown> {
  const outer = object(value);
  const result = object(outer.result);
  return object(result.structuredContent);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PERFORMANCE_MCP_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function responseReasonCode(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = responseReasonCode(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["reasonCode", "code"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && /^[A-Z][A-Z0-9_]{3,}$/.test(candidate)) return candidate;
  }
  for (const candidate of Object.values(record)) {
    const found = responseReasonCode(candidate);
    if (found) return found;
  }
  return undefined;
}

function publicFailureFacts(value: unknown): Record<string, unknown> {
  const outer = asObject(value);
  const result = asObject(outer?.result);
  const structuredContent = asObject(result?.structuredContent);
  const rejection = structuredContent?.rejection;
  const error = outer?.error;
  return {
    ...(typeof result?.isError === "boolean" ? { isError: result.isError } : {}),
    ...(rejection && typeof rejection === "object" ? { rejection } : {}),
    ...(error && typeof error === "object" ? { error } : {}),
    ...(typeof structuredContent?.message === "string"
      ? { message: structuredContent.message.slice(0, 500) }
      : {}),
    ...(Array.isArray(result?.content)
      ? {
          content: result.content
            .filter((entry): entry is { type: "text"; text: string } =>
              Boolean(
                entry &&
                typeof entry === "object" &&
                (entry as Record<string, unknown>).type === "text" &&
                typeof (entry as Record<string, unknown>).text === "string",
              ),
            )
            .map((entry) => entry.text.slice(0, 500))
            .slice(0, 2),
        }
      : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function databaseUrl() {
  return process.env.DATABASE_URL ?? "postgresql://scry:scry@127.0.0.1:54329/scry";
}

function required(value: string | undefined, code: string) {
  if (!value) throw new Error(code);
  return value;
}

function safeCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}
