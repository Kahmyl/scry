import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createM6Report, renderM6Markdown } from "../src/architecture/m6/report.js";
import { stableJson } from "../src/architecture/q0/validator.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, "artifacts/system-correctness/m6");
const { report, digest } = await createM6Report(root);
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, "m6-report.json"),
  stableJson({ ...report, reportDigest: digest }),
);
await writeFile(path.join(output, "m6-report.md"), renderM6Markdown(report, digest));
process.stdout.write(
  `${report.verdicts.m6ProductGate} ${report.verdicts.progression} ${digest} artifacts/system-correctness/m6/m6-report.json\n`,
);
if (report.verdicts.m6ProductGate !== "PASS") process.exitCode = 1;
