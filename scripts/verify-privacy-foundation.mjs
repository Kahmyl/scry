import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const foundationFiles = [
  ...filesUnder("apps").filter((file) => file.includes("/src/") || file.endsWith(".yml")),
  ...filesUnder("packages").filter((file) => file.includes("/src/")),
  "compose.deploy.yml",
  "Dockerfile",
];

const forbidden = [
  { pattern: /protocolVersion|protocol v\d|protocol-v\d/gi, reason: "feature protocol generation" },
  { pattern: /policyVersion/g, reason: "feature policy generation" },
  { pattern: /API v\d|\/v[123]\//g, reason: "versioned public API" },
  { pattern: /actionV\d|stepV\d|testPlanV\d/g, reason: "versioned plan symbol" },
  { pattern: /showSensitiveOverlay|recordVideo/g, reason: "overlay-era recording primitive" },
  { pattern: /captureSecret|revealAndCaptureSecret/g, reason: "split legacy protected action" },
];

const violations = [];
for (const relativePath of foundationFiles) {
  if (relativePath === "apps/api/src/auth.service.ts") continue; // Supabase's external issuer path is not a Scry route.
  const source = readFileSync(resolve(root, relativePath), "utf8");
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(source)) violations.push(`${relativePath}: ${rule.reason}`);
  }
}

if (violations.length > 0) {
  console.error("Privacy foundation freeze failed:\n" + violations.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("Privacy foundation freeze passed: current surface contains no legacy feature-generation or overlay-era primitives.");

function filesUnder(relativeDirectory) {
  const result = [];
  const visit = (relativePath) => {
    for (const entry of readdirSync(resolve(root, relativePath))) {
      if (["node_modules", "dist", "coverage"].includes(entry)) continue;
      const child = `${relativePath}/${entry}`;
      if (statSync(resolve(root, child)).isDirectory()) visit(child);
      else if (/\.(?:ts|tsx|js|mjs|yml|yaml)$/.test(entry)) result.push(child);
    }
  };
  visit(relativeDirectory);
  return result;
}
