import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/praxis-verification.yml"), "utf8");
const publish = readFileSync(resolve(root, ".github/workflows/docker-publish.yml"), "utf8");

const requiredTriggers = [
  '".github/workflows/docker-publish.yml"',
  '"packages/contracts/**"',
  '"packages/executor/**"',
  '"packages/policy/**"',
  '"scripts/verify-praxis-*.mjs"',
  '"docs/architecture/praxis-*.md"',
  '"docs/architecture/praxis-*.json"',
  '"pnpm-lock.yaml"',
];
const requiredCampaigns = [
  "pnpm campaign:praxis",
  "pnpm campaign:praxis:100",
  "pnpm campaign:praxis:resilience",
  "pnpm campaign:praxis:certification",
  "pnpm campaign:praxis:public-apps",
];

const failures = [];
for (const trigger of requiredTriggers)
  if (!workflow.includes(trigger)) failures.push(`missing Praxis change trigger ${trigger}`);
for (const campaign of requiredCampaigns) {
  if (!workflow.includes(campaign)) failures.push(`change workflow does not run ${campaign}`);
  if (!publish.includes(campaign)) failures.push(`release workflow does not run ${campaign}`);
}
if (!workflow.includes("pull_request:") || !workflow.includes("push:"))
  failures.push("Praxis workflow must cover pull requests and main-branch pushes");
if ((workflow.match(/uses: actions\/upload-artifact@v4/g) ?? []).length !== 2)
  failures.push("both campaign jobs must retain evidence");
if (!workflow.includes("if: always()")) failures.push("campaign evidence must survive failed runs");
if (!workflow.includes("SCRY_BROWSER_CHANNEL: chrome"))
  failures.push("campaigns must use the configured real Chrome channel");

if (failures.length) {
  console.error(
    `Praxis change gate verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
  process.exit(1);
}

console.log(
  "Praxis change gate verified: relevant updates and Docker releases run all production and public campaigns.",
);
