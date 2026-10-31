import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SupervisedBrowser } from "../../../packages/praxis/src/supervised-browser.ts";
const root = "/results/custody-probe-" + Date.now();
await mkdir(root, { recursive: true });
const capture = await mkdtemp(path.join(tmpdir(), "scry-custody-probe-"));
let owned,
  unconfirmed = 0;
const started = performance.now();
const result = { captureRequested: process.env.SCRY_PROBE_CAPTURE === "1" };
try {
  owned = await SupervisedBrowser.launch({
    runtime: "playwright_mcp",
    headless: !result.captureRequested,
    ...(result.captureRequested ? { captureDirectory: capture } : {}),
    sampleAuthority: () => ({
      owner: { revision: 0, remainingMs: 60000 },
      command: { state: "idle", sequence: 0 },
    }),
    onUnconfirmedStop: () => {
      unconfirmed++;
    },
  });
  result.launchMs = performance.now() - started;
  result.privateDisplayAvailable = !!owned.privateDisplay();
  await owned.completeSetup();
  result.setup = true;
  await new Promise((r) => setTimeout(r, 500));
  result.receipt = await owned.close();
  result.passed = true;
} catch (e) {
  result.passed = false;
  result.error = e.message;
  process.exitCode = 1;
} finally {
  result.unconfirmed = unconfirmed;
  result.elapsedMs = performance.now() - started;
  await writeFile(root + "/result.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ root, ...result }));
}
