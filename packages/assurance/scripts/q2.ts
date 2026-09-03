import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableJson } from "../src/architecture/q0/validator.js";
import { createQ2Report, renderQ2Markdown } from "../src/architecture/q2/report.js";

if (process.env.NODE_ENV !== "test") process.env.NODE_ENV = "test";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, "artifacts/system-correctness/q2");
const { report, digest } = await createQ2Report(root);
await mkdir(path.join(output, "reproductions"), { recursive: true });
await writeFile(
  path.join(output, "q2-report.json"),
  stableJson({ ...report, reportDigest: digest }),
);
await writeFile(path.join(output, "q2-report.md"), renderQ2Markdown(report, digest));
for (const finding of report.productFindings)
  await writeFile(
    path.join(
      output,
      "reproductions",
      `${finding.invariantId}-${finding.boundary}-${finding.reproduction.seed}.json`,
    ),
    stableJson(finding),
  );
process.stdout.write(
  `${report.verdicts.milestone3Implementation} Q2/${report.verdicts.q2FaultInfrastructure}/${report.verdicts.q2ProductGate} ${digest} artifacts/system-correctness/q2/q2-report.json\n`,
);
if (
  report.verdicts.milestone3Implementation !== "PASS" ||
  report.verdicts.q2FaultInfrastructure !== "PASS"
)
  process.exitCode = 1;
