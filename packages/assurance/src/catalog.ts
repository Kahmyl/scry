import type { CheckDefinition } from "./qualification.js";

const componentEnvironment = { SCRY_BROWSER_TEST_DATABASE_URL: "", SCRY_BROWSER_E2E: "0" };
const script = (
  id: string,
  guarantee: string,
  command: string,
  timeoutMs = 180_000,
  terminationGraceMs = 5_000,
): CheckDefinition => ({
  id,
  guarantee,
  command: ["pnpm", command],
  timeoutMs,
  terminationGraceMs,
});
const tests = (
  id: string,
  guarantee: string,
  owner: string,
  files: string[] = [],
  options: {
    integrated?: boolean;
    database?: boolean;
    databaseCreation?: boolean;
    redis?: boolean;
    minimum?: number;
  } = {},
): CheckDefinition => ({
  id,
  guarantee,
  command: ["pnpm", "--filter", owner, "exec", "vitest", "run", ...files, "--maxWorkers=1"],
  environment: options.integrated
    ? { SCRY_BROWSER_E2E: "1" }
    : options.database
      ? { SCRY_BROWSER_E2E: "0" }
      : componentEnvironment,
  prerequisites: [
    ...(options.database ? ["database" as const] : []),
    ...(options.redis ? ["redis" as const] : []),
    ...(options.databaseCreation ? ["database_creation" as const] : []),
  ],
  tests: {
    minimumPassed: options.minimum ?? 1,
    allowSkipped: !options.integrated && !options.database,
  },
  timeoutMs: 180_000,
});

