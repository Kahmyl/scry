import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/veil-verification.yml"), "utf8");
const publish = readFileSync(resolve(root, ".github/workflows/docker-publish.yml"), "utf8");
const triggers = [
  "packages/contracts/**",
  "packages/executor/**",
  "packages/policy/**",
  "scripts/verify-veil-*.mjs",
  "docs/architecture/veil-*.json",
  "compose.deploy.yml",
  "docker/Dockerfile.backup",
  "scripts/operations/**",
  "scripts/qualify-production-recovery.sh",
  "scripts/verify-deployment-*.mjs",
  "ops/observability/**",
];
const commands = [
  "pnpm verify:veil-performance",
  "pnpm verify:production-operations",
  "pnpm verify:production-recovery",
  "pnpm verify:deployment-tiers",
  "pnpm verify:veil-release-evidence",
  "pnpm campaign:veil:certification",
  "pnpm campaign:veil:adversarial",
  "pnpm campaign:veil:production-e2e",
  "pnpm campaign:veil:worker-crash",
  "pnpm campaign:veil:public-apps",
  "pnpm campaign:praxis",
  "pnpm campaign:praxis:100",
  "pnpm campaign:praxis:resilience",
  "pnpm campaign:praxis:certification",
  "pnpm campaign:praxis:public-apps",
];
const failures = [];
for (const item of triggers)
  if (!workflow.includes(item)) failures.push(`missing Veil change trigger ${item}`);
for (const command of commands)
  if (!workflow.includes(command)) failures.push(`Veil workflow does not run ${command}`);
for (const command of commands)
  if (!publish.includes(command)) failures.push(`release workflow does not run ${command}`);
if (!workflow.includes("if: always()") || !workflow.includes("actions/upload-artifact@v4"))
  failures.push("Veil campaign evidence is not retained on failure");
const productionRoots = [
  resolve(root, "packages/executor/src"),
  resolve(root, "packages/artifact/src"),
  resolve(root, "apps"),
];
const sources = productionRoots
  .flatMap(walk)
  .filter(
    (path) =>
      [".ts", ".tsx", ".js", ".mjs"].includes(extname(path)) &&
      !path.includes("/test/") &&
      !path.includes("/__test__/") &&
      !/\.test\.[^.]+$/.test(path),
  );
for (const path of sources) {
  const name = relative(root, path);
  const source = readFileSync(path, "utf8");
  if (name === "packages/executor/src/privacy-gate.ts")
    failures.push("legacy PrivacyGate implementation still exists in production sources");
  else if (/\bPrivacyGate\b|privacy-gate\.js/.test(source))
    failures.push(`legacy PrivacyGate reference remains in ${name}`);
  if (
    name !== "packages/executor/src/artifacts.ts" &&
    name !== "packages/artifact/src/index.ts" &&
    /availability\s*:\s*["']available["']/.test(source)
  )
    failures.push(`direct available-artifact construction bypass in ${name}`);
  if (
    /\.put\s*\([^)]*readFile/.test(source) &&
    !/veilEvidenceManifestSchema|requireAdmission/.test(source)
  )
    failures.push(`artifact-store byte admission lacks Veil proof validation in ${name}`);
}
if (failures.length) {
  console.error(`Veil change gate failed:\n${failures.map((x) => `- ${x}`).join("\n")}`);
  process.exit(1);
}
console.log(
  "Veil change gate verified: production sources contain no legacy PrivacyGate or direct artifact-construction bypass, and both campaign families are mandatory.",
);
function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
