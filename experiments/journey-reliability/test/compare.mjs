// Host orchestrator: serial, bounded Docker probes; never modifies the live stack.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const checkout = process.cwd(),
  artifacts = process.env.SCRY_LAB_RESULTS;
if (!artifacts) throw Error("Explicit results directory required");
const root = path.join(artifacts, "journey-comparison-" + Date.now());
await mkdir(root, { recursive: true, mode: 0o700 });
const rows = [];
for (const [n, mode] of ["raw", "raw", "source", "source", "source"].entries()) {
  const args = [
    "run",
    "--rm",
    "--name",
    "scry-journey-comparison",
    "--network",
    "scry-ten-app-architecture",
    "--memory",
    "1g",
    "--shm-size",
    "256m",
    "-e",
    "SCRY_LAB_HOVER_RESET=" + mode,
    "--mount",
    "type=bind,source=" + checkout + "/experiments,target=/experiments,readonly",
    "--mount",
    "type=bind,source=" + artifacts + ",target=/results",
    "--entrypoint",
    "node",
    "scry-decisive-interaction:lab",
    "/experiments/journey-reliability/test/capability-recovery.mjs",
  ];
  const started = Date.now();
  let row = { number: n + 1, mode };
  try {
    const stdout = execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 2 * 1024 * 1024,
    });
    await writeFile(root + "/trial-" + (n + 1) + ".jsonl", stdout, { mode: 0o600 });
    row = {
      ...row,
      ...JSON.parse(stdout.trim().split("\n").at(-1)),
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    row.error = e.message;
    row.elapsedMs = Date.now() - started;
  }
  rows.push(row);
  await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(row));
}
console.log(
  JSON.stringify({
    root,
    complete: rows.length === 5,
    candidatePassed: rows.filter((r) => r.mode === "source").every((r) => r.failed?.length === 0),
    rawFailureReproduced: rows
      .filter((r) => r.mode === "raw")
      .every((r) => r.failed?.includes("native_drag")),
  }),
);
