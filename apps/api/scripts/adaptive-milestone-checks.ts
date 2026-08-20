import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  AdaptiveMilestone,
  CampaignCheck,
  CampaignMetricsCollector,
} from "@scry/assurance/legacy";

export type MilestoneCommand = {
  id: string;
  description: string;
  phase: string;
  command: string;
  args: string[];
  requiredEnvironment?: string[];
  environment?: Record<string, string>;
};

const vitest = (
  workspace: string,
  files: string[],
): Pick<MilestoneCommand, "command" | "args"> => ({
  command: "pnpm",
  args: ["--filter", workspace, "exec", "vitest", "run", ...files, "--maxWorkers=1"],
});

export function milestoneCommands(milestone: AdaptiveMilestone): MilestoneCommand[] {
  switch (milestone) {
    case "M2":
      return [
        {
          id: "m2-api-evidence",
          description:
            "Canonical evidence outcomes, attempt isolation, and artifact compensation pass",
          phase: "evidence_finalization",
          ...vitest("@scry/api", [
            "test/run-observation.service.test.ts",
            "test/run-processor-artifact-commit.test.ts",
          ]),
        },
        {
          id: "m2-executor-evidence",
          description: "Recording ownership and trace admission failure paths pass",
          phase: "artifact_retrieval",
          ...vitest("@scry/executor", [
            "test/recording-coordinator.test.ts",
            "test/trace-coordinator-admission.test.ts",
          ]),
        },
        {
          id: "m2-run-detail",
          description: "Run detail ordering, Advanced disclosure, and recording states pass",
          phase: "document_observation",
          ...vitest("@scry/web", [
            "src/features/runs/run-report-view.test.tsx",
            "src/features/runs/recording-timeline.test.tsx",
          ]),
        },
      ];
    case "M3":
      return [
        {
          id: "m3-contract",
          description: "Adaptive Session contracts reject invalid state and operation inputs",
          phase: "document_observation",
          ...vitest("@scry/contracts", ["test/adaptive-session.test.ts"]),
        },
        {
          id: "m3-service",
          description: "Adaptive Session service enforces idempotency, fencing, and bounded turns",
          phase: "interaction_execution",
          ...vitest("@scry/api", ["test/adaptive-session.service.test.ts"]),
        },
        {
          id: "m3-restart-resume",
          description: "A real browser session restarts and resumes from a durable safe boundary",
          phase: "browser_startup",
          ...vitest("@scry/api", ["test/adaptive-session-runtime.restart.test.ts"]),
        },
        {
          id: "m3-durable-repository",
          description:
            "Missionless session persistence and concurrent journal ordering pass on Postgres",
          phase: "queue_wait",
          requiredEnvironment: ["SCRY_AUTHORING_TEST_DATABASE_URL"],
          ...vitest("@scry/api", ["test/adaptive-session.repository.integration.test.ts"]),
        },
        {
          id: "m3-mcp-surface",
          description:
            "Adaptive Session MCP tools expose typed lifecycle and grouped-turn operations",
          phase: "expected_effect_verification",
          ...vitest("@scry/mcp", ["test/server.test.ts"]),
        },
      ];
    case "M4":
      return [
        {
          id: "m4-learned-compilation",
          description: "Learned records are sanitized and compiler blockers remain typed",
          phase: "compilation",
          ...vitest("@scry/api", [
            "test/learned-interaction-emission.test.ts",
            "test/transcript-compiler.test.ts",
          ]),
        },
        {
          id: "m4-protected-acquisition",
          description:
            "Protected acquisition adapters return semantic proof without protected bytes",
          phase: "interaction_execution",
          ...vitest("@scry/executor", ["test/protected-acquisition-adapters.test.ts"]),
        },
        {
          id: "m4-certification-publication",
          description: "Fresh certification and privacy closure gate exact-contract publication",
          phase: "certification",
          requiredEnvironment: ["SCRY_AUTHORING_TEST_DATABASE_URL"],
          ...vitest("@scry/api", ["test/authoring.integration.test.ts"]),
        },
        {
          id: "m4-mcp-compatibility",
          description: "Compile, certify, and publish MCP responses preserve typed safe failures",
          phase: "expected_effect_verification",
          ...vitest("@scry/mcp", ["test/api-client.test.ts", "test/server.test.ts"]),
        },
      ];
    case "M5":
      return [
        releaseCommand("m5-typecheck", "The complete workspace typechecks", "compilation", [
          "typecheck",
        ]),
        releaseCommand(
          "m5-authoring-release",
          "The strict adaptive authoring release corpus passes",
          "certification",
          ["verify:adaptive-authoring-release"],
          ["SCRY_AUTHORING_TEST_DATABASE_URL", "SCRY_VITRACT_PREVIEW_E2E"],
        ),
        releaseCommand(
          "m5-praxis-release",
          "Praxis release workflow and production campaign wiring pass",
          "praxis_grounding",
          ["verify:praxis-change-gate"],
        ),
        releaseCommand(
          "m5-veil-release",
          "Veil release workflow and artifact admission wiring pass",
          "evidence_finalization",
          ["verify:veil-change-gate"],
        ),
        releaseCommand(
          "m5-dashboard-release",
          "The production dashboard build and read-only boundary pass",
          "artifact_retrieval",
          ["verify:dashboard-read-only"],
        ),
        releaseCommand(
          "m5-fingerprint",
          "Release, schema, runtime, and migration fingerprints agree",
          "queue_wait",
          ["verify:release-fingerprint"],
        ),
      ];
    default:
      throw new Error(`${milestone}_CORE_CAMPAIGN_NOT_SUPPORTED`);
  }
}

export async function runMilestoneCommands(input: {
  milestone: AdaptiveMilestone;
  correlationId: string;
  metrics: CampaignMetricsCollector;
}): Promise<{ checks: CampaignCheck[]; artifactRefs: string[] }> {
  const checks: CampaignCheck[] = [];
  const artifactRefs: string[] = [];
  for (const candidate of milestoneCommands(input.milestone)) {
    const missing = (candidate.requiredEnvironment ?? []).filter((name) => !process.env[name]);
    if (missing.length) {
      checks.push({
        id: candidate.id,
        description: candidate.description,
        status: "failed",
        reasonCode: "CAMPAIGN_ENVIRONMENT_REQUIRED",
        safeDetail: { missing },
      });
      continue;
    }
    const eventId = `${input.correlationId}-${candidate.id}`;
    const exitCode = await input.metrics.phase(
      candidate.id,
      candidate.phase,
      { source: "campaign_client", eventId },
      () => runCommand(candidate),
    );
    checks.push({
      id: candidate.id,
      description: candidate.description,
      status: exitCode === 0 ? "passed" : "failed",
      ...(exitCode === 0
        ? {}
        : { reasonCode: "CAMPAIGN_COMMAND_FAILED", safeDetail: { exitCode } }),
    });
    artifactRefs.push(`command:${candidate.id}`);
  }
  return { checks, artifactRefs };
}

function releaseCommand(
  id: string,
  description: string,
  phase: string,
  args: string[],
  requiredEnvironment?: string[],
  environment?: Record<string, string>,
): MilestoneCommand {
  return {
    id,
    description,
    phase,
    command: "pnpm",
    args,
    ...(requiredEnvironment ? { requiredEnvironment } : {}),
    ...(environment ? { environment } : {}),
  };
}

function runCommand(candidate: MilestoneCommand): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, candidate.args, {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { ...process.env, ...candidate.environment },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}
