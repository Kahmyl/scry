import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../apps/api/migrations/", import.meta.url);
const calibration = await readFile(new URL("calibration-foundation.sql", root), "utf8");
const capsule = await readFile(new URL("protected-capsule.sql", root), "utf8");
const authoring = await readFile(new URL("authoring-execution-cutover.sql", root), "utf8");
const reporting = await readFile(new URL("praxis-reporting.sql", root), "utf8");
const cutoff = await readFile(new URL("praxis-cutoff.sql", root), "utf8");
const baseline = (await readFile(new URL("baseline.sql", root), "utf8"))
  .replace("\\ir calibration-foundation.sql", () => calibration)
  .replace("\\ir protected-capsule.sql", () => capsule)
  .replace("\\ir authoring-execution-cutover.sql", () => authoring)
  .replace("\\ir praxis-reporting.sql", () => reporting)
  .replace("\\ir praxis-cutoff.sql", () => cutoff);

process.stdout.write(`${createHash("sha256").update(baseline).digest("hex")}\n`);
