import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("allows a declared cleanup phase while retaining the cancellation verdict", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scry-process-cleanup-")),
      ready = path.join(directory, "ready"),
      complete = path.join(directory, "complete"),
      controller = new AbortController();
    const source = `const fs=require('node:fs');process.once('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(complete)},'clean');process.exit(0)},150));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
    try {
      const result = execute(
        fixture(source, { terminationGraceMs: 1000, timeoutMs: 5000 }),
        controller.signal,
      );
      await expect
        .poll(() =>
          access(ready).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      controller.abort();
      expect((await result).issue).toBe("cancelled");
      expect(await readFile(complete, "utf8")).toBe("clean");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("still forcibly bounds an uncooperative process and rejects unbounded grace", async () => {
    const start = Date.now();
    expect(
      (
        await execute(
          fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", {
            timeoutMs: 200,
            terminationGraceMs: 50,
          }),
        )
      ).issue,
    ).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(2000);
    for (const grace of [0, -1, NaN, Infinity, 180001])
      expect((await execute(fixture("process.exit(0)", { terminationGraceMs: grace }))).issue).toBe(
        "invalid_configuration",
      );
  });
});
