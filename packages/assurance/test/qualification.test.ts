import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assessExecution,
  parseTestCounts,
  runQualification,
  SAFE_TEST_MARKER,
  type CheckDefinition,
  type ExecutionResult,
  type TestCounts,
} from "../src/qualification.js";
import { retainQualificationReport } from "../src/report-storage.js";
import { checks, checksForProfile, profiles } from "../src/catalog.js";

const counts: TestCounts = { total: 2, passed: 2, failed: 0, skipped: 0, pending: 0, errors: 0 };
const check: CheckDefinition = {
  id: "fixture",
  guarantee: "Selected fixture only",
  command: ["not-executed"],
  tests: { minimumPassed: 2, allowSkipped: false },
};
const run = (overrides: Partial<Parameters<typeof runQualification>[0]> = {}) =>
  runQualification({
    runId: randomUUID(),
    profile: "fixture",
    checks: [check],
    environment: {},
    execute: async () => ({ exitCode: 0, counts }),
    ...overrides,
  });

describe("safe test counts", () => {
  it("accepts only complete nonnegative counters and drops extra properties", () => {
    expect(
      parseTestCounts(
        `raw private output\n${SAFE_TEST_MARKER}${JSON.stringify({ ...counts, secret: "private" })}\n`,
      ),
    ).toEqual(counts);
    for (const value of [
      null,
      {},
      { ...counts, total: 3 },
      { ...counts, passed: -1 },
      { ...counts, errors: 0.5 },
      { ...counts, passed: "2" },
    ]) {
      expect(parseTestCounts(`${SAFE_TEST_MARKER}${JSON.stringify(value)}`)).toBeUndefined();
    }
    expect(parseTestCounts(`${SAFE_TEST_MARKER}{broken`)).toBeUndefined();
    expect(parseTestCounts("ordinary logs only")).toBeUndefined();
    expect(
      parseTestCounts(`${SAFE_TEST_MARKER}${JSON.stringify(counts)}\n${SAFE_TEST_MARKER}{broken`),
    ).toBeUndefined();
  });

  it.each<[string, ExecutionResult]>([
    ["test_report_missing", { exitCode: 0 }],
    ["check_failed", { exitCode: 1, counts }],
    ["check_failed", { exitCode: null, counts }],
    ["no_tests_executed", { exitCode: 0, counts: { ...counts, passed: 0, total: 0 } }],
    ["insufficient_tests", { exitCode: 0, counts: { ...counts, passed: 1, total: 1 } }],
    ["unexpected_skips", { exitCode: 0, counts: { ...counts, total: 3, skipped: 1 } }],
    ["tests_incomplete", { exitCode: 0, counts: { ...counts, total: 3, failed: 1 } }],
    ["tests_incomplete", { exitCode: 0, counts: { ...counts, errors: 1 } }],
    ["tests_incomplete", { exitCode: 0, counts: { ...counts, total: 3, pending: 1 } }],
    ["timeout", { exitCode: 0, issue: "timeout", counts }],
    ["output_limit", { exitCode: 0, issue: "output_limit", counts }],
    ["spawn_failed", { exitCode: null, issue: "spawn_failed" }],
    ["cancelled", { exitCode: 0, issue: "cancelled", counts }],
  ])("never passes %s", (reason, execution) => {
    expect(assessExecution(check, execution)).toMatchObject({
      reason,
      status: reason === "cancelled" ? "cancelled" : "failed",
    });
  });

  it("permits explicitly optional skips, but still requires passing characterization", () => {
    expect(
      assessExecution(
        { ...check, tests: { ...check.tests!, allowSkipped: true } },
        { exitCode: 0, counts: { ...counts, total: 3, skipped: 1 } },
      ).status,
    ).toBe("passed");
    expect(
      assessExecution(check, {
        exitCode: 0,
        counts: { ...counts, secret: "private" } as TestCounts,
      }).counts,
    ).toEqual(counts);
  });
});

