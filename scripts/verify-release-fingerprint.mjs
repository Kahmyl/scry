import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fingerprintScript = fileURLToPath(new URL("schema-fingerprint.mjs", import.meta.url));
const required = execFileSync(process.execPath, [fingerprintScript], {
  encoding: "utf8",
}).trim();

if (!/^[a-f0-9]{64}$/u.test(required)) {
  throw new Error(`Schema fingerprint command returned an invalid digest: ${required}`);
}

const [developmentCompose, deploymentCompose] = await Promise.all([
  readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
  readFile(new URL("../compose.deploy.yml", import.meta.url), "utf8"),
]);

const configured = developmentCompose.match(
  /SCRY_SCHEMA_FINGERPRINT:\s*"\$\{SCRY_SCHEMA_FINGERPRINT:-([a-f0-9]{64})\}"/u,
)?.[1];

if (configured !== required) {
  throw new Error(
    `Docker Compose schema fingerprint is stale: configured=${configured ?? "missing"} required=${required}`,
  );
}

const explicitDeploymentBindings = deploymentCompose.match(
  /SCRY_SCHEMA_FINGERPRINT:\s*\$\{SCRY_SCHEMA_FINGERPRINT:\?Set SCRY_SCHEMA_FINGERPRINT\}/gu,
);
if ((explicitDeploymentBindings?.length ?? 0) !== 4) {
  throw new Error(
    "Deployment Compose must bind the explicit schema fingerprint into migration, API, worker, and MCP services",
  );
}

process.stdout.write(`Browser v2 release fingerprint verified: ${required}\n`);
