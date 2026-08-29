import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { stableJson } from "../q0/validator.js";

const q0Digest = "7bf1cd5316faae2d572aa1edb89f5a8a094b076c98be846a8860f2efce0f2230";
const q1Digest = "d01fc4984fc4c4aae7ead2be25eb4b0493fc51e8359b2fd2037aec2e47334668";
const q2Digest = "044a4d3506750c60b7f3f802e0a0f57bf1d3e9383dc25786a24c9d98c8da4357";
const q3Digest = "424293abdc31046dac4879a3e7c29bea8bc32e3a600b68317f350f79cdc51112";
const q3OracleDigest = "94d9d95852f91f99f0e610b6ce66dac7fef0f35230d7fbc831acfc68bf2ddf7f";

export async function createM6Report(root: string) {
  const output = path.join(root, "artifacts/system-correctness/m6");
  const processEvidence = JSON.parse(
    await readFile(path.join(output, "q4-process-evidence.json"), "utf8"),
  ) as {
    processDeathMechanism: string;
    processes: Array<Record<string, unknown> & { phase: string; pid: number }>;
  };
  const q5 = JSON.parse(
    await readFile(path.join(output, "q5-agent/q5-agent-result.json"), "utf8"),
  ) as any;
  const transcriptPath = path.join(
    output,
    "q5-agent",
    `primary-${q5.agent.externalRunId}`,
    "transcript.jsonl",
  );
  const transcript = (await readFile(transcriptPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as any);
  const snapshot = transcript.find(({ event }) => event === "mcp_snapshot")?.data;
  const toolMetadataDigest = createHash("sha256")
    .update(
      stableJson({
        protocolVersion: snapshot?.protocolVersion,
        serverInfo: snapshot?.serverInfo,
        tools: snapshot?.tools,
      }),
    )
    .digest("hex");
  const toolCalls = transcript
    .filter(({ event }) => event === "tool_call")
    .map(({ data }) => ({ turn: data.turn, tool: data.tool }));
  const requiredProcessPhases = [
    "before_consumption",
    "after_consumption",
    "request_initiated",
    "after_external_commit",
    "after_verification",
    "after_settlement",
    "run_finalization",
    "browser_owner",
    "runtime_lease_owner",
    "agent_owner",
    "run_attempt_owner",
    "reconciliation_owner",
    "protected_operation_owner",
  ];
  const processPass =
    processEvidence.processDeathMechanism === "detached OS process group SIGKILL" &&
    requiredProcessPhases.every((phase) =>
      processEvidence.processes.some((process) => process.phase === phase),
    ) &&
    new Set(processEvidence.processes.map(({ pid }) => pid)).size ===
      processEvidence.processes.length &&
    processEvidence.processes
      .filter(({ oracle }) => oracle)
      .every(({ oracle, scry }) => {
        const observed = oracle as { effects?: number; requests?: number };
        const durable = scry as { mutationsConsumed?: number };
        return (
          (observed.effects ?? 0) <= 1 &&
          (observed.requests ?? 0) <= 1 &&
          (durable.mutationsConsumed ?? 0) <= 1
        );
      });
  const q5Pass =
    q5.oracle.resources.length === 1 &&
    q5.oracle.mutationRequests.length === 1 &&
    q5.campaign.runCount === 1 &&
    q5.campaign.runsConsumed === 1 &&
    q5.campaign.mutationsConsumed === 1 &&
    q5.campaign.disposition === "succeeded" &&
    q5.protectedLeakCount === 0;
  const externalQualification = {
    q4ProcessSuite: process.env.SCRY_M6_Q4_RESULT === "PASS" ? "PASS" : "NOT_ATTESTED",
    q5McpAdversarySuite:
      process.env.SCRY_M6_MCP_ADVERSARY_RESULT === "PASS" ? "PASS" : "NOT_ATTESTED",
    q04PostgresSuite: process.env.SCRY_M6_Q04_POSTGRES_RESULT === "PASS" ? "PASS" : "NOT_ATTESTED",
  } as const;
  const q04Pass =
    externalQualification.q04PostgresSuite === "PASS" &&
    externalQualification.q5McpAdversarySuite === "PASS";
  const q4Pass = processPass && externalQualification.q4ProcessSuite === "PASS";
  const q5ProductSafetyPass =
    q04Pass &&
    q5.campaign.runCount === 1 &&
    q5.campaign.runsConsumed === 1 &&
    q5.campaign.consumptionCount === 1 &&
    q5.campaign.mutationsConsumed === 1 &&
    q5.oracle.mutationRequests.length <= 1 &&
    q5.oracle.resources.length <= 1 &&
    q5.protectedLeakCount === 0;
  const implementationPass = q04Pass && q4Pass && q5ProductSafetyPass;
  const closurePass = implementationPass && q5Pass;

  const report = {
    reportSchemaVersion: 1,
    qualification: "Q4 + Q5",
    milestone: 6,
    source: {
      head: git(root, ["rev-parse", "HEAD"]),
      headSubject: git(root, ["show", "-s", "--format=%s", "HEAD"]),
      schemaFingerprint: execFileSync("node", [path.join(root, "scripts/schema-fingerprint.mjs")], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      q0Digest,
      q1Digest,
      q2Digest,
      q3Digest,
      q3OracleDigest,
    },
    verdicts: {
      milestone6Implementation: implementationPass ? "PASS" : "FAIL",
      m6ClosureReview: closurePass ? "PASS" : "FAIL",
      q04MechanicalCampaignSafety: q04Pass ? "PASS" : "FAIL",
      q4ProcessLoss: q4Pass ? "PASS" : "BLOCKED",
      q5RepositoryBlindAgent: q5Pass ? "PASS" : "BLOCKED",
      m6ProductGate: closurePass ? "PASS" : "BLOCKED",
      progression: closurePass ? "ELIGIBLE_FOR_MILESTONE_7" : "BLOCKED",
    },
    campaignAuthorization: {
      model:
        "human-owned, exact-scope, local-test qualification authorization; one Run and one possible business mutation",
      durableFields: [
        "project/environment/mission/objective/agent session",
        "purpose/mode/target origin/application identity",
        "owner/release/schema/expiry",
        "Run and mutation limits/counters/disposition",
      ],
      runConsumption:
        "row-locked in the Run insertion transaction; unique campaign Run index plus all-writer database trigger",
      mutationConsumption:
        "row-locked and journaled at the final pre-dispatch capability boundary; idempotent only for the exact operation/mutation identity",
      scope:
        "exact Project, environment, Mission, Objective, agent, and canonical environment origin",
      expiry: "checked under the same PostgreSQL row lock as consumption",
      terminalDisposition:
        "success, failure, inconclusive/UNKNOWN, expiry, and revocation never restore consumed allowance",
      rollout:
        "migration first, then API/worker/MCP; old code tolerates nullable new schema, new code requires migrated schema",
    },
    q04: {
      productProofSource:
        "production repositories, Flow/API/MCP admission, execution capabilities, and PostgreSQL constraints/triggers",
      negativeCases: {
        A: "second Run after success refused",
        B: "second Run after failure refused",
        C: "second Run after inconclusive/UNKNOWN refused",
        D: "second business mutation in live Run refused before fixture request",
        E: "new Run after prior UNKNOWN refused",
        F: "concurrent Run race has one winner",
        G: "concurrent mutation race has one winner",
        H: "expired campaign refused",
        I: "wrong Project refused",
        J: "wrong environment refused",
        K: "wrong target origin refused",
      },
      repetitions: { runRaces: 5, expiryRaces: 5, terminalMutationRacesPerDisposition: 5 },
      externalQualification,
    },
    q4: {
      processDeathMechanism: processEvidence.processDeathMechanism,
      processCount: processEvidence.processes.length,
      uniquePidCount: new Set(processEvidence.processes.map(({ pid }) => pid)).size,
      processes: processEvidence.processes,
      killPoints: [
        ["P1", "B4", "before_consumption"],
        ["P2", "B4", "after_consumption"],
        ["P3", "B5", "request_initiated"],
        ["P4", "B6", "after_external_commit"],
        ["P5", "B7/B8", "after_verification"],
        ["P6", "B9/B10", "after_settlement"],
        ["P7", "B11/B12", "after_verification"],
        ["P8", "B13/B14", "run_finalization"],
        ["P9", "B15", "no separate Objective acceptance process boundary"],
        ["P10", "B19", "browser_owner/runtime_lease_owner"],
        ["P11", "B18/B19", "runtime_lease_owner"],
        ["P12", "B18", "agent_owner/run_attempt_owner"],
      ],
      staleOwnersExercised: [
        "Praxis runtime lease",
        "Run/Attempt claim",
        "reconciliation fence",
        "protected-operation fence",
      ],
      reconciliation: "observation-only; uncertain effects were never redispatched",
      lifecycleConvergence:
        "expired owners were replaced or terminalized; expected UNKNOWN/recovery remained fenced",
    },
    q5: {
      agent: {
        provider: q5.agent.provider,
        model: q5.agent.model,
        externalRunId: q5.agent.externalRunId,
        repositoryBlindness: q5.agent.repositoryBlindness,
        objective:
          "discover local documentation, authenticate through Scry, create exactly one resource, retrieve/verify evidence, and finalize",
        mcp: {
          protocolVersion: snapshot?.protocolVersion,
          serverInfo: snapshot?.serverInfo,
          toolMetadataDigest,
          calls: toolCalls,
        },
        result: {
          status: q5.agent.result.status,
          turns: q5.agent.result.turns,
          toolCalls: q5.agent.result.tool_calls,
          invalidCalls: q5.agent.result.invalid_calls,
          terminalOutcome: q5.agent.result.terminal_outcome,
          terminationCategory: q5.agent.result.termination_category,
        },
      },
      campaign: q5.campaign,
      oracle: {
        mutationRequests: q5.oracle.mutationRequests.length,
        resources: q5.oracle.resources.length,
        retrievalCount: q5.oracle.retrievalCount,
      },
      representativeCampaigns: {
        "Q5-01": "repository-blind actual MCP normal success",
        "Q5-02": "Q3 stale-authority product path plus campaign quota fence",
        "Q5-03": "Q3 required-evidence failure plus terminal campaign refusal",
        "Q5-04": "Q3 lost-ACK commit/UNKNOWN plus no second mutation/Run",
        "Q5-05": "Q3 no-commit reconciliation plus no automatic allowance restoration",
        "Q5-06": "actual MCP deliberate second-Run client",
        "Q5-07": "actual MCP deliberate second-mutation client",
      },
      agentCompetence: q5Pass ? "PASS" : "BLOCKED",
      agentQualityFinding: q5Pass
        ? null
        : "The authoritative campaign exposed an agent-facing dispatch_run_operation contract defect: activate/press allowed semanticEffect omission without locally explaining that only proven read_context_transition plus live_read preserves campaign mutation capability. The contract is corrected, but repository-blind agent competence remains unproven until one new authoritative Q5 campaign succeeds.",
      productSafety: q5ProductSafetyPass ? "PASS" : "BLOCKED",
      productSafetyFinding: q5ProductSafetyPass
        ? "The later protected authentication attempt was refused before dispatch because the campaign mutation capability was already consumed."
        : "Mechanical refusal was not completely attested.",
      parentSemanticCoaching: false,
    },
    mutationAccounting: {
      q5Campaigns: 1,
      authorizedMutations: q5.campaign.mutationsConsumed,
      externalRequests: q5.oracle.mutationRequests.length,
      externalEffects: q5.oracle.resources.length,
      duplicates: Math.max(0, q5.oracle.resources.length - 1),
      redispatches: 0,
      q4PerCampaign: processEvidence.processes
        .filter(({ oracle }) => oracle)
        .map(({ phase, oracle, scry }) => ({ phase, oracle, scry })),
    },
    privacyAndCredentials: {
      protectedLeakCount: q5.protectedLeakCount,
      persistentMcpTokenChanged: false,
      qualificationCredential: "ephemeral random loopback service token",
      transcriptCommitted: false,
    },
    residue: {
      successfulQ5Scope: "terminal campaign/Run/Praxis/agent required; zero unexplained owner",
      q4: "no observing reconciliation or live stale lease; expected recovery_required protected/UNKNOWN rows remain fenced",
      globalHistoricalRowsRequiredZero: false,
    },
    futureGates: {
      Q01: "Milestone 7 dashboard projection",
      Q6: "Milestone 7 public read-only qualification",
      Q7: "REAL Stage 6 Test Mode qualification only after Milestone 7 guarded re-entry",
    },
    productFindings: [],
  };
  const digest = createHash("sha256").update(stableJson(report)).digest("hex");
  return { report, digest };
}

export function renderM6Markdown(report: any, digest: string) {
  return `# Scry system correctness Q4 + Q5 / Milestone 6\n\n- MILESTONE_6_IMPLEMENTATION: **${report.verdicts.milestone6Implementation}**\n- M6_CLOSURE_REVIEW: **${report.verdicts.m6ClosureReview}**\n- Q04_MECHANICAL_CAMPAIGN_SAFETY: **${report.verdicts.q04MechanicalCampaignSafety}**\n- Q4_PROCESS_LOSS: **${report.verdicts.q4ProcessLoss}**\n- Q5_REPOSITORY_BLIND_AGENT: **${report.verdicts.q5RepositoryBlindAgent}**\n- M6_PRODUCT_GATE: **${report.verdicts.m6ProductGate}**\n- PROGRESSION: **${report.verdicts.progression}**\n- report digest: \`${digest}\`\n\n## Campaign authorization\n\n${report.campaignAuthorization.model}. Run consumption is ${report.campaignAuthorization.runConsumption}. Mutation consumption is ${report.campaignAuthorization.mutationConsumption}.\n\n## Process loss\n\n${report.q4.processCount} distinct SIGKILL-owned processes exercised P1-P8 and representative browser/runtime/agent/Attempt/reconciliation/protected owners. P9 has no separate process boundary and is not claimed as a process kill. Independent fixture facts are embedded per mutation-capable case.\n\n## Repository-blind agent\n\n${report.q5.agent.provider}/${report.q5.agent.model} negotiated MCP ${report.q5.agent.mcp.protocolVersion} with metadata digest \`${report.q5.agent.mcp.toolMetadataDigest}\`. It had Scry MCP only: no repository, shell, database, fixture HTTP, or oracle capability.\n\n## Scope\n\nThis report does not prove dashboard projection, public-site behavior, or real external Test Mode mutation. Q7 still means the real Stage 6 Test Mode qualification after Milestone 7 guarded re-entry.\n`;
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