describe("qualification outcomes", () => {
  it("cannot turn a cancellation during successful execution into a pass", async () => {
    const cancellation = new AbortController();
    const report = await run({
      signal: cancellation.signal,
      execute: async () => {
        cancellation.abort();
        return { exitCode: 0, counts };
      },
    });
    expect(report.verdict).toBe("cancelled");
    expect(report.checks[0]?.reason).toBe("cancelled");
  });

  it("preserves integration targets and checks the effective command environment", async () => {
    const target = "postgresql://fixture:private-token@localhost/isolated_fixture";
    const environment = {
      SCRY_BROWSER_TEST_DATABASE_URL: target,
      DATABASE_URL: target,
      SCRY_BROWSER_EXPECTED_DATABASE: "isolated_fixture",
    };
    for (const entry of checks.filter((candidate) =>
      candidate.prerequisites?.includes("database"),
    )) {
      expect({ ...environment, ...entry.environment }.SCRY_BROWSER_TEST_DATABASE_URL).toBe(target);
    }
    const execute = vi.fn();
    const report = await run({
      checks: [
        {
          ...check,
          prerequisites: ["database"],
          environment: { SCRY_BROWSER_TEST_DATABASE_URL: "" },
        },
      ],
      environment,
      execute,
    });
    expect(report.verdict).toBe("blocked");
    expect(execute).not.toHaveBeenCalled();
  });

  it("records selected scope without claiming product or release authority", async () => {
    const report = await run();
    expect(report).toMatchObject({
      verdict: "passed",
      scope: "selected_checks_only",
      authority: "diagnostic_only",
      checks: [{ status: "passed", counts }],
    });
    expect(Date.parse(report.completedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
  });

  it("fails closed and does not run later checks or retain errors or environment", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("private-error-token"));
    const report = await run({
      checks: [check, { ...check, id: "later" }],
      execute,
      environment: { DATABASE_URL: "private-database-token" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      verdict: "failed",
      checks: [{ reason: "spawn_failed" }, { status: "not_run" }],
    });
    expect(JSON.stringify(report)).not.toContain("private-");
  });

  it("blocks database execution unless both explicit target and expected name agree", async () => {
    const database = { ...check, prerequisites: ["database" as const] };
    const target = "postgresql://user:private-token@localhost/isolated_fixture";
    const environment = {
      SCRY_BROWSER_TEST_DATABASE_URL: target,
      DATABASE_URL: target,
      SCRY_BROWSER_EXPECTED_DATABASE: "isolated_fixture",
    };
    for (const invalid of [
      {},
      { ...environment, DATABASE_URL: "different" },
      { ...environment, SCRY_BROWSER_EXPECTED_DATABASE: "production" },
      { ...environment, SCRY_BROWSER_TEST_DATABASE_URL: "https://localhost/isolated_fixture" },
    ]) {
      const execute = vi.fn();
      const report = await run({ checks: [database], environment: invalid, execute });
      expect(report.verdict).toBe("blocked");
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain("private-token");
    }
    expect((await run({ checks: [database], environment })).verdict).toBe("passed");
  });

  it("requires Redis namespace and respects cancellation without starting work", async () => {
    const execute = vi.fn();
    const report = await run({
      checks: [{ ...check, prerequisites: ["redis"] }],
      environment: { REDIS_URL: "redis://localhost" },
      execute,
    });
    expect(report).toMatchObject({
      verdict: "blocked",
      checks: [{ reason: "redis_scope_required" }],
    });
    const cancelled = await run({ signal: AbortSignal.abort(), execute });
    expect(cancelled.verdict).toBe("cancelled");
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not create disposable databases without explicit creation scope", async () => {
    const target = "postgres://fixture:private-token@localhost/isolated_fixture";
    const environment = {
      DATABASE_URL: target,
      SCRY_BROWSER_TEST_DATABASE_URL: target,
      SCRY_BROWSER_EXPECTED_DATABASE: "isolated_fixture",
    };
    const candidate = {
      ...check,
      prerequisites: ["database" as const, "database_creation" as const],
    };
    const execute = vi.fn();
    expect(await run({ checks: [candidate], environment, execute })).toMatchObject({
      verdict: "blocked",
      checks: [{ reason: "database_creation_scope_required" }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(
      (
        await run({
          checks: [candidate],
          environment: { ...environment, SCRY_BROWSER_ALLOW_DATABASE_CREATION: "1" },
        })
      ).verdict,
    ).toBe("passed");
  });

  it("rejects empty and duplicate profiles", async () => {
    await expect(run({ checks: [] })).rejects.toThrow("SCRY_ASSURANCE_EMPTY_PROFILE");
    await expect(run({ checks: [check, check] })).rejects.toThrow("SCRY_ASSURANCE_DUPLICATE_CHECK");
  });

  it("retains private immutable reports without overwriting earlier evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scry-assurance-report-"));
    try {
      const report = await run();
      const target = await retainQualificationReport(path.join(directory, "reports"), report);
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual(report);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(target))).mode & 0o777).toBe(0o700);
      await expect(retainQualificationReport(path.dirname(target), report)).rejects.toMatchObject({
        code: "EEXIST",
      });
      await expect(
        retainQualificationReport(directory, { ...report, runId: "../unsafe" }),
      ).rejects.toThrow("SCRY_ASSURANCE_RUN_ID_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves every profile to unique fixed checks and keeps recovery opt-in", () => {
    for (const name of Object.keys(profiles)) {
      const selected = checksForProfile(name);
      expect(selected.length).toBeGreaterThan(0);
      expect(new Set(selected.map((entry) => entry.id)).size).toBe(selected.length);
    }
    expect(new Set(checks.map((entry) => entry.id)).size).toBe(checks.length);
    expect(() => checksForProfile("unknown")).toThrow("SCRY_ASSURANCE_PROFILE_UNKNOWN");
    expect(profiles.fast).not.toContain("production-recovery");
    for (const entry of checks.filter((entry) => entry.prerequisites?.includes("database")))
      expect(entry.tests?.allowSkipped).toBe(false);
  });

  it("preserves the required CI coverage through the shared catalog", () => {
    expect(profiles["ci-fast"]).toEqual(
      expect.arrayContaining([
        "types",
        "repository-closure",
        "deployed-baseline",
        "format",
        "component-contracts",
        "component-api",
        "component-veil",
        "component-praxis",
        "component-chronicle",
        "component-mcp",
        "component-web",
        "component-assurance",
        "web-build",
        "production-dependencies",
        "deployment-runtime",
        "deployment-controller",
        "deployment-tiers",
        "preflight",
        "operations",
        "publication",
        "workflows",
        "boundaries",
        "topology",
      ]),
    );
    expect(profiles.browser).toEqual(
      expect.arrayContaining([
        "browser-recording",
        "browser-custody",
        "component-veil",
        "component-praxis",
        "component-contracts",
        "component-mcp",
        "component-api",
        "web-build",
        "component-web",
        "playwright",
        "boundaries",
        "topology",
      ]),
    );
    expect(profiles.database).toEqual(
      expect.arrayContaining([
        "component-api",
        "component-veil",
        "database-lifecycle",
        "schema-upgrades",
        "boundaries",
        "topology",
      ]),
    );
    expect(profiles.owner).toContain("owner-admission");
    expect(profiles.worker).toContain("worker-journey");
    expect(
      checks.find((entry) => entry.id === "deployed-baseline")?.terminationGraceMs,
    ).toBeGreaterThanOrEqual(125000);
    const database = checks.find((entry) => entry.id === "database-lifecycle")!;
    const upgrades = checks.find((entry) => entry.id === "schema-upgrades")!;
    expect(upgrades.prerequisites).toEqual(["database", "database_creation"]);
    expect(upgrades.tests).toEqual({ minimumPassed: 9, allowSkipped: false });
    expect(database.command).toEqual(
      expect.arrayContaining([
        "test/browser-execution.repository.integration.test.ts",
        "test/browser-execution.process-failure.integration.test.ts",
        "test/browser-lifecycle.repository.integration.test.ts",
        "test/browser-auth-scope.integration.test.ts",
        "test/browser-scope-integrity.integration.test.ts",
        "test/browser-command-order.integration.test.ts",
        "test/browser-command-deadline.integration.test.ts",
        "test/browser-error-admission.integration.test.ts",
      ]),
    );
    expect(database.tests).toEqual({ minimumPassed: 24, allowSkipped: false });
    expect(profiles.worker).toContain("command-queue");
    expect(profiles.worker).toContain("worker-shutdown");
    expect(checks.find((entry) => entry.id === "worker-shutdown")?.tests).toEqual({
      minimumPassed: 1,
      allowSkipped: false,
    });
    expect(checks.find((entry) => entry.id === "worker-shutdown")?.prerequisites).toEqual([
      "redis",
    ]);
    const custody = checks.find((entry) => entry.id === "browser-custody")!;
    expect(custody.command).toContain("test/owned-browser.integration.test.ts");
    expect(custody.environment).toEqual({ SCRY_BROWSER_E2E: "1" });
    expect(custody.tests).toEqual({ minimumPassed: 4, allowSkipped: false });
    expect(checks.find((entry) => entry.id === "command-queue")?.prerequisites).toEqual([
      "database",
      "redis",
    ]);
    expect(checks.find((entry) => entry.id === "owner-admission")?.tests?.minimumPassed).toBe(5);
  });
});
