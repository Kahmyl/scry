import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { AuthenticatedEvidenceStore, LegacyEvidenceReader } from "../src/index.js";
import { EvidenceCipher } from "@scry/veil";
import { memoryAdmission } from "./fixtures/evidence-admission.js";
const RUN_ID = "00000000-0000-4000-8000-000000000101";

describe("authenticated evidence", () => {
  for (const corruption of ["missing", "duplicated", "reordered", "scope"])
    it(`rejects ${corruption} evidence`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "chronicle-integrity-"));
      const protection = new EvidenceCipher(randomBytes(32));
      const { admission, stream } = memoryAdmission("fixture-scope", RUN_ID);
      const store = await new AuthenticatedEvidenceStore({
        admission,
        directory,
        runId: RUN_ID,
        scopeId: "fixture-scope",
        protection,
      }).initialize();
      await store.append({ first: true });
      await store.flush();
      await store.append({ second: true });
      await store.flush();
      if (corruption === "missing") await unlink(path.join(directory, stream.chunks[0]!.objectKey));
      if (corruption === "duplicated") stream.chunks.splice(1, 0, { ...stream.chunks[0]! });
      if (corruption === "reordered") stream.chunks.reverse();
      if (corruption === "scope") {
        await expect(
          new AuthenticatedEvidenceStore({
            admission,
            directory,
            runId: RUN_ID,
            scopeId: "another-session",
            protection,
          }).initialize(),
        ).rejects.toThrow("evidence_admission_scope_invalid");
      } else if (corruption === "missing")
        await expect(store.verify()).rejects.toMatchObject({
          name: "EvidenceArtifactFailure",
          issue: "object_unavailable",
        });
      else await expect(store.verify()).rejects.toThrow("evidence_receipt_invalid");
    });
  it("reads historical authenticated chunks without using the historical key for writes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-legacy-evidence-"));
    const historicalKey = randomBytes(32);
    const currentKey = randomBytes(32);
    const aad = {
      evidenceVersion: 1,
      compression: "gzip",
      runId: RUN_ID,
      scopeId: "fixture-scope",
      chunk: 0,
      firstSequence: 0,
      lastSequence: 0,
      previousDigest: "GENESIS",
    };
    const plaintext = Buffer.from(
      JSON.stringify({ events: [{ sequence: 0, payload: { phase: "historical" } }] }),
    );
    const compressed = gzipSync(plaintext, { level: 6 });
    const aadBytes = Buffer.from(JSON.stringify(aad));
    const nonce = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", historicalKey, nonce);
    cipher.setAAD(aadBytes);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();
    const digest = createHash("sha256")
      .update(aadBytes)
      .update(nonce)
      .update(ciphertext)
      .update(tag)
      .digest("hex");
    const filename = "chunk-000000.json";
    await writeFile(
      path.join(directory, filename),
      JSON.stringify({
        aad,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: tag.toString("base64"),
        digest,
      }),
    );
    await writeFile(
      path.join(directory, "manifest.jsonl"),
      `${JSON.stringify({
        filename,
        ...aad,
        digest,
        plaintextBytes: plaintext.length,
        storedBytes: compressed.length,
      })}\n`,
    );

    const before = await readFile(path.join(directory, "manifest.jsonl"));
    const store = new LegacyEvidenceReader<{ phase: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      protection: new EvidenceCipher(currentKey, [historicalKey]),
    });
    expect((await store.verify()).events).toEqual([{ phase: "historical" }]);
    expect(store).not.toHaveProperty("append");
    expect(await readFile(path.join(directory, "manifest.jsonl"))).toEqual(before);
    const { admission, stream } = memoryAdmission("fixture-scope", RUN_ID);
    const currentDirectory = await mkdtemp(path.join(os.tmpdir(), "browser-current-evidence-"));
    const current = await new AuthenticatedEvidenceStore<{ phase: string }>({
      admission,
      directory: currentDirectory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      protection: new EvidenceCipher(currentKey, [historicalKey]),
    }).initialize();
    await current.append({ phase: "current" });
    await current.flush();
    const currentRecord = JSON.parse(
      await readFile(path.join(currentDirectory, stream.chunks[0]!.objectKey), "utf8"),
    ) as { aad: Record<string, unknown> };
    expect(currentRecord.aad).toMatchObject({ evidenceFormat: 1 });
    expect(currentRecord.aad).not.toHaveProperty("evidenceVersion");
  });

  it("resumes an authenticated chain across restart and detects ciphertext tampering", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-"));
    const encryptionKey = randomBytes(32);
    const { admission, stream } = memoryAdmission("fixture-scope", RUN_ID);
    const first = await new AuthenticatedEvidenceStore<{ phase: string }>({
      admission,
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      protection: new EvidenceCipher(encryptionKey),
      maxChunkBytes: 1_024,
    }).initialize();
    await first.append({ phase: "before-restart" });
    await first.flush();

    const resumed = await new AuthenticatedEvidenceStore<{ phase: string }>({
      admission,
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      protection: new EvidenceCipher(encryptionKey),
      maxChunkBytes: 1_024,
    }).initialize();
    await resumed.append({ phase: "after-restart" });
    await resumed.flush();
    expect((await resumed.verify()).events).toEqual([
      { phase: "before-restart" },
      { phase: "after-restart" },
    ]);
    expect(await readdir(directory)).not.toContain("evidence.key");

    await expect(
      new AuthenticatedEvidenceStore<{ phase: string }>({
        admission,
        directory,
        runId: RUN_ID,
        scopeId: "fixture-scope",
        protection: new EvidenceCipher(randomBytes(32)),
      }).initialize(),
    ).rejects.toMatchObject({ name: "EvidenceArtifactFailure", issue: "content_unverifiable" });

    const chunkPath = path.join(directory, stream.chunks[1]!.objectKey);
    const record = JSON.parse(await readFile(chunkPath, "utf8")) as { ciphertext: string };
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    record.ciphertext = ciphertext.toString("base64");
    await writeFile(chunkPath, JSON.stringify(record));
    await expect(resumed.verify()).rejects.toMatchObject({
      name: "EvidenceArtifactFailure",
      issue: "integrity_mismatch",
    });
  });

  it("fences duplicate continuations and never imports stray partial files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-contention-"));
    const encryptionKey = randomBytes(32);
    const { admission } = memoryAdmission("fixture-scope", RUN_ID);
    const original = await new AuthenticatedEvidenceStore<{ owner: string }>({
      admission,
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      protection: new EvidenceCipher(encryptionKey),
      maxChunkBytes: 1_024,
    }).initialize();
    await original.append({ owner: "original" });
    await original.flush();
    const ownerA = await new AuthenticatedEvidenceStore<{ owner: string }>({
      admission,
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      protection: new EvidenceCipher(encryptionKey),
    }).initialize();
    const ownerB = await new AuthenticatedEvidenceStore<{ owner: string }>({
      admission,
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      protection: new EvidenceCipher(encryptionKey),
    }).initialize();
    await ownerA.append({ owner: "a" });
    await ownerB.append({ owner: "b" });
    const attempts = await Promise.allSettled([ownerA.flush(), ownerB.flush()]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(
      attempts.filter(
        (attempt) =>
          attempt.status === "rejected" &&
          /evidence_sequence_conflict|receipt_conflict/.test(String(attempt.reason)),
      ),
    ).toHaveLength(1);
    await writeFile(path.join(directory, "chunk-000002.json.partial-interrupted"), "{");
    const verified = await ownerA.verify();
    expect(verified.chunks).toBe(2);
    expect(verified.complete).toBe(true); // authenticated admitted prefix only, not journey coverage
    expect(verified.gaps).toEqual([]);
  });
});
