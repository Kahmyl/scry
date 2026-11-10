import assert from "node:assert/strict";
import test from "node:test";
import { admittedWorkflowFeature } from "../workflow-feature-owners.mjs";
test("workflow gates admit only named capability owners", () => {
  assert.equal(
    admittedWorkflowFeature(
      "packages/praxis/src/mcp-browser-engine.ts",
      "SCRY_BROWSER_WORKFLOW_V2_ENABLED",
    ),
    true,
  );
  assert.equal(
    admittedWorkflowFeature(
      "apps/api/src/browser-execution/controllers/browser-lifecycle.controller.ts",
      "SCRY_BROWSER_WORKFLOW_V1_ENABLED",
    ),
    true,
  );
  for (const flag of [
    "SCRY_BROWSER_NEW_RUNTIME_ENABLED",
    "SCRY_BROWSER_WORKFLOW_V3_ENABLED",
    "constructor",
    "__proto__",
  ])
    assert.equal(admittedWorkflowFeature("packages/praxis/src/mcp-browser-engine.ts", flag), false);
  for (const path of [
    "apps/api/src/new-runtime.ts",
    "apps/mcp/src/server.ts",
    "packages/praxis/src/new-engine.ts",
  ])
    assert.equal(admittedWorkflowFeature(path, "SCRY_BROWSER_WORKFLOW_V2_ENABLED"), false);
  assert.equal(
    admittedWorkflowFeature(
      "packages/praxis/src/mcp-browser-engine.ts",
      "SCRY_BROWSER_WORKFLOW_V1_ENABLED",
    ),
    false,
  );
});
