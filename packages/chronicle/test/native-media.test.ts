import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChronicleEvidenceService } from "../src/evidence-session.js";
import { readNativeMedia, readNativePublication } from "../src/native-media.js";
import { memoryAdmission } from "./fixtures/evidence-admission.js";
import { EvidenceCipher } from "@scry/veil";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-native-"));
  const { admission, revoke, stream } = memoryAdmission();
  const evidence = await new ChronicleEvidenceService({
    render: async () => {
      throw new Error("DOM renderer must not run for native media");
    },
  }).openSession({
    root,
    runId: stream.runId,
    sessionId: stream.sessionId,
    protection: new EvidenceCipher(randomBytes(32)),
    admission,
    maxSessionBytes: 1024 * 1024,
  });
  const native = await evidence.createNativeRecording();
  await evidence.startCapture();
  const filename = `${randomUUID()}.png`;
  await writeFile(path.join(native.directory, filename), randomBytes(64));
  const input = { filename, kind: "screenshot" as const, timestamp: Date.now(), label: "initial" };
  return { root, admission, evidence, native, input, revoke };
}
describe("native media custody", () => {
  it("publishes only admitted native receipts and deduplicates identical screenshots", async () => {
    const f = await fixture();
    await f.native.admit(f.input);
    const duplicate = `${randomUUID()}.png`;
    const bytes = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(f.native.directory, f.input.filename)),
    );
    await writeFile(path.join(f.native.directory, duplicate), bytes);
    await f.native.admit({ ...f.input, filename: duplicate });
    await writeFile(path.join(f.native.directory, `${randomUUID()}.png`), randomBytes(64)); // orphan
    await f.evidence.stopCapture({ browserStopped: true, recordingDrained: true });
    const result = await f.evidence.seal({ renderVideo: true, actionLedger: async () => [] });
    expect(result.state).toBe("complete");
    const media = await readNativePublication(result.replayObjectKey!, f.root);
    expect(media).toHaveLength(1);
    expect(await readNativeMedia(f.root, media[0]!)).toEqual(bytes);
  });
  it("refuses stale-owner admission rather than promoting an orphan file", async () => {
    const f = await fixture();
    f.revoke();
    await expect(f.native.admit(f.input)).rejects.toThrow("OWNER_FENCED");
  });
  it("detects changed native bytes at read time", async () => {
    const f = await fixture();
    await f.native.admit(f.input);
    await f.evidence.stopCapture({ browserStopped: true, recordingDrained: true });
    const result = await f.evidence.seal({ renderVideo: false, actionLedger: async () => [] });
    const media = await readNativePublication(result.replayObjectKey!, f.root);
    await writeFile(path.join(f.native.directory, f.input.filename), randomBytes(64));
    await expect(readNativeMedia(f.root, media[0]!)).rejects.toThrow("integrity_mismatch");
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
