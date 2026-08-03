import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const [outputPath, ...command] = process.argv.slice(2);
if (!outputPath || command.length === 0) throw new Error("usage: capture-readiness-report.mjs OUTPUT COMMAND [ARGS...]");
const startedAt = new Date().toISOString();
const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", env: process.env, maxBuffer: 128 * 1024 * 1024 });
const completedAt = new Date().toISOString();
const stdout = result.stdout ?? "";
function extractJsonObjects(value) {
  const objects = [];
  for (let start = value.indexOf("{"); start >= 0; start = value.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        const source = value.slice(start, index + 1);
        try {
          objects.push({ source, value: JSON.parse(source) });
        } catch {}
        break;
      }
    }
  }
  return objects;
}
const reports = extractJsonObjects(stdout).sort((left, right) => right.source.length - left.source.length);
if (result.status !== 0 || reports.length === 0) {
  process.stderr.write(result.stderr ?? "");
  throw new Error(`campaign failed or produced no JSON: ${command.join(" ")} (exit ${result.status})`);
}
const report = reports[0].value;
const serializedReport = JSON.stringify(report);
const envelope = {
  schemaVersion: 1,
  command,
  startedAt,
  completedAt,
  durationMs: Date.parse(completedAt) - Date.parse(startedAt),
  exitCode: result.status,
  reportSha256: createHash("sha256").update(serializedReport).digest("hex"),
  report
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${outputPath} ${envelope.reportSha256}\n`);
