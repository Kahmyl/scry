import { EventEmitter } from "node:events";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { BrowserCommitIntent } from "@scry/contracts";
import { BrowserOwnerSupervisor, AuthenticatedEvidenceStore, EffectLedger } from "../src/index.js";
import { SensitiveValueClassifier } from "@scry/veil";

const RUN_ID = "00000000-0000-4000-8000-000000000101";
const SESSION_ID = "00000000-0000-4000-8000-000000000102";

function commitIntent(idempotencyKey = "fixture-create-001"): BrowserCommitIntent {
  return {
    runId: RUN_ID,
    browserSessionId: SESSION_ID,
    ownerGeneration: 1,
    documentEpoch: 2,
    idempotencyKey,
    authorization: "business",
    intentSummary: "Submit the visible create form once",
    expectedOrigin: "https://fixture.example",
    target: { frameId: "main", elementReference: "submit-1" },
  };
}

async function allFileText(directory: string): Promise<string> {
  const names = await readdir(directory, { recursive: true });
  const values: string[] = [];
  for (const name of names) {
    try {
      values.push(await readFile(path.join(directory, name), "utf8"));
    } catch {
      // Directory entries are expected here.
    }
  }
  return values.join("\n");
}

describe("effect truth", () => {
  it("persists admission before dispatch and returns the same effect for an idempotent replay", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-effects-"));
    const first = await new EffectLedger({ directory }).initialize();
    const admission = await first.admit(commitIntent());
    expect(admission.replay).toBe(false);
    expect(admission.observation.truth.outcome).toBe("pending");

    const restarted = await new EffectLedger({ directory }).initialize();
    const replay = await restarted.admit(commitIntent());
    expect(replay.replay).toBe(true);
    expect(replay.effectId).toBe(admission.effectId);
    expect(restarted.observations()).toHaveLength(1);
  });

  it("blocks a second mutation while dispatch truth is unknown and allows late reconciliation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-unknown-"));
    const ledger = await new EffectLedger({ directory }).initialize();
    const { effectId } = await ledger.admit(commitIntent());
    await ledger.markDispatchStarted(effectId);
    expect((await ledger.markUnknown(effectId, "connection_lost")).truth.outcome).toBe("unknown");
    await expect(ledger.admit(commitIntent("fixture-create-002"))).rejects.toThrow(
      /effect_unresolved/,
    );

    expect((await ledger.markProviderResponse(effectId, 201)).truth.outcome).toBe("unknown");
    expect(
      (await ledger.markApplied(effectId, "documented reconciliation confirmed the resource")).truth
        .outcome,
    ).toBe("applied");
    const next = await ledger.admit(commitIntent("fixture-create-002"));
    expect(next.replay).toBe(false);
  });

  it("does not infer effect truth from HTTP status alone", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-rejection-"));
    const ledger = await new EffectLedger({ directory }).initialize();
    const { effectId } = await ledger.admit(commitIntent());
    await ledger.markDispatchStarted(effectId);
    const observed = await ledger.markProviderResponse(effectId, 422);
    expect(observed.truth).toMatchObject({ dispatch: "acknowledged", outcome: "pending" });
    expect((await ledger.markNotApplied(effectId, "validated rejection body")).truth.outcome).toBe(
      "not_applied",
    );
  });

  it("sanitizes agent-authored intent before durable storage", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-effect-sanitize-"));
    const secret = "tok_fixture_1234567890";
    const ledger = await new EffectLedger({
      directory,
      classifier: new SensitiveValueClassifier({ protectedValues: { CANARY: secret } }),
    }).initialize();
    await ledger.admit({ ...commitIntent(), intentSummary: `Create with ${secret}` });
    expect(await allFileText(directory)).not.toContain(secret);
  });
});

class FakeBrowser extends EventEmitter {
  connected = true;
  isConnected(): boolean {
    return this.connected;
  }
  async close(): Promise<void> {
    this.connected = false;
    this.emit("disconnected");
  }
}

