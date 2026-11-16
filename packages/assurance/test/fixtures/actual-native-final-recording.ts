import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  AdapterWorker,
  BrowserReplayRenderer,
  PraxisMcpBrowserEngine,
  SupervisedBrowser,
} from "@scry/praxis";
import { ChronicleEvidenceService, readNativeEvidence, readNativeMedia } from "@scry/chronicle";
import { EvidenceCipher } from "@scry/veil";
import type { NativeCaptureSample } from "@scry/contracts";
import { recordingAdmission } from "./evidence-admission.js";

export async function actualNativeFinalRecording(
  mode: "normal" | "delayed-public" | "stuck-public" | "delayed-known",
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scry-final-custody-"));
  const runId = "00000000-0000-4000-8000-000000000204";
  const admission = recordingAdmission("final-custody-fixture", runId);
  const cipher = new EvidenceCipher(randomBytes(32));
  const evidence = await new ChronicleEvidenceService(new BrowserReplayRenderer()).openSession({
    root,
    runId,
    sessionId: "final-custody-fixture",
    protection: cipher,
    admission,
    maxSessionBytes: 5 * 1024 * 1024,
  });
  const native = await evidence.createNativeRecording();
  await evidence.startCapture();
  const capture = await native.reserveCaptureV2({ kind: "display", policyGeneration: 1 });
  const order: string[] = [];
  const finalReads: Array<{ ordinal: number; sameChallenge: boolean; read: number }> = [];
  let physicalConfirmed = false;
  let finalSample: NativeCaptureSample | undefined;
  const physicalStopped = capture.physicalStopped.bind(capture);
  capture.physicalStopped = async (receipt) => {
    assert.equal(physicalConfirmed, true);
    order.push("physical-proof");
    return physicalStopped(receipt);
  };
  const graphSample = capture.graphSample.bind(capture);
  capture.graphSample = async (event) => {
    if (event.sample.finalReadChallenge) {
      finalSample = event.sample;
      order.push("final-sample");
    }
    return graphSample(event);
  };
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<h1>Public account settings</h1><p>Ordinary fixture content.</p>${
        mode === "delayed-known"
          ? '<label>Password<input type="password" value="fictional-recording-secret"></label>'
          : ""
      }`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let custody: SupervisedBrowser | undefined;
  let worker: AdapterWorker | undefined;
  try {
    custody = await SupervisedBrowser.launch({
      runtime: "playwright_mcp",
      headless: false,
      captureDirectory: capture.directory,
      sampleAuthority: () => ({
        owner: { revision: 1, remainingMs: 60000 },
        command: { state: "idle", sequence: 0 },
      }),
    });
    const stopCapture = custody.stopCapture.bind(custody);
    custody.stopCapture = async () => {
      const receipt = await stopCapture();
      assert.notEqual(receipt.coverage, "unavailable");
      physicalConfirmed = true;
      order.push("encoder-stopped");
      return receipt;
    };
    const output = path.join(root, "worker");
    await mkdir(output);
    worker = new AdapterWorker(
      output,
      new URL("./final-recording-worker.ts", import.meta.url).href,
      () => {},
      () => {},
      (event) =>
        event.type === "capture_sample"
          ? capture.graphSample({
              sequence: event.sequence as number,
              sample: event.sample as NativeCaptureSample,
            })
          : capture.graphGap({
              sequence: event.sequence as number,
              reason: event.reason as any,
            }),
    );
    worker.child.on("message", (value: any) => {
      if (value.type === "fixture_final_read") {
        order.push("fresh-final-read");
        finalReads.push(value);
      }
    });
    await worker.call({
      type: "init",
      endpoint: custody.endpoint(),
      display: custody.privateDisplay(),
      secrets: { FIXTURE_MODE: mode, PASSWORD: "fictional-recording-secret" },
      output,
      captureEpoch: capture.epoch,
    });
    await custody.completeSetup();
    await worker.call({ type: "call", tool: "browser_navigate", args: { url } });
    await worker.call({ type: "call", tool: "browser_snapshot", args: {} });
    const engine = new PraxisMcpBrowserEngine({} as any, {} as any, {} as any, {} as any, root);
    const cell = {
      capture,
      worker,
      lease: admission,
      forceStopRequested: false,
      recordingAssessment: undefined as unknown,
    };
    // Exercise the production caller: real custodian stop -> Chronicle's
    // physical challenge -> real worker measurement -> graph close -> seal.
    await (engine as any).finalizeCapture(cell, custody);
    assert.ok(order.indexOf("encoder-stopped") < order.indexOf("physical-proof"));
    assert.ok(order.indexOf("physical-proof") < order.indexOf("fresh-final-read"));
    assert.ok(finalReads.every((read) => read.sameChallenge));
    assert.equal(finalReads.length, mode === "delayed-public" ? 2 : 1);
    assert.equal(typeof finalSample?.finalReadChallenge, "string");
    const available = mode === "normal" || mode === "delayed-public";
    assert.equal(
      (cell.recordingAssessment as { state: string }).state,
      available ? "best_effort_assessed" : "withheld",
    );
    if (mode === "delayed-known")
      assert.equal(finalSample?.observedRequiredGap, "native_protection_refresh_incomplete");
    const recovery = await evidence.recoverNativeCaptures(native);
    assert.equal(recovery.admitted, available ? 1 : 0);
    await worker.stop();
    const released = await custody.close();
    assert.equal(released.exitConfirmed, true);
    await evidence.stopCapture({ browserStopped: true, recordingDrained: true });
    await evidence.seal({ renderVideo: true, actionLedger: async () => [] });
    const inventory = await readNativeEvidence({
      root,
      protection: cipher,
      snapshot: { ...(await admission.readStream()), sealedAt: new Date().toISOString() },
    });
    const videos = inventory.filter((item) => item.kind === "video");
    assert.equal(videos.length, available ? 1 : 0);
    if (available) assert.ok((await readNativeMedia(root, videos[0]!)).length > 1000);
    return {
      mode,
      finalReads: finalReads.length,
      sameChallenge: finalReads.every((read) => read.sameChallenge),
      physicalConfirmed,
      assessment: cell.recordingAssessment,
      admitted: recovery.admitted,
      videos: videos.length,
      exitConfirmed: released.exitConfirmed,
      order,
    };
  } finally {
    await worker?.stop().catch(() => {});
    await custody?.terminate().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
