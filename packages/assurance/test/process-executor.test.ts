import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProcessExecutor } from "../src/process-executor.js";
import { SAFE_TEST_MARKER, type CheckDefinition } from "../src/qualification.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execute = createProcessExecutor(root, process.env);
const fixture = (source: string, extra: Partial<CheckDefinition> = {}): CheckDefinition => ({
  id: "process-fixture",
  guarantee: "Isolated child lifecycle",
  command: [process.execPath, "--eval", source, "--"],
  timeoutMs: 2_000,
  ...extra,
});

describe("bounded child processes", () => {
  it("reduces output to counters and never returns raw stdout or stderr", async () => {
    const counts = { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, errors: 0 };
    // Node's --eval accepts trailing arguments; the safe reporter path is not executed here.
    const result = await execute(
      fixture(
        `console.error("private-stderr"); console.log("private-stdout"); console.log(${JSON.stringify(SAFE_TEST_MARKER + JSON.stringify(counts))})`,
        { tests: { minimumPassed: 1, allowSkipped: false } },
      ),
    );
    expect(result).toEqual({ exitCode: 0, counts });
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("distinguishes nonzero exits, missing commands and absent counters", async () => {
    expect((await execute(fixture("process.exit(7)"))).exitCode).toBe(7);
    expect(
      (await execute(fixture("", { command: ["/missing-scry-assurance-executable"] }))).issue,
    ).toBe("spawn_failed");
    expect(await execute(fixture("console.log('not a test report')"))).toEqual({ exitCode: 0 });
  });

  it("bounds hung processes and output floods", async () => {
    expect((await execute(fixture("setInterval(() => {}, 1000)", { timeoutMs: 100 }))).issue).toBe(
      "timeout",
    );
    expect(
      (
        await execute(
          fixture("process.stdout.write('x'.repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000)"),
        )
      ).issue,
    ).toBe("output_limit");
  });

  it("cancels both before spawn and during execution", async () => {
    expect((await execute(fixture("process.exit(0)"), AbortSignal.abort())).issue).toBe(
      "cancelled",
    );
    const cancellation = new AbortController();
    const result = execute(fixture("setInterval(() => {}, 1000)"), cancellation.signal);
    setTimeout(() => cancellation.abort(), 100);
    expect((await result).issue).toBe("cancelled");
  });
});
