import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../apps/api/migrations/", import.meta.url);

const calibration = await readFile(new URL("calibration-foundation.sql", root), "utf8");

const capsule = await readFile(new URL("protected-capsule.sql", root), "utf8");

const authoring = await readFile(new URL("authoring-execution-cutover.sql", root), "utf8");

const reporting = await readFile(new URL("praxis-reporting.sql", root), "utf8");

const cutoff = await readFile(new URL("praxis-cutoff.sql", root), "utf8");

const praxisCandidateInspection = await readFile(
  new URL("praxis-candidate-inspection.sql", root),
  "utf8",
);

const preferences = await readFile(new URL("veil-observation-preferences.sql", root), "utf8");

const retention = await readFile(new URL("veil-artifact-retention.sql", root), "utf8");

const compiledPlan = await readFile(new URL("compiled-plan-cutover.sql", root), "utf8");

const statefulProbeAuthoring = await readFile(
  new URL("stateful-probe-authoring.sql", root),
  "utf8",
);

const interactiveRuntimeCommands = await readFile(
  new URL("interactive-runtime-commands.sql", root),
  "utf8",
);

const interactiveRuntimeLifecycle = await readFile(
  new URL("interactive-runtime-lifecycle.sql", root),
  "utf8",
);

const authenticationAuthoring = await readFile(
  new URL("authentication-authoring.sql", root),
  "utf8",
);

const adaptiveAuthoring = await readFile(new URL("adaptive-authoring-pr9-pr12.sql", root), "utf8");

const adaptiveExecutionFoundation = await readFile(
  new URL("adaptive-execution-foundation-m0-m1.sql", root),
  "utf8",
);
const adaptiveSessions = await readFile(new URL("adaptive-sessions-m3.sql", root), "utf8");
const missionFirstM1 = await readFile(
  new URL("mission-first-live-convergence-m1.sql", root),
  "utf8",
);
const missionAuthoringGroupedTurnsM2 = await readFile(
  new URL("mission-authoring-grouped-turns-m2.sql", root),
  "utf8",
);

const baseline = expandIncludes(await readFile(new URL("baseline.sql", root), "utf8"), [
  ["authoring-execution-cutover.sql", authoring],
  ["praxis-reporting.sql", reporting],
  ["praxis-cutoff.sql", cutoff],
  ["praxis-candidate-inspection.sql", praxisCandidateInspection],
  ["veil-observation-preferences.sql", preferences],
  ["veil-artifact-retention.sql", retention],
  ["compiled-plan-cutover.sql", compiledPlan],
  ["stateful-probe-authoring.sql", statefulProbeAuthoring],
  ["interactive-runtime-commands.sql", interactiveRuntimeCommands],
  ["interactive-runtime-lifecycle.sql", interactiveRuntimeLifecycle],
  ["authentication-authoring.sql", authenticationAuthoring],
  ["adaptive-authoring-pr9-pr12.sql", adaptiveAuthoring],
  ["adaptive-execution-foundation-m0-m1.sql", adaptiveExecutionFoundation],
  ["adaptive-sessions-m3.sql", adaptiveSessions],
  ["mission-first-live-convergence-m1.sql", missionFirstM1],
  ["mission-authoring-grouped-turns-m2.sql", missionAuthoringGroupedTurnsM2],
])
  .replace("\\ir calibration-foundation.sql", () => calibration)
  .replace("\\ir protected-capsule.sql", () => capsule);

process.stdout.write(`${createHash("sha256").update(baseline).digest("hex")}\n`);

function expandIncludes(source, migrations) {
  return migrations.reduce(
    (current, [name, contents]) =>
      current.replace(
        new RegExp(`\\\\ir\\s+${name.replaceAll(".", "\\.")}(?:\\r?\\n|$)`, "g"),
        () => contents,
      ),
    source,
  );
}
