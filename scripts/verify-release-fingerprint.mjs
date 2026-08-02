import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const migrations = new URL("../apps/api/migrations/", import.meta.url);
const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
const calibration = await readFile(new URL("calibration-foundation.sql", migrations), "utf8");
const capsule = await readFile(new URL("protected-capsule.sql", migrations), "utf8");
const authoring = await readFile(new URL("authoring-execution-cutover.sql", migrations), "utf8");
const reporting = await readFile(new URL("praxis-reporting.sql", migrations), "utf8");
const cutoff = await readFile(new URL("praxis-cutoff.sql", migrations), "utf8");
const baseline = (await readFile(new URL("baseline.sql", migrations), "utf8"))
  .replace("\\ir calibration-foundation.sql", () => calibration)
  .replace("\\ir protected-capsule.sql", () => capsule)
  .replace("\\ir authoring-execution-cutover.sql", () => authoring)
  .replace("\\ir praxis-reporting.sql", () => reporting)
  .replace("\\ir praxis-cutoff.sql", () => cutoff);
const required = createHash("sha256").update(baseline).digest("hex");
const configured = compose.match(/SCRY_SCHEMA_FINGERPRINT:\s*"\$\{SCRY_SCHEMA_FINGERPRINT:-([a-f0-9]{64})\}"/)?.[1];

if (configured !== required) {
  throw new Error(`Docker Compose schema fingerprint is stale: configured=${configured ?? "missing"} required=${required}`);
}
process.stdout.write(`Docker Compose release fingerprint verified: ${required}\n`);
