import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createQ0Report, renderQ0Markdown } from "../src/architecture/q0/report.js";
import { stableJson } from "../src/architecture/q0/validator.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, "artifacts/system-correctness/q0");
const { report, digest } = await createQ0Report(root);

await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, "q0-report.json"),
  stableJson({ ...report, reportDigest: digest }),
);
await writeFile(path.join(output, "q0-report.md"), renderQ0Markdown(report, digest));

process.stdout.write(
  `${report.milestoneStatus} Q0 ${digest} artifacts/system-correctness/q0/q0-report.json\n`,
);

if (report.milestoneStatus !== "PASS") process.exitCode = 1;
