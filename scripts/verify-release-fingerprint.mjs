import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const migrations = new URL("../apps/api/migrations/", import.meta.url);

const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");

const calibration = await readFile(new URL("calibration-foundation.sql", migrations), "utf8");

const capsule = await readFile(new URL("protected-capsule.sql", migrations), "utf8");

const authoring = await readFile(new URL("authoring-execution-cutover.sql", migrations), "utf8");

const reporting = await readFile(new URL("praxis-reporting.sql", migrations), "utf8");

const cutoff = await readFile(new URL("praxis-cutoff.sql", migrations), "utf8");

const praxisCandidateInspection = await readFile(
  new URL("praxis-candidate-inspection.sql", migrations),
  "utf8",
);

const preferences = await readFile(new URL("veil-observation-preferences.sql", migrations), "utf8");

const retention = await readFile(new URL("veil-artifact-retention.sql", migrations), "utf8");

const compiledPlan = await readFile(new URL("compiled-plan-cutover.sql", migrations), "utf8");

const statefulProbeAuthoring = await readFile(
  new URL("stateful-probe-authoring.sql", migrations),
  "utf8",
);

const interactiveRuntimeCommands = await readFile(
  new URL("interactive-runtime-commands.sql", migrations),
  "utf8",
);

const interactiveRuntimeLifecycle = await readFile(
  new URL("interactive-runtime-lifecycle.sql", migrations),
  "utf8",
);

const authenticationAuthoring = await readFile(
  new URL("authentication-authoring.sql", migrations),
  "utf8",
);

const adaptiveAuthoring = await readFile(
  new URL("adaptive-authoring-pr9-pr12.sql", migrations),
  "utf8",
);

const adaptiveExecutionFoundation = await readFile(
  new URL("adaptive-execution-foundation-m0-m1.sql", migrations),
  "utf8",
);
const adaptiveSessions = await readFile(new URL("adaptive-sessions-m3.sql", migrations), "utf8");

const baseline = expandIncludes(await readFile(new URL("baseline.sql", migrations), "utf8"), [
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
])
  .replace("\\ir calibration-foundation.sql", () => calibration)
  .replace("\\ir protected-capsule.sql", () => capsule);

const required = createHash("sha256").update(baseline).digest("hex");

const configured = compose.match(
  /SCRY_SCHEMA_FINGERPRINT:\s*"\$\{SCRY_SCHEMA_FINGERPRINT:-([a-f0-9]{64})\}"/,
)?.[1];

if (configured !== required) {
  throw new Error(
    `Docker Compose schema fingerprint is stale: configured=${configured ?? "missing"} required=${required}`,
  );
}

process.stdout.write(`Docker Compose release fingerprint verified: ${required}\n`);

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