class FakeContext extends EventEmitter {
  async close(): Promise<void> {
    this.emit("close");
  }
}

describe("browser owner recovery", () => {
  it("fences concurrent creation and advances generation after context loss", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-owner-"));
    let contexts = 0;
    const supervisor = await new BrowserOwnerSupervisor({
      directory,
      launchBrowser: async () => new FakeBrowser(),
      createContext: async () => {
        contexts += 1;
        return new FakeContext();
      },
      prepareContext: async () => undefined,
    }).initialize();
    const [first, same] = await Promise.all([supervisor.getContext(), supervisor.getContext()]);
    expect(first).toBe(same);
    expect(contexts).toBe(1);
    first.emit("close");
    const replacement = await supervisor.getContext();
    expect(replacement).not.toBe(first);
    expect(supervisor.status()).toMatchObject({ generation: 2, active: true, losses: 1 });
    await supervisor.close();
  });
});

describe("authenticated evidence", () => {
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

    const store = await new AuthenticatedEvidenceStore<{ phase: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey: currentKey,
      legacyDecryptionKeys: [historicalKey],
    }).initialize();
    expect((await store.verify()).events).toEqual([{ phase: "historical" }]);
    await store.append({ phase: "current" });
    await store.flush();
    const currentRecord = JSON.parse(
      await readFile(path.join(directory, "chunk-000001.json"), "utf8"),
    ) as { aad: Record<string, unknown> };
    expect(currentRecord.aad).toMatchObject({ evidenceFormat: 1 });
    expect(currentRecord.aad).not.toHaveProperty("evidenceVersion");
  });

  it("resumes an authenticated chain across restart and detects ciphertext tampering", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-"));
    const encryptionKey = randomBytes(32);
    const first = await new AuthenticatedEvidenceStore<{ phase: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
      maxChunkBytes: 1_024,
    }).initialize();
    await first.append({ phase: "before-restart" });
    await first.flush();

    const resumed = await new AuthenticatedEvidenceStore<{ phase: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
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
        directory,
        runId: RUN_ID,
        scopeId: "fixture-scope",
        encryptionKey: randomBytes(32),
      }).initialize(),
    ).rejects.toThrow(/evidence_chunk_authentication_invalid/);

    const chunkPath = path.join(directory, "chunk-000001.json");
    const record = JSON.parse(await readFile(chunkPath, "utf8")) as { ciphertext: string };
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    record.ciphertext = ciphertext.toString("base64");
    await writeFile(chunkPath, JSON.stringify(record));
    await expect(resumed.verify()).rejects.toThrow(/evidence_chunk_digest_invalid/);
  });

  it("fences duplicate continuations and reports interrupted partial writes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-contention-"));
    const encryptionKey = randomBytes(32);
    const original = await new AuthenticatedEvidenceStore<{ owner: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
      maxChunkBytes: 1_024,
    }).initialize();
    await original.append({ owner: "original" });
    await original.flush();
    const ownerA = await new AuthenticatedEvidenceStore<{ owner: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
    }).initialize();
    const ownerB = await new AuthenticatedEvidenceStore<{ owner: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
    }).initialize();
    await ownerA.append({ owner: "a" });
    await ownerB.append({ owner: "b" });
    const attempts = await Promise.allSettled([ownerA.flush(), ownerB.flush()]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(
      attempts.filter(
        (attempt) =>
          attempt.status === "rejected" &&
          /evidence_sequence_conflict/.test(String(attempt.reason)),
      ),
    ).toHaveLength(1);
    await writeFile(path.join(directory, "chunk-000002.json.partial-interrupted"), "{");
    const verified = await ownerA.verify();
    expect(verified.complete).toBe(false);
    expect(verified.gaps).toEqual([
      { type: "partial_chunk", name: "chunk-000002.json.partial-interrupted" },
    ]);
  });
});
