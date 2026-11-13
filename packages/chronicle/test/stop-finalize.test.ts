import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceCipher } from "@scry/veil";
import {
  AdmittedEvidenceReader,
  ChronicleEvidenceService,
  EvidenceArtifactFailure,
} from "../src/index.js";
import { memoryAdmission } from "./fixtures/evidence-admission.js";

const seal = { renderVideo: false, failureClosure: true, actionLedger: async () => [] };
const stopped = { browserStopped: true, recordingDrained: true } as const;
async function activeCapture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-stop-finalize-"));
  const control = memoryAdmission();
  const scope = {
    root,
    admission: control.admission,
    runId: control.stream.runId,
    sessionId: control.stream.sessionId,
    protection: new EvidenceCipher(randomBytes(32)),
    maxSessionBytes: 1024 * 1024,
  };
  const renderer = { render: vi.fn() };
  const service = new ChronicleEvidenceService(renderer);
  const session = await service.openSession(scope);
  const recording = session.createRecording({ snapshot: () => (v) => v });
  await session.startCapture();
  recording.receive('{"type":2,"timestamp":1000}');
  await session.prepareClosure();
  const filename = path.join(root, "evidence", control.stream.chunks[0]!.objectKey);
  return { ...control, scope, service, session, recording, filename, renderer };
}

