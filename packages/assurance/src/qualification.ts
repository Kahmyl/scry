export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  errors: number;
}

export interface CheckDefinition {
  id: string;
  guarantee: string;
  command: readonly string[];
  environment?: Readonly<Record<string, string>>;
  prerequisites?: readonly ("database" | "redis")[];
  tests?: { minimumPassed: number; allowSkipped: boolean };
  timeoutMs?: number;
  /** Separate bounded time for a resource-owning check to stop and clean up. */
  terminationGraceMs?: number;
}

export interface ExecutionResult {
  exitCode: number | null;
  issue?: "timeout" | "cancelled" | "spawn_failed" | "output_limit" | "invalid_configuration";
  counts?: TestCounts;
}
export type CheckReason =
  | "completed"
  | "check_failed"
  | "test_report_missing"
  | "no_tests_executed"
  | "insufficient_tests"
  | "tests_incomplete"
  | "unexpected_skips"
  | "database_scope_required"
  | "redis_scope_required"
  | "prior_check_failed"
  | NonNullable<ExecutionResult["issue"]>;
export interface CheckResult {
  id: string;
  guarantee: string;
  status: "passed" | "failed" | "blocked" | "cancelled" | "not_run";
  reason: CheckReason;
  durationMs: number;
  counts?: TestCounts;
}
export interface QualificationReport {
  runId: string;
  profile: string;
  scope: "selected_checks_only";
  authority: "diagnostic_only";
  verdict: "passed" | "failed" | "blocked" | "cancelled";
  startedAt: string;
  completedAt: string;
  checks: CheckResult[];
}
export type CheckExecutor = (
  check: CheckDefinition,
  signal?: AbortSignal,
) => Promise<ExecutionResult>;
export const SAFE_TEST_MARKER = "SCRY_ASSURANCE_TEST_COUNTS ";

function normalizeTestCounts(value: unknown): TestCounts | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const keys = ["total", "passed", "failed", "skipped", "pending", "errors"] as const;
  if (keys.some((key) => !Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) return undefined;
  const counts = Object.fromEntries(keys.map((key) => [key, raw[key]])) as unknown as TestCounts;
  if (counts.total !== counts.passed + counts.failed + counts.skipped + counts.pending)
    return undefined;
  return counts;
}

export function parseTestCounts(output: string): TestCounts | undefined {
  const line = output
    .split(/\r?\n/u)
    .reverse()
    .find((value) => value.startsWith(SAFE_TEST_MARKER));
  if (!line) return undefined;
  try {
    return normalizeTestCounts(JSON.parse(line.slice(SAFE_TEST_MARKER.length)));
  } catch {
    return undefined;
  }
}

function prerequisite(
  check: CheckDefinition,
  environment: Readonly<Record<string, string | undefined>>,
): CheckReason | undefined {
  if (check.prerequisites?.includes("database")) {
    try {
      const target = new URL(environment.SCRY_BROWSER_TEST_DATABASE_URL ?? "");
      if (
        !environment.SCRY_BROWSER_EXPECTED_DATABASE ||
        decodeURIComponent(target.pathname.slice(1)) !==
          environment.SCRY_BROWSER_EXPECTED_DATABASE ||
        environment.DATABASE_URL !== environment.SCRY_BROWSER_TEST_DATABASE_URL ||
        !["postgres:", "postgresql:"].includes(target.protocol)
      )
        return "database_scope_required";
    } catch {
      return "database_scope_required";
    }
  }
  if (
    check.prerequisites?.includes("redis") &&
    (!environment.REDIS_URL || !environment.SCRY_BROWSER_QUEUE_NAMESPACE?.trim())
  )
    return "redis_scope_required";
  return undefined;
}

export function assessExecution(
  check: CheckDefinition,
  execution: ExecutionResult,
): Pick<CheckResult, "status" | "reason" | "counts"> {
  if (execution.issue)
    return {
      status: execution.issue === "cancelled" ? "cancelled" : "failed",
      reason: execution.issue,
    };
  const counts = normalizeTestCounts(execution.counts);
  if (execution.exitCode !== 0)
    return { status: "failed", reason: "check_failed", ...(counts ? { counts } : {}) };
  if (check.tests) {
    if (!counts) return { status: "failed", reason: "test_report_missing" };
    if (counts.failed || counts.errors || counts.pending)
      return { status: "failed", reason: "tests_incomplete", counts };
    if (counts.passed < check.tests.minimumPassed)
      return {
        status: "failed",
        reason: counts.passed === 0 ? "no_tests_executed" : "insufficient_tests",
        counts,
      };
    if (!check.tests.allowSkipped && counts.skipped)
      return { status: "failed", reason: "unexpected_skips", counts };
  }
  return { status: "passed", reason: "completed", ...(counts ? { counts } : {}) };
}

/** Records diagnostic outcomes only. The executor receives checks, never product
 * facts to rewrite; raw errors/output/environment values never enter the report. */
export async function runQualification(input: {
  runId: string;
  profile: string;
  checks: readonly CheckDefinition[];
  execute: CheckExecutor;
  environment: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  progress?: (check: CheckResult) => void;
}): Promise<QualificationReport> {
  if (!input.checks.length) throw new Error("SCRY_ASSURANCE_EMPTY_PROFILE");
  if (new Set(input.checks.map((check) => check.id)).size !== input.checks.length)
    throw new Error("SCRY_ASSURANCE_DUPLICATE_CHECK");
  const report: QualificationReport = {
    runId: input.runId,
    profile: input.profile,
    scope: "selected_checks_only",
    authority: "diagnostic_only",
    verdict: "passed",
    startedAt: new Date().toISOString(),
    completedAt: "",
    checks: [],
  };
  let stopped = false;
  for (const check of input.checks) {
    const start = Date.now();
    let result: Pick<CheckResult, "status" | "reason" | "counts">;
    if (stopped) result = { status: "not_run", reason: "prior_check_failed" };
    else if (input.signal?.aborted) result = { status: "cancelled", reason: "cancelled" };
    else {
      const missing = prerequisite(check, { ...input.environment, ...check.environment });
      if (missing) result = { status: "blocked", reason: missing };
      else {
        try {
          const execution = await input.execute(check, input.signal);
          result = input.signal?.aborted
            ? { status: "cancelled", reason: "cancelled" }
            : assessExecution(check, execution);
        } catch {
          result = input.signal?.aborted
            ? { status: "cancelled", reason: "cancelled" }
            : { status: "failed", reason: "spawn_failed" };
        }
      }
    }
    const entry: CheckResult = {
      id: check.id,
      guarantee: check.guarantee,
      ...result,
      durationMs: Date.now() - start,
    };
    report.checks.push(entry);
    input.progress?.(entry);
    if (!stopped && entry.status !== "passed") {
      report.verdict =
        entry.status === "blocked"
          ? "blocked"
          : entry.status === "cancelled"
            ? "cancelled"
            : "failed";
      stopped = true;
    }
  }
  report.completedAt = new Date().toISOString();
  return report;
}
