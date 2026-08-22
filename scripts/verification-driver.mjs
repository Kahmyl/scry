import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

import { discoverWorkspaces } from "./verification-affected-lib.mjs";

import {
  failedWorkspaceNames,
  focusedWorkspaceNames,
  mergeFailureState,
  normalizeDriverArguments,
  workspaceWasFullyHealthy,
} from "./verification-driver-lib.mjs";

const root = process.cwd();

const artifactsDirectory = path.join(root, "artifacts");

const planPath = path.join(artifactsDirectory, "verification-affected-plan.json");

const resultsPath = path.join(artifactsDirectory, "verification-affected-results.json");

const failureStatePath = path.join(artifactsDirectory, "verification-prior-failures.json");

const auditReportPath = path.join(artifactsDirectory, "verification-audit.json");

const { audit, affectedArguments } = normalizeDriverArguments(process.argv.slice(2));

const planOnly = affectedArguments.includes("--plan");

const priorWorkspaces = readPriorFailures();

if (!planOnly) {
  fs.rmSync(resultsPath, {
    force: true,
  });
}

const affected = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "verification-affected.mjs"), ...affectedArguments],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  },
);

if (affected.error) {
  throw affected.error;
}

if (planOnly) {
  process.exitCode = affected.status ?? 1;
} else {
  const plan = readJson(planPath);

  const affectedResults = fs.existsSync(resultsPath) ? readJson(resultsPath) : null;

  if (!affectedResults) {
    console.error();
    console.error("Affected verification did not produce a results artifact.");

    process.exitCode = affected.status ?? 1;
  } else {
    const workspaces = discoverWorkspaces(root);

    const knownWorkspaceNames = workspaces.map((workspace) => workspace.name);

    const currentFailedWorkspaces = failedWorkspaceNames(affectedResults.results);

    const fullyHealthyWorkspaces = plan.selected
      .filter((workspace) => workspaceWasFullyHealthy(workspace, affectedResults.results))
      .map((workspace) => workspace.name);

    const recheckReasons = new Map();

    if (affected.status === 0 && audit) {
      for (const workspace of focusedWorkspaceNames(plan)) {
        addRecheckReason(recheckReasons, workspace, "audit-focused-vs-full");
      }
    }

    if (affected.status === 0) {
      for (const workspace of priorWorkspaces) {
        if (fullyHealthyWorkspaces.includes(workspace)) {
          continue;
        }

        if (!knownWorkspaceNames.includes(workspace)) {
          continue;
        }

        addRecheckReason(recheckReasons, workspace, "prior-failure");
      }
    }

    const fullChecks = [];

    if (affected.status === 0) {
      for (const [workspaceName, reasons] of recheckReasons) {
        const workspace = workspaces.find((candidate) => candidate.name === workspaceName);

        if (!workspace) {
          continue;
        }

        const includeTypecheck = reasons.includes("prior-failure");

        fullChecks.push(
          runFullWorkspaceCheck(workspace, {
            includeTypecheck,
            reasons,
          }),
        );
      }
    }

    const nextFailureState =
      affected.status === 0
        ? mergeFailureState({
            priorWorkspaces,
            currentFailedWorkspaces,
            fullChecks,
            fullyHealthyWorkspaces,
            knownWorkspaces: knownWorkspaceNames,
          })
        : [...new Set([...priorWorkspaces, ...currentFailedWorkspaces])].sort();

    writePriorFailures(nextFailureState);

    const selectorMisses = fullChecks.filter(
      (check) => check.reasons.includes("audit-focused-vs-full") && !check.passed,
    );

    if (audit) {
      const auditReport = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        affectedPassed: affected.status === 0,
        focusedWorkspaces: focusedWorkspaceNames(plan),
        fullChecks,
        selectorMisses: selectorMisses.map((check) => check.workspace),
        passed:
          affected.status === 0 &&
          selectorMisses.length === 0 &&
          fullChecks.every((check) => check.passed),
      };

      fs.writeFileSync(auditReportPath, `${JSON.stringify(auditReport, null, 2)}\n`);

      console.log();
      console.log("== Selector audit summary ==");

      console.log(`Focused workspaces: ${auditReport.focusedWorkspaces.length}`);

      console.log(`Full comparison checks: ${auditReport.fullChecks.length}`);

      console.log(`Selector misses: ${auditReport.selectorMisses.length}`);

      for (const check of auditReport.fullChecks) {
        console.log(
          `  ${check.workspace}: ${(check.durationMs / 1000).toFixed(2)}s ${check.passed ? "PASS" : "FAIL"}`,
        );
      }
    }

    if (nextFailureState.length > 0) {
      console.log();
      console.log("Prior-failure state retained for:");

      for (const workspace of nextFailureState) {
        console.log(`  - ${workspace}`);
      }
    } else {
      console.log();
      console.log("Prior-failure state: clear");
    }

    const failed = affected.status !== 0 || fullChecks.some((check) => !check.passed);

    process.exitCode = failed ? 1 : 0;
  }
}

