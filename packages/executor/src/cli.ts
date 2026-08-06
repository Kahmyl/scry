#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { executionPolicySchema, currentPlanSchema, type ExecutionPolicy } from "@scry/contracts";

import { executePlan } from "./executor.js";

async function main() {
  const [command, planArgument, ...flags] = process.argv.slice(2);
  if (command !== "run" || !planArgument) {
    usage();
    process.exitCode = 2;
    return;
  }

  const planPath = path.resolve(planArgument);
  const outputDirectory = path.resolve(readFlag(flags, "--output") ?? `artifacts/${Date.now()}`);
  const browserChannel = readFlag(flags, "--channel");
  const headed = flags.includes("--headed");
  const veilAdmissionKey = process.env.VEIL_ADMISSION_KEY;
  const plan = currentPlanSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
  const policyPath = readFlag(flags, "--policy");
  const policy = policyPath
    ? executionPolicySchema.parse(JSON.parse(await readFile(path.resolve(policyPath), "utf8")))
    : defaultPolicy(plan.allowedOrigins, plan.budgets);

  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Interrupted by user"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      ...(browserChannel ? { browserChannel } : {}),
      ...(veilAdmissionKey ? { veilAdmissionKey } : {}),
      headless: !headed,
      signal: controller.signal,
      secretResolver: resolveEnvironmentSecret,
      onEvent: (event) => {
        process.stdout.write(
          `${event.sequence.toString().padStart(3, "0")} ${event.type} ${JSON.stringify(event.payload)}\n`,
        );
      },
    });
    process.stdout.write(`\n${report.state.toUpperCase()} — ${outputDirectory}/attempt.json\n`);
    process.exitCode = report.state === "passed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

function readFlag(flags: string[], name: string) {
  const index = flags.indexOf(name);
  return index >= 0 ? flags[index + 1] : undefined;
}

function defaultPolicy(
  allowedOrigins: string[],
  budgets: { maxActions: number; maxDurationMs: number; maxNavigations: number },
): ExecutionPolicy {
  return executionPolicySchema.parse({
    allowedOrigins,
    ...budgets,
  });
}

async function resolveEnvironmentSecret(reference: string) {
  const key = `SCRY_SECRET_${reference.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
  const value = process.env[key];
  if (value === undefined) throw new Error(`Missing environment secret: ${key}`);
  return value;
}

function usage() {
  process.stderr.write(
    "Usage: scry run <plan.json> [--output <directory>] [--policy <policy.json>] [--channel chrome] [--headed]\n",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
