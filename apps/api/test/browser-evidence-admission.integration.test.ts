import { randomBytes, randomInt } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, realpath, readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthenticatedEvidenceStore } from "@scry/chronicle";
import { EvidenceCipher } from "@scry/veil";
import { PraxisOwnerLease } from "../../../packages/praxis/src/owner-lease.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";
import { publishFixtureEvidence } from "./fixtures/evidence-recording.js";

interface SyncGate {
  directory: string;
  used: boolean;
  entered(): void;
  release: Promise<void>;
}
const fileFault = vi.hoisted(() => ({ gate: undefined as SyncGate | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const { constants } = await import("node:fs");
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const gate = fileFault.gate;
      const exclusive =
        typeof args[1] === "number" ? (args[1] & constants.O_EXCL) !== 0 : args[1]?.includes("x");
      if (
        gate &&
        !gate.used &&
        exclusive &&
        String(args[0]).startsWith(gate.directory + path.sep) &&
        !String(args[0]).endsWith(".evidence-write.lock")
      ) {
        gate.used = true;
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          gate.entered();
          await gate.release;
          return sync();
        };
      }
      return handle;
    },
  };
});
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url ? describe : describe.skip;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, milliseconds = 4000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("fixture_durability_gate_timeout")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
live("protected evidence admission without file-held ownership locks", () => {
  let database: Database, effects: BrowserExecutionRepository;
  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    database = new Database();
    effects = new BrowserExecutionRepository(database, new BrowserProtectedValueCipher());
  });
  afterAll(async () => database?.onModuleDestroy());
  async function fixture() {
    const sessionId = await seedSession(database, effects, "https://admission.fixture.invalid");
    const claim = await effects.claimOwner(sessionId, "file-admission-fixture", 1000);
    const owner = { sessionId, generation: claim.generation, leaseToken: claim.leaseToken };
    const lease = new PraxisOwnerLease(owner, effects, claim);
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "scry-file-admission-")));
    const directory = path.join(root, "evidence");
    const runId = (
      await database.query<{ run_id: string }>(
        "SELECT run_id FROM browser_execution_sessions WHERE id=$1",
        [sessionId],
      )
    ).rows[0]!.run_id;
    const protection = new EvidenceCipher(randomBytes(32));
    const store = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
      directory,
      runId,
      scopeId: sessionId,
      protection,
      admission: lease,
      maxSessionBytes: 1048576,
    }).initialize();
    await store.append({ type: "fixture", protectedEvent: true });
    const entered = deferred(),
      release = deferred();
    fileFault.gate = { directory, used: false, entered: entered.resolve, release: release.promise };
    return { sessionId, owner, lease, root, directory, runId, protection, store, entered, release };
  }
  it("continues acknowledged renewal while actual chunk synchronization is held", async () => {
    const f = await fixture();
    let flushing: Promise<unknown> | undefined;
    let acknowledgedHeartbeats = 0;
    const originalHeartbeat = effects.heartbeatOwner.bind(effects);
    const heartbeat = vi.spyOn(effects, "heartbeatOwner").mockImplementation(async (...args) => {
      const sample = await originalHeartbeat(...args);
      acknowledgedHeartbeats += 1;
      return sample;
    });
    try {
      f.lease.startHeartbeat(1000);
      flushing = f.store.flush();
      void flushing.catch(() => undefined);
      await bounded(f.entered.promise);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(f.lease.signal.aborted).toBe(false);
      expect(acknowledgedHeartbeats).toBeGreaterThanOrEqual(3);
      f.release.resolve();
      await flushing;
      expect((await f.store.verify()).chunks).toBe(1);
    } finally {
      f.release.resolve();
      await flushing?.catch(() => undefined);
      fileFault.gate = undefined;
      f.lease.revoke();
      heartbeat.mockRestore();
      await effects.retireOwner({ owner: f.owner, browserStopped: true, recordingDrained: true });
    }
  }, 15000);
  it("never imports a file whose old writer was revoked before admission", async () => {
    const f = await fixture();
    let flushing: Promise<unknown> | undefined, replacement: PraxisOwnerLease | undefined;
    try {
      flushing = f.store.flush();
      void flushing.catch(() => undefined);
      await bounded(f.entered.promise);
      await bounded(
        new Promise<void>((resolve) => {
          if (f.lease.signal.aborted) resolve();
          else f.lease.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      );
      f.release.resolve();
      await expect(flushing).rejects.toThrow("OWNER_FENCED");
      fileFault.gate = undefined;
      const claim = await effects.claimOwner(f.sessionId, "replacement-fixture", 60000);
      replacement = new PraxisOwnerLease(
        { sessionId: f.sessionId, generation: claim.generation, leaseToken: claim.leaseToken },
        effects,
        claim,
      );
      const recovered = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
        directory: f.directory,
        runId: f.runId,
        scopeId: f.sessionId,
        protection: f.protection,
        admission: replacement,
        maxSessionBytes: 1048576,
      }).initialize();
      expect((await recovered.verify()).chunks).toBe(0);
    } finally {
      f.release.resolve();
      await flushing?.catch(() => undefined);
      fileFault.gate = undefined;
      f.lease.revoke();
      replacement?.revoke();
      if (replacement)
        await effects.retireOwner({
          owner: replacement.identity,
          browserStopped: true,
          recordingDrained: true,
        });
    }
  }, 15000);

  async function cleanup(f: Awaited<ReturnType<typeof fixture>>) {
    f.release.resolve();
    fileFault.gate = undefined;
    f.lease.revoke();
    await effects.retireOwner({ owner: f.owner, browserStopped: true, recordingDrained: true });
  }
  it("does not admit a candidate whose owner expires while waiting for the stream lock", async () => {
    const f = await fixture();
    f.release.resolve();
    const blocker = await database.pool.connect();
    const original = effects.admitEvidenceChunk.bind(effects);
    const fault = vi
      .spyOn(effects, "admitEvidenceChunk")
      .mockImplementationOnce(async (...args) => {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT id FROM browser_evidence_streams WHERE session_id=$1 FOR UPDATE",
          [f.sessionId],
        );
        const pending = original(...args);
        void pending.catch(() => undefined);
        try {
          await bounded(
            new Promise<void>((resolve) => {
              if (f.lease.signal.aborted) resolve();
              else f.lease.signal.addEventListener("abort", () => resolve(), { once: true });
            }),
          );
        } finally {
          await blocker.query("COMMIT");
        }
        return pending;
      });
    try {
      await expect(f.store.flush()).rejects.toThrow("OWNER_FENCED");
      expect(
        (
          await database.query(
            "SELECT chunk_count FROM browser_evidence_streams WHERE session_id=$1",
            [f.sessionId],
          )
        ).rows[0]!.chunk_count,
      ).toBe(0);
    } finally {
      fault.mockRestore();
      await blocker.query("ROLLBACK");
      blocker.release();
      await cleanup(f);
    }
  }, 15000);
  it("retries the exact prior receipt without rewinding a later head and refuses conflicting metadata", async () => {
    const f = await fixture();
    f.release.resolve();
    try {
      await f.store.flush();
      await f.store.append({ second: true });
      await f.store.flush();
      const before = await effects.readEvidenceStream(f.owner);
      await effects.admitEvidenceChunk(f.owner, before.chunks[0]!);
      expect(await effects.readEvidenceStream(f.owner)).toEqual(before);
      await expect(
        effects.admitEvidenceChunk(f.owner, { ...before.chunks[0]!, objectDigest: "b".repeat(64) }),
      ).rejects.toThrow("RECEIPT_CONFLICT");
      expect(await effects.readEvidenceStream(f.owner)).toEqual(before);
    } finally {
      await cleanup(f);
    }
  });
  it("rolls back admission when relational work stalls past the database owner deadline", async () => {
    const f = await fixture();
    f.release.resolve();
    const blocker = await database.pool.connect();
    const key = randomInt(1, 2000000000),
      name = "receipt_wait_" + f.sessionId.replaceAll("-", "");
    let flushing: Promise<unknown> | undefined;
    try {
      await blocker.query("SELECT pg_advisory_lock($1)", [key]);
      await database.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`,
      );
      await database.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON browser_evidence_streams FOR EACH ROW
        WHEN(NEW.session_id='${f.sessionId}'::uuid) EXECUTE FUNCTION ${name}()`);
      flushing = f.store.flush();
      void flushing.catch(() => undefined);
      await bounded(
        new Promise<void>((resolve) => {
          if (f.lease.signal.aborted) resolve();
          else f.lease.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      );
      await blocker.query("SELECT pg_advisory_unlock($1)", [key]);
      await expect(flushing).rejects.toThrow("OWNER_FENCED");
      expect(
        (
          await database.query(
            "SELECT chunk_count FROM browser_evidence_streams WHERE session_id=$1",
            [f.sessionId],
          )
        ).rows[0]!.chunk_count,
      ).toBe(0);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock($1)", [key]);
      await flushing?.catch(() => undefined);
      await database.query(`DROP TRIGGER IF EXISTS ${name} ON browser_evidence_streams`);
      await database.query(`DROP FUNCTION IF EXISTS ${name}()`);
      blocker.release();
      await cleanup(f);
    }
  }, 15000);
  it("admits only one of two concurrent candidates for the exact next head", async () => {
    const f = await fixture();
    f.release.resolve();
    const otherLease = new PraxisOwnerLease(
      f.owner,
      effects,
      await effects.heartbeatOwner(f.sessionId, f.owner.generation, f.owner.leaseToken, 60000),
    );
    try {
      const other = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
        directory: f.directory,
        runId: f.runId,
        scopeId: f.sessionId,
        protection: f.protection,
        admission: otherLease,
      }).initialize();
      await other.append({ competing: true });
      const results = await Promise.allSettled([f.store.flush(), other.flush()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await effects.readEvidenceStream(f.owner)).chunks).toHaveLength(1);
    } finally {
      otherLease.revoke();
      await cleanup(f);
    }
  });
  it("rolls back a chunk receipt when its stream-head update fails", async () => {
    const f = await fixture();
    f.release.resolve();
    const name = "receipt_fail_" + f.sessionId.replaceAll("-", "");
    try {
      await database.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_head_update_failed'; END $$`,
      );
      await database.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON browser_evidence_streams FOR EACH ROW
        WHEN(NEW.session_id='${f.sessionId}'::uuid) EXECUTE FUNCTION ${name}()`);
      await expect(f.store.flush()).rejects.toThrow("fixture_head_update_failed");
      expect((await effects.readEvidenceStream(f.owner)).chunks).toHaveLength(0);
      expect(
        (
          await database.query(
            "SELECT count(*)::int AS n FROM browser_evidence_chunks WHERE stream_id=(SELECT id FROM browser_evidence_streams WHERE session_id=$1)",
            [f.sessionId],
          )
        ).rows[0]!.n,
      ).toBe(0);
    } finally {
      await database.query(`DROP TRIGGER IF EXISTS ${name} ON browser_evidence_streams`);
      await database.query(`DROP FUNCTION IF EXISTS ${name}()`);
      await cleanup(f);
    }
  });
  it("recovers committed receipts after an admission acknowledgment is lost", async () => {
    const f = await fixture();
    f.release.resolve();
    const admit = effects.admitEvidenceChunk.bind(effects);
    const fault = vi
      .spyOn(effects, "admitEvidenceChunk")
      .mockImplementationOnce(async (...args) => {
        await admit(...args);
        throw new Error("fixture_ack_lost_after_commit");
      });
    let replacement: PraxisOwnerLease | undefined;
    try {
      await expect(f.store.flush()).rejects.toThrow("fixture_ack_lost_after_commit");
      expect((await effects.readEvidenceStream(f.owner)).chunks).toHaveLength(1);
      await effects.retireOwner({ owner: f.owner, browserStopped: true, recordingDrained: true });
      const next = await effects.claimOwner(f.sessionId, "receipt-ack-recovery", 60000);
      replacement = new PraxisOwnerLease(
        { sessionId: f.sessionId, generation: next.generation, leaseToken: next.leaseToken },
        effects,
        next,
      );
      const recovered = await new AuthenticatedEvidenceStore({
        directory: f.directory,
        runId: f.runId,
        scopeId: f.sessionId,
        protection: f.protection,
        admission: replacement,
      }).initialize();
      expect((await recovered.verify()).events).toEqual([
        { type: "fixture", protectedEvent: true },
      ]);
      expect(recovered.nextSequence).toBe(1);
    } finally {
      fault.mockRestore();
      await cleanup(f);
      replacement?.revoke();
      if (replacement)
        await effects.retireOwner({
          owner: replacement.identity,
          browserStopped: true,
          recordingDrained: true,
        });
    }
  });
  for (const failure of ["tamper", "missing"] as const)
    it(`refuses ${failure} of an admitted object without orphan fallback`, async () => {
      const f = await fixture();
      f.release.resolve();
      let restore: (() => Promise<void>) | undefined;
      try {
        await f.store.flush();
        const receipt = (await effects.readEvidenceStream(f.owner)).chunks[0]!;
        const filename = path.join(f.directory, receipt.objectKey);
        if (failure === "tamper") {
          const bytes = await readFile(filename);
          await writeFile(filename, Buffer.concat([bytes, Buffer.from(" ")]));
          restore = () => writeFile(filename, bytes);
        } else {
          const auditCopy = filename + ".audit-missing";
          await rename(filename, auditCopy);
          restore = () => rename(auditCopy, filename);
        }
        await expect(f.store.verify()).rejects.toThrow(
          failure === "tamper" ? "evidence_object_digest_invalid" : "ENOENT",
        );
      } finally {
        await restore?.();
        await cleanup(f);
      }
    });
  it("never promotes zero-chunk partial closure to passed and preserves its sealed metadata", async () => {
    const sessionId = await seedSession(database, effects, "https://partial.fixture.invalid");
    const owner = await effects.claimOwner(sessionId, "partial-fixture", 60000);
    const completion = await publishFixtureEvidence(
      database,
      effects,
      sessionId,
      owner.generation,
      true,
    );
    expect(completion).toMatchObject({ state: "incomplete", chainHead: null, chunkCount: 0 });
    await expect(effects.finalizeSession(sessionId, owner.generation)).rejects.toThrow(
      "EVIDENCE_INCOMPLETE",
    );
    await expect(
      database.query(
        "UPDATE browser_evidence_streams SET replay_artifact_key='local://altered' WHERE session_id=$1",
        [sessionId],
      ),
    ).rejects.toThrow("evidence_sealed_immutable");
    await effects.finalizeFailedSession(sessionId, owner.generation);
    expect(
      (
        await database.query(
          "SELECT state,sealed_at,completed_at FROM browser_evidence_streams WHERE session_id=$1",
          [sessionId],
        )
      ).rows[0],
    ).toMatchObject({ state: "incomplete", completed_at: null, sealed_at: expect.any(Date) });
  });
  for (const point of ["before_admission", "before_commit", "after_admission"] as const)
    it(`recovers only committed receipts after an actual child is killed ${point}`, async () => {
      const sessionId = await seedSession(database, effects, "https://crash.fixture.invalid");
      const claimed = await effects.claimOwner(sessionId, "admission-child-fixture", 60000);
      const owner = { sessionId, generation: claimed.generation, leaseToken: claimed.leaseToken };
      const runId = (
        await database.query<{ run_id: string }>(
          "SELECT run_id FROM browser_execution_sessions WHERE id=$1",
          [sessionId],
        )
      ).rows[0]!.run_id;
      const directory = await mkdtemp(path.join(os.tmpdir(), "scry-actual-receipt-crash-"));
      const key = randomBytes(32);
      let child: ChildProcess | undefined, replacement: PraxisOwnerLease | undefined;
      let exit: Promise<void> | undefined;
      try {
        child = fork(
          fileURLToPath(new URL("./fixtures/evidence-admission-child.ts", import.meta.url)),
          [],
          {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            execArgv: ["--import", "tsx"],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              TMPDIR: process.env.TMPDIR,
              DATABASE_URL: url!,
              SCRY_BROWSER_PROTECTED_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
            },
          },
        );
        exit = new Promise<void>((resolve, reject) => {
          child!.once("exit", () => resolve());
          child!.once("error", reject);
        });
        const ready = new Promise<void>((resolve, reject) => {
          child!.on("message", (value: unknown) => {
            const phase = (value as { phase?: string })?.phase;
            if (phase === "ready") resolve();
            else if (phase === "failed")
              reject(new Error("fixture_child_failed_before_crash_point"));
          });
          child!.once("exit", () => reject(new Error("fixture_child_exited_before_crash_point")));
          child!.once("error", reject);
        });
        child.send({ point, owner, runId, directory, key: key.toString("base64") });
        await bounded(ready, 10000);
        child.kill("SIGKILL");
        await bounded(exit);
        const expected = point === "after_admission" ? 1 : 0;
        expect(
          (
            await database.query(
              "SELECT chunk_count FROM browser_evidence_streams WHERE session_id=$1",
              [sessionId],
            )
          ).rows[0]!.chunk_count,
        ).toBe(expected);
        // No browser was created; after exact child exit and SQL rollback/commit
        // observation, all recording work is quiescent before retirement.
        await effects.retireOwner({ owner, browserStopped: true, recordingDrained: true });
        const next = await effects.claimOwner(sessionId, "child-crash-recovery", 60000);
        replacement = new PraxisOwnerLease(
          { sessionId, generation: next.generation, leaseToken: next.leaseToken },
          effects,
          next,
        );
        const recovered = await new AuthenticatedEvidenceStore({
          directory,
          runId,
          scopeId: sessionId,
          admission: replacement,
          protection: new EvidenceCipher(key),
        }).initialize();
        expect((await recovered.verify()).chunks).toBe(expected);
        expect(recovered.nextSequence).toBe(expected);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exit?.catch(() => undefined);
        replacement?.revoke();
        await effects.retireOwner({
          owner: replacement?.identity ?? owner,
          browserStopped: true,
          recordingDrained: true,
        });
      }
    }, 20000);
});
