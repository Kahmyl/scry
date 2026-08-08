import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const apiRoot = path.join(root, "apps/api/src");
const allowedDirectExecution = new Set();
const allowedBrowserLifecycle = new Set([
  path.join(apiRoot, "runtime/services/execution-kernel.service.ts"),
]);
const allowedComposition = new Set([
  path.join(apiRoot, "runtime/services/execution-kernel.service.ts"),
]);
const allowedCapabilityOverrides = new Map([
  [
    path.join(apiRoot, "calibration/calibration-runner.ts"),
    new Set(["atomicSecretCapture", "publicValueCapture", "publicValueResolver"]),
  ],
]);
const capabilityKeys = [
  "atomicSecretCapture",
  "publicValueCapture",
  "publicValueResolver",
  "protectedTransactionStore",
  "checkpointStore",
  "calibrationVerifier",
  "recordContextProvenance",
  "recoverAcquisition",
  "groundingHistory",
];
const violations = [];

for (const file of await sourceFiles(apiRoot)) {
  const source = await readFile(file, "utf8");
  if (
    !allowedDirectExecution.has(file) &&
    (/\bexecutePlan\s*\(/.test(source) ||
      /\bprobeFlowPlan\s*\(/.test(source) ||
      /\bexecuteAction\s*\(/.test(source) ||
      /\bexecuteInteractionCompatibility\s*\(/.test(source))
  ) {
    violations.push(`${relative(file)} directly invokes an executor entry point`);
  }
  if (!allowedBrowserLifecycle.has(file) && /\bcreateAuthoringBrowserSession\s*\(/.test(source)) {
    violations.push(`${relative(file)} directly owns the authoring browser lifecycle`);
  }
  if (!allowedComposition.has(file)) {
    const allowedOverrides = allowedCapabilityOverrides.get(file) ?? new Set();
    for (const capability of capabilityKeys) {
      if (!allowedOverrides.has(capability) && new RegExp(`\\b${capability}\\s*:`).test(source)) {
        violations.push(`${relative(file)} assembles ${capability} outside the capability factory`);
      }
    }
  }
}

if (violations.length) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Execution kernel repository boundary verified.\n");
}

async function sourceFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await sourceFiles(target)));
    else if (entry.name.endsWith(".ts")) output.push(target);
  }
  return output;
}

function relative(file) {
  return path.relative(root, file);
}