const componentOwners = [
  "contracts",
  "veil",
  "chronicle",
  "praxis",
  "api",
  "mcp",
  "web",
  "assurance",
];
const componentMinimums: Readonly<Record<string, number>> = {
  contracts: 9,
  veil: 69,
  chronicle: 63,
  praxis: 196,
  api: 85,
  mcp: 7,
  web: 8,
  assurance: 32,
};
export const checks: readonly CheckDefinition[] = [
  script("format", "Source and documentation remain formatted", "format:check"),
  script("types", "The active applications and all four boundaries compose", "typecheck"),
  script(
    "repository-closure",
    "Every retained source belongs to the explicit baseline or its supported checks",
    "verify:repository-closure",
  ),
  script(
    "deployed-baseline",
    "The production image executes an isolated public API/MCP browser journey without Assurance",
    "verify:deployed-baseline",
    900_000,
    135_000,
  ),
  ...componentOwners.map((owner) =>
    tests(
      `component-${owner}`,
      `Owner-local ${owner} characterization tests`,
      `@scry/${owner}`,
      [],
      { minimum: componentMinimums[owner]! },
    ),
  ),
  script("web-build", "The customer dashboard builds", "build"),
  script("playwright", "Browser package and container revisions agree", "verify:playwright"),
  script("topology", "Only the baseline production graph is admitted", "verify:baseline-topology"),
  script(
    "boundaries",
    "Production ownership and negative dependency rules hold",
    "verify:boundary-ownership",
  ),
  script("workflows", "CI commands resolve to current manifests", "verify:workflow-manifests"),
  script(
    "publication",
    "Container publication selects the qualified baseline",
    "verify:docker-publish-workflow",
  ),
  script(
    "deployment-controller",
    "Deployment refusal and rollback preserve state",
    "verify:server-deployment",
  ),
  script(
    "production-dependencies",
    "Production composes without development tools or Assurance",
    "verify:boundary-runtime",
    600_000,
  ),
  script(
    "deployment-runtime",
    "The real Caddy image accepts the configuration",
    "verify:deployment-runtime",
  ),
  script(
    "deployment-tiers",
    "Deployment tier combinations are admitted correctly",
    "verify:deployment-tiers",
  ),
  script(
    "operations",
    "Operational manifests retain backup and alert requirements",
    "verify:production-operations",
  ),
  script(
    "preflight",
    "Runtime preflight admits the selected deployment scope",
    "verify:deployment-preflight",
  ),
  script(
    "production-recovery",
    "An isolated backup restores and promotes correctly",
    "verify:production-recovery",
    3_700_000,
    135_000,
  ),
  tests(
    "browser-custody",
    "Actual browser process exit is confirmed for close, forced cancellation and failed connection",
    "@scry/praxis",
    ["test/owned-browser.integration.test.ts"],
    { integrated: true, minimum: 4 },
  ),
  tests(
    "browser-supervision",
    "Independent native custody enforces phase and authority deadlines during controller stalls, transport loss and helper death",
    "@scry/praxis",
    ["test/supervised-browser.integration.test.ts"],
    { integrated: true, minimum: 10 },
  ),
  tests(
    "command-cancellation",
    "An exact command attempt drains native actions and late acquisition without killing later or independent browsers",
    "@scry/praxis",
    ["test/command-lane.integration.test.ts"],
    { integrated: true, minimum: 4 },
  ),
  tests(
    "browser-recording",
    "Protected recording and zero-network replay through public boundaries",
    "@scry/assurance",
    ["test/browser-recording.test.ts"],
    { integrated: true, minimum: 2 },
  ),
  tests(
    "schema-upgrades",
    "Retained baselines upgrade transactionally with guarded history, rollback and recovery",
    "@scry/api",
    ["test/baseline-migration.integration.test.ts"],
    { database: true, databaseCreation: true, minimum: 10 },
  ),
  tests(
    "database-lifecycle",
    "Scope, lifecycle, capture atomicity and uncertain mutation truth",
    "@scry/api",
    [
      "test/browser-execution.repository.integration.test.ts",
      "test/browser-execution.process-failure.integration.test.ts",
      "test/browser-lifecycle.repository.integration.test.ts",
      "test/browser-auth-scope.integration.test.ts",
      "test/browser-scope-integrity.integration.test.ts",
      "test/browser-command-order.integration.test.ts",
      "test/browser-command-deadline.integration.test.ts",
      "test/browser-command-claim-fencing.integration.test.ts",
      "test/browser-owner-clock.integration.test.ts",
      "test/browser-owner-retirement.repository.integration.test.ts",
      "test/browser-error-admission.integration.test.ts",
      "test/browser-evidence-admission.integration.test.ts",
    ],
    { database: true, minimum: 86 },
  ),
  tests(
    "command-queue",
    "Ordered transport deferral preserves the job retry budget",
    "@scry/api",
    ["test/browser-command-queue.integration.test.ts"],
    { database: true, redis: true },
  ),
  tests(
    "worker-shutdown",
    "Busy native browser cancellation precedes actual Redis job and transport drain",
    "@scry/api",
    ["test/browser-worker-shutdown.integration.test.ts"],
    { integrated: true, redis: true },
  ),
  tests(
    "worker-journey",
    "Durable commands protect dependent mutations and observations",
    "@scry/api",
    ["test/browser-command.worker.integration.test.ts"],
    { integrated: true, database: true, redis: true },
  ),
  tests(
    "command-lifetime",
    "Actual Redis/native execution stops on carried expiry or fenced claim without false terminal writes",
    "@scry/api",
    ["test/browser-command-lifetime.integration.test.ts"],
    { integrated: true, database: true, redis: true, minimum: 3 },
  ),
  tests(
    "engine-command-lifetime",
    "Composed engine cancellation drains a busy native browser, rejects overlap and isolates old signals",
    "@scry/api",
    ["test/browser-engine-command-lifetime.integration.test.ts"],
    { integrated: true, database: true, minimum: 3 },
  ),
  tests(
    "owner-admission",
    "Replaced owners cannot admit recording or complete evidence",
    "@scry/api",
    ["test/browser-owner-fencing.integration.test.ts"],
    { integrated: true, database: true, minimum: 5 },
  ),
  tests(
    "owner-watchdog",
    "Native browser stops during a real blocked owner renewal without late startup or premature valid-owner retirement",
    "@scry/api",
    ["test/browser-owner-watchdog.integration.test.ts"],
    { integrated: true, database: true, minimum: 3 },
  ),
  tests(
    "evidence-closure",
    "Native-stop and seal acknowledgment recovery never reopen application browsers or promote interrupted evidence",
    "@scry/api",
    ["test/browser-evidence-closure.integration.test.ts"],
    { integrated: true, database: true, minimum: 5 },
  ),
  tests(
    "owner-retirement",
    "Confirmed native exit admits durable pending-effect reconciliation and immediate fenced replacement",
    "@scry/api",
    ["test/browser-owner-retirement.integration.test.ts"],
    { integrated: true, database: true, minimum: 3 },
  ),
  tests(
    "evidence-availability",
    "Unavailable recording artifacts seal only explicit failed-run closure without losing receipt or owner authority",
    "@scry/api",
    ["test/browser-evidence-unavailable.integration.test.ts"],
    { integrated: true, database: true, minimum: 10 },
  ),
  tests(
    "failure-finalization",
    "Failure closure preserves UNKNOWN without redispatch",
    "@scry/api",
    ["test/browser-command.failure-finalization.integration.test.ts"],
    { integrated: true, database: true },
  ),
  tests(
    "worker-recovery",
    "Real process replacement restores protected checkpoint continuity",
    "@scry/api",
    ["test/browser-worker-process-recovery.integration.test.ts"],
    { integrated: true, database: true, redis: true, minimum: 3 },
  ),
  tests(
    "long-journey",
    "A repeated browser journey seals evidence and publishes a report",
    "@scry/api",
    ["test/browser-execution.long-journey.integration.test.ts"],
    { integrated: true, database: true },
  ),
];

