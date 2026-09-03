import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableJson } from "../src/architecture/q0/validator.js";
import { createQ3Report, renderQ3Markdown } from "../src/architecture/q3/report.js";

if (process.env.NODE_ENV !== "test") process.env.NODE_ENV = "test";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, "artifacts/system-correctness/q3");
const { report, digest } = await createQ3Report(root);
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, "q3-report.json"),
  stableJson({ ...report, reportDigest: digest }),
);
await writeFile(path.join(output, "q3-report.md"), renderQ3Markdown(report, digest));
process.stdout.write(
  `${report.verdicts.milestone5Implementation} Q3/${report.verdicts.q3Fixture}/${report.verdicts.q3IndependentOracle}/${report.verdicts.q3ProductGate} ${digest} artifacts/system-correctness/q3/q3-report.json\n`,
);
if (report.verdicts.q3ProductGate !== "PASS") process.exitCode = 1;
