import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChronicleReplayPlan, ChronicleReplayRendererPort } from "@scry/contracts";
import { EvidenceCipher } from "@scry/veil";
import {
  AuthenticatedEvidenceStore,
  ChronicleEvidenceService,
  ChronicleRecording,
  renderSanitizedReplay,
} from "../src/index.js";

const scope = () => ({
  admission: { run: <T>(work: () => Promise<T>) => work() },
  runId: "00000000-0000-4000-8000-000000000301",
  sessionId: "fixture-session",
  protection: new EvidenceCipher(randomBytes(32)),
  maxSessionBytes: 1024 * 1024,
});
const passthrough = { snapshot: () => (value: unknown) => value };
const unusedRenderer = { render: vi.fn<ChronicleReplayRendererPort["render"]>() };

const admission = { run: <T>(work: () => Promise<T>) => work() };

describe("recording custody and closure", () => {
  it("snapshots protection at receipt and serializes asynchronous append operations", async () => {
    let quarantined = true;
    const events: unknown[] = [];
    const recording = new ChronicleRecording(
      {
        nextSequence: 0,
        async append(value) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          events.push(value);
          return events.length - 1;
        },
        async flush() {},
      },
      {
        snapshot() {
          const snapshot = quarantined;
          return (value) => (snapshot ? { masked: true } : value);
        },
      },
    );
    recording.receive('{"secret":"not-durable"}');
    quarantined = false;
    recording.receive('{"safe":"second"}');
    expect((await recording.flush()).receivedEvents).toBe(2);
    expect(events).toEqual([{ masked: true }, { safe: "second" }]);
  });

  it("preserves malformed payload and write failure diagnostics without stopping later events", async () => {
    const append = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValue(0);
    const recording = new ChronicleRecording(
      { nextSequence: 0, append, async flush() {} },
      passthrough,
    );
    recording.receive("{");
    recording.receive('{"safe":1}');
    recording.receive('{"safe":2}');
    recording.recordError("recorder_capture_failed", new Error("Session closed"));
    expect(await recording.flush()).toEqual({
      receivedEvents: 1,
      errors: [{ code: "recorder_payload_invalid" }, { code: "recorder_write_failed" }],
      diagnostics: [{ code: "owner_closed_during_capture" }],
    });
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("closes nonempty evidence with the unchanged stream summary and no rendering when disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-session-"));
    const sessionScope = scope();
    const session = await new ChronicleEvidenceService(unusedRenderer).openSession({
      ...sessionScope,
      root,
    });
    const recording = session.createRecording(passthrough);
    recording.receive('{"type":2,"timestamp":1000}');
    await session.prepareClosure();
    const ledger = vi.fn();
    const result = await session.seal({ renderVideo: false, actionLedger: ledger });
    expect(result).toMatchObject({
      sessionId: sessionScope.sessionId,
      runId: sessionScope.runId,
      chunkCount: 1,
      replayObjectKey: `local://${path.join(root, "evidence")}`,
    });
    expect(result.chainHead).toMatch(/^[a-f0-9]{64}$/);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("videoObjectKey");
    expect(ledger).not.toHaveBeenCalled();
    const resumed = await new AuthenticatedEvidenceStore({
      admission,
      directory: path.join(root, "evidence"),
      runId: sessionScope.runId,
      scopeId: sessionScope.sessionId,
      protection: sessionScope.protection,
    }).initialize();
    expect((await resumed.verify()).events).toEqual([{ type: 2, timestamp: 1000 }]);
  });

  it("rejects empty, recorder-failed, and partial evidence closure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-incomplete-"));
    const session = await new ChronicleEvidenceService(unusedRenderer).openSession({
      ...scope(),
      root,
    });
    const recording = session.createRecording(passthrough);
    await session.prepareClosure();
    await expect(
      session.seal({ renderVideo: false, actionLedger: async () => [] }),
    ).rejects.toThrow("SCRY_BROWSER_EVIDENCE_INCOMPLETE");
    recording.receive("{");
    await expect(session.prepareClosure()).rejects.toThrow(
      "SCRY_BROWSER_RECORDER_FAILED:recorder_payload_invalid",
    );
    const partial = await new ChronicleEvidenceService(unusedRenderer).openSession({
      ...scope(),
      root,
    });
    const partialRecording = partial.createRecording(passthrough);
    partialRecording.receive('{"type":2}');
    await partialRecording.flush();
    await writeFile(path.join(root, "evidence", "chunk-000001.json.partial-interrupted"), "{");
    await expect(
      partial.seal({ renderVideo: false, actionLedger: async () => [] }),
    ).rejects.toThrow("SCRY_BROWSER_EVIDENCE_INCOMPLETE");
  });
});

describe("replay publication", () => {
  for (const failure of ["execution", "invisible", "network", "video"])
    it(`does not publish a ${failure} failure and allows a clean retry`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-replay-"));
      let fail = true;
      const render = vi.fn(async (plan: ChronicleReplayPlan) => {
        const videoPath = path.join(plan.stagingDirectory, "fixture.webm");
        await writeFile(videoPath, "test-video");
        for (const [index] of plan.frames.entries())
          await writeFile(path.join(plan.framesDirectory, `frame-${index}.png`), "test-frame");
        return {
          ...(fail && failure === "video" ? {} : { videoPath }),
          replayFailed: fail && failure === "execution",
          visibleFrameCount: fail && failure === "invisible" ? 0 : plan.frames.length,
          networkRequests: fail && failure === "network" ? 1 : 0,
        };
      });
      const options = {
        admission: { run: <T>(work: () => Promise<T>) => work() },
        renderer: { render },
        events: [{ type: 2, timestamp: 1000 }],
        ledgerPath: path.join(root, "actions.jsonl"),
        outputDirectory: path.join(root, "rendered"),
      };
      await expect(renderSanitizedReplay(options)).rejects.toThrow(/replay_/);
      await expect(
        access(path.join(options.outputDirectory, "publication.json")),
      ).rejects.toThrow();
      fail = false;
      const result = await renderSanitizedReplay(options);
      expect(result.reusedPublication).toBe(false);
      expect(result.frameCount).toBeGreaterThanOrEqual(3);
      expect(
        JSON.parse(await readFile(path.join(options.outputDirectory, "publication.json"), "utf8"))
          .complete,
      ).toBe(true);
      expect((await renderSanitizedReplay(options)).reusedPublication).toBe(true);
      expect(render).toHaveBeenCalledTimes(2);
    });
});