afterEach(() => vi.restoreAllMocks());
describe("stopped capture is independent of stored artifact availability", () => {
  it.each(["missing", "tampered"] as const)(
    "records a truthful stop and fails closed with %s pre-stop evidence",
    async (mode) => {
      const f = await activeCapture();
      const before = structuredClone(f.stream);
      if (mode === "missing") await rename(f.filename, `${f.filename}.fixture-held`);
      else
        await writeFile(f.filename, Buffer.concat([await readFile(f.filename), Buffer.from(" ")]));
      await expect(f.session.stopCapture(stopped)).resolves.toBeUndefined();
      expect(f.stream).toMatchObject({
        captureStoppedAt: expect.any(String),
        captureComplete: false,
        chainHead: before.chainHead,
        chunkCount: before.chunkCount,
        totalBytes: before.totalBytes,
        chunks: before.chunks,
      });
      const completion = await f.session.seal(seal);
      expect(completion).toEqual({
        sessionId: f.stream.sessionId,
        runId: f.stream.runId,
        state: "incomplete",
        chainHead: before.chainHead,
        chunkCount: before.chunkCount,
        totalBytes: before.totalBytes,
        issue: mode === "missing" ? "object_unavailable" : "integrity_mismatch",
      });
      expect(await f.session.seal(seal)).toEqual(completion);
      const recovered = await f.service.openSession({ ...f.scope, purpose: "closure" });
      expect(await recovered.seal(seal)).toEqual(completion);
      expect(f.renderer.render).not.toHaveBeenCalled();
    },
  );
  it("does not turn normal closure into success when pre-stop content is missing", async () => {
    const f = await activeCapture();
    await rename(f.filename, `${f.filename}.fixture-held`);
    await f.session.stopCapture(stopped);
    await expect(f.session.seal({ ...seal, failureClosure: false })).rejects.toMatchObject({
      issue: "object_unavailable",
    });
    expect(f.stream.captureComplete).toBe(false);
  });
  it("does not upgrade an incomplete stop when an unavailable file returns", async () => {
    const f = await activeCapture();
    await rename(f.filename, `${f.filename}.fixture-held`);
    await f.session.stopCapture(stopped);
    await rename(`${f.filename}.fixture-held`, f.filename);
    expect(await f.session.seal(seal)).toMatchObject({ state: "incomplete" });
    expect(f.stream.captureComplete).toBe(false);
  });
  it("keeps healthy capture complete", async () => {
    const f = await activeCapture();
    await f.session.stopCapture(stopped);
    expect(f.stream.captureComplete).toBe(true);
    expect(await f.session.seal(seal)).toMatchObject({ state: "complete", chunkCount: 1 });
  });
  it("does not let unavailable native recovery block a truthful incomplete stop", async () => {
    const f = await activeCapture();
    await rename(f.filename, `${f.filename}.fixture-held`);
    const native = {
      directory: path.join(f.scope.root, "native"),
      admitStill: vi.fn(),
      reserveCaptureV2: vi.fn(),
      maskingUnavailable: vi.fn(),
      recordError: vi.fn(),
      flush: () => f.recording.flush(),
      abort: () => f.recording.abort(),
    };
    expect(await f.session.recoverNativeCaptures(native)).toEqual({ admitted: 0 });
    expect(native.admitStill).not.toHaveBeenCalled();
    expect(f.stream.captureStoppedAt).toBeNull();
    await f.session.stopCapture({ ...stopped, recordingComplete: false });
    expect(await f.session.seal(seal)).toMatchObject({
      state: "incomplete",
      issue: "object_unavailable",
    });
  });
  it.each(["database_unavailable", "SCRY_BROWSER_OWNER_FENCED", "evidence_receipt_invalid"])(
    "does not turn native recovery %s into no recovered files",
    async (code) => {
      const f = await activeCapture();
      const native = {
        directory: path.join(f.scope.root, "native"),
        admitStill: vi.fn(),
        reserveCaptureV2: vi.fn(),
        maskingUnavailable: vi.fn(),
        recordError: vi.fn(),
        flush: () => f.recording.flush(),
        abort: () => f.recording.abort(),
      };
      vi.spyOn(AdmittedEvidenceReader.prototype, "verify").mockRejectedValueOnce(new Error(code));
      await expect(f.session.recoverNativeCaptures(native)).rejects.toThrow(code);
      expect(native.admitStill).not.toHaveBeenCalled();
    },
  );
  it("does not report no native recovery after unavailable content loses ownership", async () => {
    const f = await activeCapture();
    const native = {
      directory: path.join(f.scope.root, "native"),
      admitStill: vi.fn(),
      reserveCaptureV2: vi.fn(),
      maskingUnavailable: vi.fn(),
      recordError: vi.fn(),
      flush: () => f.recording.flush(),
      abort: () => f.recording.abort(),
    };
    vi.spyOn(AdmittedEvidenceReader.prototype, "verify").mockImplementationOnce(async () => {
      f.revoke();
      throw new EvidenceArtifactFailure("object_unavailable");
    });
    await expect(f.session.recoverNativeCaptures(native)).rejects.toThrow("OWNER_FENCED");
    expect(native.admitStill).not.toHaveBeenCalled();
  });
  it.each([
    "database_unavailable",
    "SCRY_BROWSER_OWNER_FENCED",
    "SCRY_BROWSER_COMMAND_CANCELLED",
    "evidence_receipt_invalid",
  ])("does not record stop when verification raises non-artifact %s", async (code) => {
    const f = await activeCapture();
    const stop = vi.spyOn(f.admission, "stopCapture");
    vi.spyOn(AdmittedEvidenceReader.prototype, "verify").mockRejectedValueOnce(new Error(code));
    await expect(f.session.stopCapture(stopped)).rejects.toThrow(code);
    expect(stop).not.toHaveBeenCalled();
    expect(f.stream.captureStoppedAt).toBeNull();
  });
  it("requires ownership even when verifying artifacts lost the owner", async () => {
    const f = await activeCapture();
    vi.spyOn(AdmittedEvidenceReader.prototype, "verify").mockImplementationOnce(async () => {
      f.revoke();
      throw new EvidenceArtifactFailure("object_unavailable");
    });
    await expect(f.session.stopCapture(stopped)).rejects.toThrow("OWNER_FENCED");
    expect(f.stream.captureStoppedAt).toBeNull();
  });
  it("does not suppress admission failure after observing unavailable content", async () => {
    const f = await activeCapture();
    await rename(f.filename, `${f.filename}.fixture-held`);
    vi.spyOn(f.admission, "stopCapture").mockRejectedValueOnce(new Error("database_unavailable"));
    await expect(f.session.stopCapture(stopped)).rejects.toThrow("database_unavailable");
    expect(f.stream.captureStoppedAt).toBeNull();
  });
  it("does not suppress a failed recorder drain as an unavailable stored file", async () => {
    const f = await activeCapture();
    const stop = vi.spyOn(f.admission, "stopCapture");
    vi.spyOn(f.recording, "flush").mockRejectedValueOnce(
      new EvidenceArtifactFailure("object_unavailable"),
    );
    await expect(f.session.stopCapture(stopped)).rejects.toMatchObject({
      issue: "object_unavailable",
    });
    expect(stop).not.toHaveBeenCalled();
  });
  it("still requires a confirmed stop before failure sealing unavailable content", async () => {
    const f = await activeCapture();
    await rename(f.filename, `${f.filename}.fixture-held`);
    await expect(f.session.seal(seal)).rejects.toThrow("STOP_UNCONFIRMED");
    expect(f.stream.captureStoppedAt).toBeNull();
  });
});
