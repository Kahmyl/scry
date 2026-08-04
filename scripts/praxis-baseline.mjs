import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const files = [
  "test/capability-grounding-gauntlet.test.ts",
  "test/capability-grounding-real-http-cohort-a.test.ts",
  "test/capability-grounding-http-cohort-b.test.ts",
  "test/production-http-capability-cohort-c.test.ts",
];
const startedAt = new Date().toISOString();
const started = performance.now();
const run = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", ...files, "--reporter=json", "--maxWorkers=1"],
  {
    cwd: new URL("../packages/executor/", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, SCRY_BROWSER_CHANNEL: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" },
  },
);
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  report = { testResults: [], parseError: true };
}
const scenarios = (report.testResults ?? []).flatMap((suite) =>
  (suite.assertionResults ?? []).map((test) => {
    const title = test.title ?? test.fullName ?? "unknown";
    const lower = title.toLowerCase();
    return {
      suite: suite.name,
      scenario: title,
      status: test.status,
      failureCode: test.failureMessages?.length ? "TEST_FAILURE" : null,
      durationMs: test.duration ?? null,
      operation: /fill|input|textarea|editable|password/.test(lower)
        ? "enter_text"
        : /select/.test(lower)
          ? "select_option"
          : /check|toggle|switch/.test(lower)
            ? "set_checked"
            : /read|value|acquisition|copy/.test(lower)
              ? "read_value"
              : /click|button|link|canvas/.test(lower)
                ? "activate"
                : "inspect",
      evidence: /ocr/.test(lower)
        ? ["ocr"]
        : /visual|icon|canvas|geometry/.test(lower)
          ? ["visual"]
          : ["semantic"],
      coldOrWarm: /warm/.test(lower) ? "warm" : /cold/.test(lower) ? "cold" : "unspecified",
      phaseTiming: { groundingMs: null, effectVerificationMs: null },
      channels: {
        ocr: /ocr/.test(lower),
        visual: /visual|icon|canvas|geometry/.test(lower),
        history: /history|drift/.test(lower),
        adapter: /adapter/.test(lower),
      },
    };
  }),
);
const output = {
  schemaVersion: 1,
  startedAt,
  durationMs: Math.round(performance.now() - started),
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  },
  corpus: files,
  corpusDigest: createHash("sha256").update(files.join("\n")).digest("hex"),
  success: run.status === 0,
  exitCode: run.status,
  scenarios,
  infrastructureOutput: run.status === 0 ? undefined : run.stderr.slice(-8_000),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.stderr.write(
  `Praxis baseline: ${scenarios.filter((item) => item.status === "passed").length} passed, ${scenarios.filter((item) => item.status === "failed").length} failed, ${output.durationMs}ms total.\n`,
);
process.exit(run.status ?? 1);
