import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = "docs/architecture/evidence";
const files = [];
const walk = (directory) => {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(root);
const entries = files.map((path) => ({ path: relative(".", path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
const manifest = entries.map(({ path, sha256 }) => `${path}\0${sha256}\n`).join("");
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, algorithm: "sorted-path-NUL-sha256-v1", evidenceDirectory: root, entries, digest: createHash("sha256").update(manifest).digest("hex") }, null, 2)}\n`);
