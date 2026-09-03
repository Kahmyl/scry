import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableJson } from "../src/architecture/q0/validator.js";
import { createQ1Report, renderQ1Markdown } from "../src/architecture/q1/report.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, "artifacts/system-correctness/q1");
const { report, digest, reproductions } = await createQ1Report(root);
await mkdir(path.join(output, "reproductions"), { recursive: true });
await writeFile(
  path.join(output, "q1-report.json"),
  stableJson({ ...report, reportDigest: digest }),
);
await writeFile(path.join(output, "q1-report.md"), renderQ1Markdown(report, digest));
for (const reproduction of reproductions) {
  await writeFile(
    path.join(output, "reproductions", `${reproduction.invariantId}-${reproduction.seed}.json`),
    stableJson(reproduction),
  );
}
process.stdout.write(
  `${report.q1Engine} Q1/${report.stabilizationProgression}/${report.fullSystemReadiness} ${digest} artifacts/system-correctness/q1/q1-report.json\n`,
);
if (report.milestone2Implementation !== "PASS") process.exitCode = 1;
