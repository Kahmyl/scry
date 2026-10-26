import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EvidenceCipher } from "@scry/veil";
import {
  AdmittedEvidenceReader,
  ChronicleEvidenceService,
  EvidenceArtifactFailure,
} from "../src/index.js";
import { memoryAdmission } from "./fixtures/evidence-admission.js";

async function captured() {
  const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-availability-"));
  const control = memoryAdmission();
  const scope = {
    root,
    admission: control.admission,
    runId: control.stream.runId,
    sessionId: control.stream.sessionId,
    protection: new EvidenceCipher(randomBytes(32)),
    maxSessionBytes: 1024 * 1024,
  };
  const renderer = {
    render: vi.fn(async () => ({ replayFailed: true, networkRequests: 0, visibleFrameCount: 0 })),
  };
  const service = new ChronicleEvidenceService(renderer);
  const capture = await service.openSession(scope);
  capture.createRecording({ snapshot: () => (v) => v }).receive('{"type":2,"timestamp":1000}');
  await capture.startCapture();
  await capture.prepareClosure();
  await capture.stopCapture({ browserStopped: true, recordingDrained: true });
  return { ...control, root, scope, renderer, service };
}
const options = { renderVideo: false, failureClosure: true, actionLedger: async () => [] };
describe("artifact availability never grants authority", () => {
  it("reads an empty receipt inventory without creating a filesystem directory or a writer", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "chronicle-read-only-"));
    const control = memoryAdmission();
    const open = vi.spyOn(control.admission, "openStream");
    const directory = path.join(parent, "never-created");
    const reader = new AdmittedEvidenceReader({
      directory,
      runId: control.stream.runId,
      scopeId: control.stream.sessionId,
      admission: control.admission,
      protection: new EvidenceCipher(randomBytes(32)),
    });
    expect((await reader.verify()).chunks).toBe(0);
    for (const method of ["append", "flush", "initialize"])
      expect(reader).not.toHaveProperty(method);
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(open).not.toHaveBeenCalled();
  });
  it("retains verified capture references and labels a derived video failure in the exact manifest", async () => {
    const f = await captured();
    const closure = await f.service.openSession({ ...f.scope, purpose: "closure" });
    const completion = await closure.seal({ ...options, renderVideo: true });
    expect(completion).toMatchObject({
      state: "incomplete",
      issue: "video_unavailable",
      chainHead: f.stream.chainHead,
    });
    expect(completion.videoObjectKey).toBeUndefined();
    const manifest = JSON.parse(
      await readFile(completion.replayObjectKey!.slice("local://".length), "utf8"),
    );
    expect(manifest).toMatchObject({
      state: "incomplete",
      issue: "video_unavailable",
      chunks: f.stream.chunks,
    });
    expect(() => closure.createRecording({ snapshot: () => (v) => v })).toThrow("CAPTURE_CLOSED");
    await expect(closure.startCapture()).rejects.toThrow("CAPTURE_CLOSED");
  });
  it("never acknowledges an artifact issue when the owner is lost before fallback checkpoint", async () => {
    const f = await captured();
    const filename = path.join(f.root, "evidence", f.stream.chunks[0]!.objectKey);
    await rename(filename, `${filename}.fixture-held`);
    const closure = await f.service.openSession({ ...f.scope, purpose: "closure" });
    const original = f.admission.checkpoint;
    let calls = 0;
    vi.spyOn(f.admission, "checkpoint").mockImplementation(async () => {
      if (++calls === 2) f.revoke();
      await original();
    });
    await expect(closure.seal(options)).rejects.toThrow("OWNER_FENCED");
  });
  it.each(["database_unavailable", "SCRY_BROWSER_COMMAND_CANCELLED", "SCRY_BROWSER_OWNER_FENCED"])(
    "does not convert %s from a non-artifact capability into unavailable evidence",
    async (code) => {
      const f = await captured();
      const closure = await f.service.openSession({ ...f.scope, purpose: "closure" });
      vi.spyOn(f.admission, "readStream").mockRejectedValueOnce(new Error(code));
      await expect(closure.seal(options)).rejects.toThrow(code);
      expect(f.renderer.render).not.toHaveBeenCalled();
    },
  );
  it("refuses a normal required video rather than silently dropping it", async () => {
    const f = await captured();
    const closure = await f.service.openSession({ ...f.scope, purpose: "closure" });
    await expect(
      closure.seal({ ...options, failureClosure: false, renderVideo: true }),
    ).rejects.toMatchObject({
      name: "EvidenceArtifactFailure",
      issue: "video_unavailable",
    });
  });
  it("does not classify an unknown renderer/control exception as an artifact failure", async () => {
    const f = await captured();
    const closure = await f.service.openSession({ ...f.scope, purpose: "closure" });
    f.renderer.render.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED"),
    );
    await expect(closure.seal({ ...options, renderVideo: true })).rejects.toThrow(
      "PROCESS_TERMINATION_UNCONFIRMED",
    );
  });
  it("keeps artifact errors finite without embedding private paths or underlying driver values", () => {
    const error = new EvidenceArtifactFailure("content_unverifiable");
    expect(error.message).toBe("SCRY_BROWSER_EVIDENCE_ARTIFACT_UNAVAILABLE");
    expect(error.issue).toBe("content_unverifiable");
    expect(error).not.toHaveProperty("cause");
  });
});
