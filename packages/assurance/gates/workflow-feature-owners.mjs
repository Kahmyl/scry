// Capability rollout gates do not select another runtime. Keep their readers
// finite and explicit; a new flag or owner still requires architectural review.
const owners = {
  SCRY_BROWSER_WORKFLOW_V1_ENABLED: new Set([
    "apps/api/src/browser-execution/controllers/browser-lifecycle.controller.ts",
    "apps/api/src/browser-execution/repositories/browser-command.repository.ts",
    "apps/api/src/test-resources/testing-context.controller.ts",
  ]),
  SCRY_BROWSER_WORKFLOW_V2_ENABLED: new Set([
    "apps/api/src/browser-execution/repositories/browser-command.repository.ts",
    "apps/api/src/test-resources/testing-context.controller.ts",
    "packages/praxis/src/mcp-browser-engine.ts",
  ]),
};
export const admittedWorkflowFeature = (sourcePath, flag) =>
  Object.hasOwn(owners, flag) && owners[flag].has(sourcePath);
