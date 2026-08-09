import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mcpSource = readTree(join(root, "apps/mcp/src"));
const authoringController = readFileSync(
  join(root, "apps/api/src/authoring/authoring.controller.ts"),
  "utf8",
);
const sessionController = readFileSync(
  join(root, "apps/api/src/adaptive-sessions/adaptive-session.controller.ts"),
  "utf8",
);

const displacedTools = [
  "advance_authoring_turn",
  "validate_test_plan",
  "update_flow_draft",
  "start_probe_session",
  "get_probe_session",
  "cancel_probe_session",
  "compile_flow_draft",
  "bind_credential_fill_step",
  "bind_protected_transaction_step",
  "suspend_flow_authoring",
  "resume_flow_authoring",
  "cancel_flow_authoring",
];
const displacedRoutes = [
  "@Patch(\"flow-drafts/:draftId\")",
  "flow-drafts/:draftId/probes",
  "probe-sessions/:probeId/commands",
  "probe-sessions/:probeId/advance",
  "probe-sessions/:probeId/cancel",
  "@Get(\"probe-sessions/:probeId\")",
  "flow-drafts/:draftId/compile\")",
];

const failures = [];
for (const name of displacedTools) {
  if (mcpSource.includes(`\"${name}\"`)) failures.push(`displaced MCP tool remains: ${name}`);
}
for (const route of displacedRoutes) {
  if (authoringController.includes(route)) failures.push(`displaced API route remains: ${route}`);
}
for (const route of ["/suspend", "/resume", "/cancel"]) {
  if (sessionController.includes(route)) failures.push(`displaced session route remains: ${route}`);
}
for (const required of [
  "start_flow_authoring",
  "advance_flow_authoring",
  "get_flow_authoring",
  "close_flow_authoring",
]) {
  if (!mcpSource.includes(`\"${required}\"`)) failures.push(`required MCP tool missing: ${required}`);
}
if (!sessionController.includes('@Post(\":sessionId/close\")')) {
  failures.push("required close API route missing");
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exit(1);
}
process.stdout.write("M2 grouped Mission authoring boundary verified.\n");

function readTree(directory) {
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? readTree(path) : readFileSync(path, "utf8");
    })
    .join("\n");
}
