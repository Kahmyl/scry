import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EvidenceCipher } from "@scry/veil";
import { AdmittedEvidenceStore } from "../src/admitted-evidence-store.js";
import { memoryAdmission } from "./fixtures/evidence-admission.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "scry-staged-receipts-"));
  const control = memoryAdmission();
  const options = {
    directory: root,
    runId: control.stream.runId,
    scopeId: control.stream.sessionId,
    protection: new EvidenceCipher(randomBytes(32)),
    admission: control.admission,
  };
  const store = await new AdmittedEvidenceStore<Record<string, unknown>>(options).initialize();
  return { root, ...control, options, store };
}
describe("staged receipt-backed store before caller cutover", () => {
  it("refuses a second initialization while the first initialization is pending", async () => {
    const f = await fixture();
    const store = new AdmittedEvidenceStore(f.options);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const open = f.admission.openStream.bind(f.admission);
    vi.spyOn(f.admission, "openStream").mockImplementationOnce(async (runId) => {
      entered();
      await gate;
      return open(runId);
    });
    const first = store.initialize();
    await ready;
    try {
      await expect(store.initialize()).rejects.toThrow("evidence_store_already_initialized");
    } finally {
      release();
      await first;
    }
  });
  it("authenticates exact receipts and resumes their next sequence", async () => {
    const f = await fixture();
    expect(await f.store.append({ safe: "one" })).toBe(0);
    await f.store.flush();
    expect(await f.store.append({ safe: "two" })).toBe(1);
    await f.store.flush();
    const recovered = await new AdmittedEvidenceStore(f.options).initialize();
    expect(recovered.nextSequence).toBe(2);
    expect((await recovered.verify()).events).toEqual([{ safe: "one" }, { safe: "two" }]);
    expect(
      f.stream.chunks.every(
        (r) => r.objectKey.startsWith("objects/1/") && r.objectBytes > r.storedBytes,
      ),
    ).toBe(true);
  });
  it("never promotes an authenticated candidate after admission rejects it", async () => {
    const f = await fixture();
    await f.store.append({ safe: "rejected" });
    vi.spyOn(f.admission, "admitChunk").mockRejectedValueOnce(new Error("fixture_rejected"));
    await expect(f.store.flush()).rejects.toThrow("fixture_rejected");
    expect(f.stream.chunks).toHaveLength(0);
    const recovered = await new AdmittedEvidenceStore(f.options).initialize();
    expect((await recovered.verify()).events).toEqual([]);
  });
  it("refuses a tampered admitted object without falling back to an orphan", async () => {
    const f = await fixture();
    await f.store.append({ safe: "admitted" });
    await f.store.flush();
    const receipt = f.stream.chunks[0]!;
    const filename = path.join(f.root, receipt.objectKey);
    const bytes = await readFile(filename);
    await writeFile(filename, Buffer.concat([bytes, Buffer.from(" ")]));
    await expect(f.store.verify()).rejects.toThrow("evidence_object_digest_invalid");
  });
  it("refuses overlapping writer mutation rather than losing a pending event", async () => {
    const f = await fixture();
    await f.store.append({ first: true });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const read = f.admission.readStream.bind(f.admission);
    vi.spyOn(f.admission, "readStream").mockImplementationOnce(async () => {
      entered();
      await gate;
      return read();
    });
    const flushing = f.store.flush();
    await ready;
    await expect(f.store.append({ second: true })).rejects.toThrow("evidence_writer_busy");
    release();
    await flushing;
    expect((await f.store.verify()).events).toEqual([{ first: true }]);
  });
});
