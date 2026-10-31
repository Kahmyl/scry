// A reproducible serial regression batch, not production qualification. Method
// choices are explicit test inputs; the runtime contains no per-app dispatch.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { privateBrowser } from "./decisive-runtime.mjs";
const root = "/results/decisive-final-batch-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const source = await readFile(new URL("./decisive-runtime.mjs", import.meta.url)),
  runtimeHash = createHash("sha256").update(source).digest("hex");
await writeFile(root + "/runtime-source.mjs", source, { mode: 0o600 });
const plans = [
  ["decisive-training.mjs", { SCRY_DECISIVE_STRATEGY: "native-control-scope" }],
  [
    "decisive-rich-regressions.mjs",
    { SCRY_DECISIVE_APPS: "wordpress", SCRY_DECISIVE_STRATEGY: "native-control-keyboard" },
  ],
  [
    "decisive-rich-regressions.mjs",
    { SCRY_DECISIVE_APPS: "hedgedoc", SCRY_DECISIVE_STRATEGY: "native-control-scope" },
  ],
  ["decisive-etherpad-comparison.mjs", { SCRY_DECISIVE_STRATEGIES: "native-control-keyboard" }],
  ["decisive-postconditions.mjs", { SCRY_DECISIVE_STRATEGY: "native-control-keyboard" }],
  ["decisive-nodered-audit.mjs", {}],
];
const jobs = [];
for (const [file, env] of plans) {
  const child = spawnSync(process.execPath, [new URL(file, import.meta.url).pathname], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(child.stdout ?? "");
  const job = {
    file,
    env,
    exit: child.status,
    error: child.error?.message,
    stderr: child.stderr?.slice(-3000),
  };
  jobs.push(job);
  await writeFile(root + "/jobs.json", JSON.stringify({ root, runtimeHash, jobs }, null, 2), {
    mode: 0o600,
  });
  if (child.error || child.status !== 0) throw Error("Isolated job failed: " + file);
}
const a = await privateBrowser(),
  b = await privateBrowser();
let clipboardIsolation;
try {
  await a.clipboard.write("display-A");
  await b.clipboard.write("display-B");
  clipboardIsolation = {
    distinctDisplays: a.display !== b.display,
    passed:
      (await a.clipboard.read()) === "display-A" && (await b.clipboard.read()) === "display-B",
  };
} finally {
  await a.close();
  await b.close();
}
await writeFile(
  root + "/results.json",
  JSON.stringify({ root, runtimeHash, jobs, clipboardIsolation }, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify({ root, runtimeHash, clipboardIsolation }));