function addRecheckReason(map, workspace, reason) {
  const reasons = map.get(workspace) ?? [];

  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }

  map.set(workspace, reasons);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readPriorFailures() {
  if (!fs.existsSync(failureStatePath)) {
    return [];
  }

  try {
    const state = readJson(failureStatePath);

    if (!Array.isArray(state.workspaces)) {
      return [];
    }

    return state.workspaces.filter((workspace) => typeof workspace === "string");
  } catch {
    console.warn("Prior-failure state was unreadable; keeping normal conservative selection.");

    return [];
  }
}

function writePriorFailures(workspaces) {
  fs.mkdirSync(artifactsDirectory, {
    recursive: true,
  });

  fs.writeFileSync(
    failureStatePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        workspaces,
      },
      null,
      2,
    )}\n`,
  );
}

function runFullWorkspaceCheck(workspace, { includeTypecheck, reasons }) {
  console.log();
  console.log(`== Full comparison: ${workspace.name} ==`);

  console.log(`Reasons: ${reasons.join(", ")}`);

  const commands = [];

  if (includeTypecheck && workspace.scripts.typecheck) {
    commands.push({
      id: `${workspace.name}:typecheck`,
      command: "pnpm",
      args: ["--filter", workspace.name, "run", "typecheck"],
    });
  }

  if (workspace.scripts.test) {
    commands.push(fullTestCommand(workspace.name));
  }

  const startedAt = performance.now();

  const results = [];

  for (const command of commands) {
    console.log();
    console.log(`-- ${command.id}`);

    const result = spawnSync(command.command, command.args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });

    if (result.error) {
      throw result.error;
    }

    results.push({
      id: command.id,
      status: result.status,
      passed: result.status === 0,
    });
  }

  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;

  const passed = results.length > 0 && results.every((result) => result.passed);

  console.log();
  console.log(
    `${passed ? "PASS" : "FAIL"} full comparison ${workspace.name} (${(durationMs / 1000).toFixed(2)}s)`,
  );

  return {
    workspace: workspace.name,
    reasons,
    includeTypecheck,
    durationMs,
    passed,
    results,
  };
}

function fullTestCommand(workspaceName) {
  const historicalSnapshot = "/private/tmp/scry-m1-cutover-2b9e22e42cf3/development-db.dump";

  if (workspaceName === "@scry/api" && !fs.existsSync(historicalSnapshot)) {
    return {
      id: "@scry/api:test",
      command: "pnpm",
      args: [
        "--filter",
        "@scry/api",
        "exec",
        "vitest",
        "run",
        "--exclude",
        "test/m1-snapshot-migration.qualification.test.ts",
      ],
    };
  }

  return {
    id: `${workspaceName}:test`,
    command: "pnpm",
    args: ["--filter", workspaceName, "run", "test"],
  };
}