const fast = [
  "format",
  "types",
  "repository-closure",
  ...componentOwners.map((owner) => `component-${owner}`),
  "web-build",
  "playwright",
  "topology",
  "boundaries",
  "workflows",
  "publication",
  "deployment-controller",
];
export const profiles: Readonly<Record<string, readonly string[]>> = {
  fast,
  "ci-fast": [
    ...fast,
    "production-dependencies",
    "deployment-runtime",
    "deployment-tiers",
    "operations",
    "preflight",
    "deployed-baseline",
  ],
  browser: [
    "playwright",
    "browser-custody",
    "browser-supervision",
    "command-cancellation",
    "component-veil",
    "component-praxis",
    "browser-recording",
    "component-contracts",
    "component-mcp",
    "web-build",
    "component-web",
    "component-api",
    "topology",
    "boundaries",
  ],
  database: [
    "component-api",
    "component-veil",
    "schema-upgrades",
    "database-lifecycle",
    "topology",
    "boundaries",
  ],
  worker: ["command-queue", "worker-shutdown", "worker-journey", "command-lifetime"],
  owner: [
    "owner-admission",
    "engine-command-lifetime",
    "owner-watchdog",
    "owner-retirement",
    "evidence-closure",
    "evidence-availability",
  ],
  failure: ["failure-finalization"],
  recovery: ["worker-recovery"],
  journey: ["long-journey"],
  deployment: [
    "deployment-controller",
    "deployment-runtime",
    "deployment-tiers",
    "operations",
    "preflight",
  ],
  "production-dependencies": ["production-dependencies"],
  "deployed-smoke": ["deployed-baseline"],
  "production-recovery": ["production-recovery"],
};

export function checksForProfile(profile: string): readonly CheckDefinition[] {
  if (!Object.hasOwn(profiles, profile)) throw new Error("SCRY_ASSURANCE_PROFILE_UNKNOWN");
  return profiles[profile]!.map((id) => {
    const check = checks.find((candidate) => candidate.id === id);
    if (!check) throw new Error("SCRY_ASSURANCE_CHECK_UNKNOWN");
    return check;
  });
}
