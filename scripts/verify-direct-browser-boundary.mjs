import { readFileSync } from "node:fs";

const productionFiles = [
  "apps/api/src/direct-sessions/direct-session.service.ts",
  "apps/api/src/direct-sessions/direct-session.controller.ts",
  "apps/mcp/src/tools/direct-sessions/index.ts",
];
const forbidden = [
  /from ["'][^"']*(missions|authoring|praxis|veil|workers|runs|flows)[^"']*["']/i,
  /\b(executePlan|probeFlowPlan|compile_and_certify_flow)\b/,
];
const violations = [];

for (const file of productionFiles) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(source)) violations.push(`${file}: forbidden direct-lane dependency ${pattern}`);
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Direct browser boundary verified.");
