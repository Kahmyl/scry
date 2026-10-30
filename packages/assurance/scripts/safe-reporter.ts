import type { Reporter } from "vitest/reporters";
import { SAFE_TEST_MARKER, type TestCounts } from "../src/qualification.js";

/** Emits counts only: never test names, error messages, captured values or logs. */
export default class SafeQualificationReporter implements Reporter {
  onTestRunEnd: NonNullable<Reporter["onTestRunEnd"]> = (modules, errors, reason) => {
    const counts: TestCounts = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      errors: errors.length + (reason === "passed" ? 0 : 1),
    };
    for (const module of modules) {
      if (module.state() === "failed") counts.errors += 1;
      for (const test of module.children.allTests()) {
        counts.total += 1;
        const state = test.result().state;
        if (state === "passed") counts.passed += 1;
        else if (state === "failed") counts.failed += 1;
        else if (state === "skipped") counts.skipped += 1;
        else counts.pending += 1;
      }
    }
    process.stdout.write(`${SAFE_TEST_MARKER}${JSON.stringify(counts)}\n`);
  };
}
