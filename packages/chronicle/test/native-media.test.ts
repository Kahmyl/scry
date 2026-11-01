import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, symlink, unlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChronicleEvidenceService } from "../src/evidence-session.js";
import { readNativeMedia, readNativeEvidence } from "../src/native-media.js";
import { memoryAdmission } from "./fixtures/evidence-admission.js";
import { EvidenceCipher } from "@scry/veil";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-native-"));
  const { admission, revoke, stream } = memoryAdmission();
  const protection = new EvidenceCipher(randomBytes(32));
  const evidence = await new ChronicleEvidenceService({
    render: async () => {
      throw new Error("DOM renderer must not run for native media");
    },
  }).openSession({
    root,
    runId: stream.runId,
    sessionId: stream.sessionId,
    protection,
    admission,
    maxSessionBytes: 1024 * 1024,
  });
  const native = await evidence.createNativeRecording();
  await evidence.startCapture();
  const filename = `${randomUUID()}.png`;
  await writeFile(path.join(native.directory, filename), randomBytes(64));
  const input = { filename, kind: "screenshot" as const, timestamp: Date.now(), label: "initial" };
  const readMedia = () =>
    readNativeEvidence({
      root,
      protection,
      snapshot: { ...structuredClone(stream), sealedAt: new Date().toISOString() },
    });
  return { root, admission, evidence, native, input, revoke, readMedia };
}
describe("native media custody", () => {
  it("retains bounded user-facing evidence descriptions in admitted receipts", async () => {
    const f = await fixture();
    await f.native.admit({
      ...f.input,
      title: "Saved project document",
      description: "The note after saving and reopening.",
    });
    await f.evidence.stopCapture({ browserStopped: true, recordingDrained: true });
    await f.evidence.seal({ renderVideo: false, actionLedger: async () => [] });
    expect(await f.readMedia()).toMatchObject([
      { title: "Saved project document", description: "The note after saving and reopening." },
    ]);
  });
  it.each([
    { title: "x".repeat(201) },
    { title: "bad\u0000title" },
    { interruptionReason: "arbitrary internal details" },
  ])("rejects malformed native presentation %#", async (invalid) => {
    const f = await fixture();
    await expect(f.native.admit({ ...f.input, ...invalid })).rejects.toThrow("receipt_invalid");
    expect(await f.readMedia()).toEqual([]);
  });
  it("publishes only admitted native receipts and deduplicates identical screenshots", async () => {
    const f = await fixture();
    await f.native.admit(f.input);
    const duplicate = `${randomUUID()}.png`;
    const bytes = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(f.native.directory, f.input.filename)),
    );
    await writeFile(path.join(f.native.directory, duplicate), bytes);
    await f.native.admit({ ...f.input, filename: duplicate });
    await expect(stat(path.join(f.native.directory, duplicate))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(path.join(f.native.directory, `${randomUUID()}.png`), randomBytes(64)); // orphan
    await f.evidence.stopCapture({ browserStopped: true, recordingDrained: true });
    const result = await f.evidence.seal({ renderVideo: true, actionLedger: async () => [] });
    expect(result.state).toBe("complete");
    const media = await f.readMedia();
    expect(media).toHaveLength(1);
    expect(await readNativeMedia(f.root, media[0]!)).toEqual(bytes);
  });
  it("refuses stale-owner admission rather than promoting an orphan file", async () => {
    const f = await fixture();
    f.revoke();
    await expect(f.native.admit(f.input)).rejects.toThrow("OWNER_FENCED");
  });
  it("admits a native MP4 only from a pre-capture reservation and preserves partial coverage", async () => {
    const f = await fixture();
    const capture = await f.native.reserveCapture!();
    await writeFile(path.join(capture, "recording.mp4"), randomBytes(128));
    await writeFile(
      path.join(capture, "recording.json"),
      JSON.stringify({
        started: Date.now(),
        duration: "1.25",
        coverage: "partial",
        reason: "recording_capacity",
      }),
    );
    expect(await f.evidence.recoverNativeCaptures!(f.native)).toBe(1);
    // Repeating recovery cannot duplicate an already admitted video.
    expect(await f.evidence.recoverNativeCaptures!(f.native)).toBe(1);
    await f.evidence.stopCapture({ browserStopped: true, recordingDrained: true });
    const closed = await f.evidence.seal({ renderVideo: false, actionLedger: async () => [] });
    expect(closed.state).toBe("incomplete");
    const media = await f.readMedia();
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      kind: "video",
      coverage: "partial",
      durationMs: 1250,
      interruptionReason: "recording_capacity",
    });
    expect(media[0]!.objectKey).toMatch(/\.mp4$/u);
  });
  it("does not promote a recording from an unreserved directory", async () => {
    const f = await fixture();
    await writeFile(path.join(f.native.directory, "recording.mp4"), randomBytes(128));
    await writeFile(
      path.join(f.native.directory, "recording.json"),
      JSON.stringify({ started: Date.now(), duration: "1", coverage: "complete" }),
    );
    expect(await f.evidence.recoverNativeCaptures!(f.native)).toBe(0);
    expect(await f.readMedia()).toHaveLength(0);
  });
  it("detects changed native bytes at read time", async () => {
    const f = await fixture();
    await f.native.admit(f.input);
    await f.evidence.stopCapture({ browserStopped: true, recordingDrained: true });
    const result = await f.evidence.seal({ renderVideo: false, actionLedger: async () => [] });
    const media = await f.readMedia();
    await writeFile(path.join(f.native.directory, f.input.filename), randomBytes(64));
    await expect(readNativeMedia(f.root, media[0]!)).rejects.toMatchObject({
      issue: "integrity_mismatch",
    });
  });
  it.each(["missing", "changed"] as const)(
    "preserves unavailable failure closure for %s admitted native media",
    async (kind) => {
      const f = await fixture();
      await f.native.admit(f.input);
      await f.evidence.stopCapture({ browserStopped: true, recordingDrained: true });
      const file = path.join(f.native.directory, f.input.filename);
      if (kind === "missing") await unlink(file);
      else await writeFile(file, randomBytes(64));
      const result = await f.evidence.seal({
        renderVideo: false,
        failureClosure: true,
        actionLedger: async () => [],
      });
      expect(result).toMatchObject({
        state: "incomplete",
        issue: kind === "missing" ? "object_unavailable" : "integrity_mismatch",
        chunkCount: 1,
      });
    },
  );
  it("ignores a substituted filesystem manifest and reads only database-admitted media receipts", async () => {
    const f = await fixture();
    await f.native.admit(f.input);
    await f.evidence.stopCapture({ browserStopped: true, recordingDrained: true });
    const result = await f.evidence.seal({ renderVideo: false, actionLedger: async () => [] });
    const original = await f.readMedia();
    await writeFile(
      result.replayObjectKey!.slice(8),
      JSON.stringify({
        media: [
          {
            ...original[0],
            objectKey: `native/1/${randomUUID()}/${randomUUID()}.png`,
            digest: "0".repeat(64),
          },
        ],
      }),
    );
    expect(await f.readMedia()).toEqual(original);
  });
  it("rejects traversal and symlink media candidates", async () => {
    const f = await fixture();
    await expect(f.native.admit({ ...f.input, filename: "../outside.png" })).rejects.toThrow(
      "receipt_invalid",
    );
    const link = `${randomUUID()}.png`;
    await symlink(
      path.join(f.native.directory, f.input.filename),
      path.join(f.native.directory, link),
    );
    await expect(f.native.admit({ ...f.input, filename: link })).rejects.toThrow("path_invalid");
  });
});
