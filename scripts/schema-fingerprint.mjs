import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../apps/api/migrations/", import.meta.url);

const calibration = await readFile(new URL("calibration-foundation.sql", root), "utf8");

const capsule = await readFile(new URL("protected-capsule.sql", root), "utf8");

const authoring = await readFile(new URL("authoring-execution-cutover.sql", root), "utf8");

const reporting = await readFile(new URL("praxis-reporting.sql", root), "utf8");

const cutoff = await readFile(new URL("praxis-cutoff.sql", root), "utf8");

const preferences = await readFile(
  new URL("veil-observation-preferences.sql", root),
  "utf8",
);

const retention = await readFile(
  new URL("veil-artifact-retention.sql", root),
  "utf8",
);

const compiledPlan = await readFile(
  new URL("compiled-plan-cutover.sql", root),
  "utf8",
);

const statefulProbeAuthoring = await readFile(
  new URL("stateful-probe-authoring.sql", root),
  "utf8",
);

const interactiveRuntimeCommands = await readFile(
  new URL("interactive-runtime-commands.sql", root),
  "utf8",
);

const baseline = (await readFile(new URL("baseline.sql", root), "utf8"))
  .replace("\\ir calibration-foundation.sql", () => calibration)
  .replace("\\ir protected-capsule.sql", () => capsule)
  .replace("\\ir authoring-execution-cutover.sql", () => authoring)
  .replace("\\ir praxis-reporting.sql", () => reporting)
  .replace("\\ir praxis-cutoff.sql", () => cutoff)
  .replace("\\ir veil-observation-preferences.sql", () => preferences)
  .replace("\\ir veil-artifact-retention.sql", () => retention)
  .replace("\\ir compiled-plan-cutover.sql", () => compiledPlan)
  .replace("\\ir stateful-probe-authoring.sql", () => statefulProbeAuthoring)
  .replace(
    "\\ir interactive-runtime-commands.sql",
    () => interactiveRuntimeCommands,
  );

process.stdout.write(`${createHash("sha256").update(baseline).digest("hex")}\n`);
