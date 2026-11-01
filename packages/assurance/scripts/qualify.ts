import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checksForProfile, profiles } from "../src/catalog.js";
import { runQualification } from "../src/qualification.js";
import { createProcessExecutor } from "../src/process-executor.js";
import { retainQualificationReport } from "../src/report-storage.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const [profile, ...extra] = process.argv.slice(2).filter((argument) => argument !== "--");
if (profile === "list" && !extra.length) {
  for (const [name, ids] of Object.entries(profiles))
    process.stdout.write(`${name}: ${ids.join(", ")}\n`);
} else if (!profile || extra.length || !Object.hasOwn(profiles, profile)) {
  process.stderr.write("Usage: pnpm qualify <profile> | pnpm qualify list\n");
  process.exitCode = 2;
} else {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    process.stdout.write(`Assurance profile: ${profile} (selected checks only)\n`);
    const report = await runQualification({
      runId: randomUUID(),
      profile,
      checks: checksForProfile(profile),
      environment: process.env,
      execute: createProcessExecutor(root, process.env),
      signal: cancellation.signal,
      progress: (check) =>
        process.stdout.write(
          `${check.id}: ${check.status} (${check.reason})${check.counts ? `; passed=${check.counts.passed}, skipped=${check.counts.skipped}` : ""}\n`,
        ),
    });
    const target = await retainQualificationReport(path.join(root, "artifacts/assurance"), report);
    process.stdout.write(`Assurance: ${report.verdict}; report: ${target}\n`);
    process.exitCode =
      report.verdict === "passed"
        ? 0
        : report.verdict === "blocked"
          ? 2
          : report.verdict === "cancelled"
            ? 130
            : 1;
  } catch {
    process.stderr.write("SCRY_ASSURANCE_REPORT_UNAVAILABLE\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
