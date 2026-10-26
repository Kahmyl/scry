import { fileURLToPath as qualificationFilePath } from "node:url";
process.chdir(qualificationFilePath(new URL("../../../", import.meta.url)));
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("../../../", import.meta.url).pathname);
const image = "scry-boundary-runtime:qualification";

execFileSync("docker", ["build", "--target", "prod-deps", "-t", image, "."], {
  cwd: root,
  stdio: "inherit",
});

const mounts = [
  "packages/veil/src",
  "packages/chronicle/src",
  "packages/contracts/src",
  "packages/praxis/src",
  "apps/api/src",
  "apps/api/tsconfig.json",
].flatMap((relativePath) => [
  "--mount",
  `type=bind,src=${path.join(root, relativePath)},dst=/workspace/${relativePath},readonly`,
]);

const smoke = `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserProtectedValueCipher } from "./src/browser-execution/protected-value-cipher.ts";
import { BrowserRuntimeVeilReportProtection } from "./src/browser-execution/browser-boundary-composition.ts";
import { AuthenticatedEvidenceStore, ChronicleEvidenceService, ChronicleRepository } from "@scry/chronicle";
import { BrowserReplayRenderer } from "@scry/praxis";
import { EvidenceCipher, SensitiveValueClassifier, createRecordingProtection } from "@scry/veil";
process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
const cipher = new BrowserProtectedValueCipher();
const context = { projectId: "qualification", canonicalName: "credential" };
assert.equal(cipher.decrypt(cipher.encrypt("qualification-secret", context), context), "qualification-secret");
assert.equal(typeof new BrowserRuntimeVeilReportProtection().createReportSanitizer, "function");
assert.equal(typeof AuthenticatedEvidenceStore, "function");
assert.equal(typeof new ChronicleEvidenceService(new BrowserReplayRenderer()).openSession, "function");
assert.equal(typeof ChronicleRepository, "function");
const root = await mkdtemp(path.join(os.tmpdir(), "scry-boundary-smoke-"));
const protection = new EvidenceCipher(Buffer.alloc(32, 9));
// Import/dependency smoke port double only; actual SQL authority is qualified
// independently. This smoke cannot stand in for durability or recovery proof.
const stream = { id: "qualification-stream", sessionId: "qualification-session", runId: "qualification-run", custodyMode: "admitted", state: "open", writerGeneration: 1, chainHead: null, chunkCount: 0, totalBytes: 0, sealedAt: null, captureStartedAt: null, captureStoppedAt: null, captureComplete: null, interruptions: 0, chunks: [] };
const admission = { ownerGeneration: 1, assertActive() {}, async checkpoint() {},
  async openStream() { return structuredClone(stream); }, async readStream() { return structuredClone(stream); },
  async startCapture() { stream.captureStartedAt = new Date().toISOString(); },
  async stopCapture(receipt) { stream.captureStoppedAt = new Date().toISOString(); stream.captureComplete=receipt.recordingComplete; },
  async admitChunk(chunk) { assert.equal(chunk.chunkIndex,stream.chunkCount); stream.chunks.push(chunk); stream.chunkCount++; stream.chainHead=chunk.digest; stream.totalBytes+=chunk.storedBytes; } };
const evidence = await new ChronicleEvidenceService(new BrowserReplayRenderer()).openSession({ admission, root, runId: "qualification-run", sessionId: "qualification-session", protection, maxSessionBytes: 1024 * 1024 });
await evidence.startCapture();
const recording = evidence.createRecording(createRecordingProtection({ classifier: new SensitiveValueClassifier({ protectedValues: { credential: "qualification-secret" } }) }));
recording.receive(JSON.stringify({ text: "qualification-secret", timestamp: 1000 }));
await evidence.prepareClosure();
await evidence.stopCapture({ browserStopped: true, recordingDrained: true });
const sealed = await evidence.seal({ renderVideo: false, actionLedger: async () => [] });
assert.equal(sealed.chunkCount, 1);
assert.equal(sealed.state, "complete");
const reopened = await new AuthenticatedEvidenceStore({ admission, directory: path.join(root, "evidence"), runId: "qualification-run", scopeId: "qualification-session", protection }).initialize();
assert.equal(JSON.stringify((await reopened.verify()).events).includes("qualification-secret"), false);
for (const dependency of ["@aws-sdk/client-s3", "@google-cloud/storage", "cloudinary", "@scry/veil", "playwright"])
  assert.equal(existsSync("/workspace/packages/chronicle/node_modules/" + dependency), false);
assert.equal(existsSync("/workspace/node_modules/typescript"), false);
assert.equal(existsSync("/workspace/packages/assurance"), false);
console.log("BOUNDARY_PRODUCTION_IMPORTS_PASS");
`;

const output = execFileSync(
  "docker",
  [
    "run",
    "--rm",
    ...mounts,
    "--workdir",
    "/workspace/apps/api",
    image,
    "node",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    smoke,
  ],
  { cwd: root, encoding: "utf8", timeout: 30_000 },
);
if (!output.includes("BOUNDARY_PRODUCTION_IMPORTS_PASS"))
  throw new Error("Boundary production import assertions did not execute");
process.stdout.write(
  "Veil, Chronicle, browser adapters, and production dependencies verified without development tools or Assurance.\n",
);
