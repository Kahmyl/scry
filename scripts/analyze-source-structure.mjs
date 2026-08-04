import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["apps", "packages"];
const extensions = new Set([".ts", ".tsx", ".mjs"]);
const excludedSegments = new Set(["node_modules", "dist", "coverage", "test", "tests", "scripts"]);
const records = [];

for (const root of roots) await visit(root);
records.sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file));

const classified = records
  .filter(({ lines }) => lines >= 350)
  .map((record) => ({
    ...record,
    severity: record.lines >= 800 ? "critical" : record.lines >= 500 ? "major" : "review",
  }));

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      policy: {
        scope: "formatted production TypeScript/TSX/MJS",
        reviewAt: 350,
        majorAt: 500,
        criticalAt: 800,
        note: "Line count is a discovery signal; decomposition decisions remain responsibility-based.",
      },
      counts: {
        productionFiles: records.length,
        review: classified.filter(({ severity }) => severity === "review").length,
        major: classified.filter(({ severity }) => severity === "major").length,
        critical: classified.filter(({ severity }) => severity === "critical").length,
      },
      files: classified,
    },
    null,
    2,
  )}\n`,
);

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedSegments.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (extensions.has(path.extname(entry.name))) {
      const source = await readFile(file, "utf8");
      records.push({ file, lines: source.split(/\r?\n/).length });
    }
  }
}
