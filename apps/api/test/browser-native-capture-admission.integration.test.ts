import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  ChronicleEvidenceService,
  AuthenticatedEvidenceStore,
  AdmittedEvidenceReader,
  AdmittedEvidenceRepository,
  readNativeEvidenceInventory,
} from "@scry/chronicle";
import type { NativeCapturePort, NativeCaptureSample, PraxisOwnerIdentity } from "@scry/contracts";
import { PraxisOwnerLease } from "../../../packages/praxis/src/owner-lease.js";
import { Database } from "../src/infrastructure/database.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { seedSession } from "./fixtures/browser-session.js";

const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url ? describe : describe.skip;
/** Actual SQL ownership and authenticated admission; physical bytes are harmless
 * placeholders. This suite does not launch Chrome or certify encoder ordering. */
live("native v2 capture SQL admission and recovery", () => {
  let database: Database, effects: BrowserExecutionRepository;
  const suffix = randomUUID().slice(0, 8),
    cleanup: Array<{ lease: PraxisOwnerLease; owner: PraxisOwnerIdentity }> = [];
  const roots: string[] = [];
  const previous = {
    database: process.env.DATABASE_URL,
    protectedKey: process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64,
    adapter: process.env.SCRY_BROWSER_ADAPTER,
    enabled: process.env.SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED,
    capacity: process.env.SCRY_BROWSER_MAX_LIVE_SESSIONS,
  };
  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    process.env.SCRY_BROWSER_ADAPTER = "playwright_mcp";
    process.env.SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED = "true";
    // Placeholder sessions coexist only inside the isolated test database.
    process.env.SCRY_BROWSER_MAX_LIVE_SESSIONS = "100";
    database = new Database();
    effects = new BrowserExecutionRepository(database, new BrowserProtectedValueCipher());
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    for (const item of cleanup) {
      item.lease.revoke();
      try {
        await effects.retireOwner({
          owner: item.owner,
          browserStopped: true,
          recordingDrained: true,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await database?.onModuleDestroy();
    } catch (error) {
      failures.push(error);
    }
    for (const result of await Promise.allSettled(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    ))
      if (result.status === "rejected") failures.push(result.reason);
    for (const [key, value] of [
      ["DATABASE_URL", previous.database],
      ["SCRY_BROWSER_PROTECTED_KEY_BASE64", previous.protectedKey],
      ["SCRY_BROWSER_ADAPTER", previous.adapter],
      ["SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", previous.enabled],
      ["SCRY_BROWSER_MAX_LIVE_SESSIONS", previous.capacity],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (failures.length) throw new AggregateError(failures, "Native capture test cleanup failed");
  });
  const sample = (
    readId: number,
    extra: Partial<NativeCaptureSample> = {},
  ): NativeCaptureSample => ({
    version: 1,
    readId,
    policyGeneration: 1,
    text: "complete",
    knownRequirement: "present",
    image: { state: "available", assessment: "best_effort_known_candidates" },
    ...extra,
  });
  async function fixture() {
    const sessionId = await seedSession(database!, effects!, "https://task-sql-v2.fixture.invalid");
    const claim = await effects!.claimOwner(sessionId, "task-sql-v2", 60000),
      owner = { sessionId, generation: claim.generation, leaseToken: claim.leaseToken };
    const lease = new PraxisOwnerLease(owner, effects!, claim);
    cleanup.push({ lease, owner });
    const root = await mkdtemp(path.join(tmpdir(), "scry-v2-sql-")),
      protection = new (await import("@scry/veil")).EvidenceCipher(randomBytes(32));
    roots.push(root);
    const runId = (
      await database!.query<{ run_id: string }>(
        "SELECT run_id FROM browser_execution_sessions WHERE id=$1",
        [sessionId],
      )
    ).rows[0]!.run_id;
    const scope = {
      root,
      admission: lease,
      runId,
      sessionId,
      protection,
      maxSessionBytes: 8 * 1024 * 1024,
    };
    const renderer = {
      render: async () => {
        throw new Error("fixture_dom_fallback_forbidden");
      },
    };
    const service = new ChronicleEvidenceService(renderer),
      session = await service.openSession(scope),
      native = await session.createNativeRecording();
    await session.startCapture();
    const verify = () =>
      new AdmittedEvidenceReader<Record<string, unknown>>({
        directory: path.join(root, "evidence"),
        runId,
        scopeId: sessionId,
        protection,
        admission: lease,
      }).verify();
    return { sessionId, owner, lease, root, runId, scope, service, session, native, verify };
  }
  async function reserve(f: Awaited<ReturnType<typeof fixture>>) {
    const c = await f.native.reserveCaptureV2({ kind: "display", policyGeneration: 1 });
    await writeFile(
      path.join(c.directory, c.filename),
      Buffer.from(`public task capture ${c.epoch.captureId}`),
    );
    return c;
  }
  async function seal(c: NativeCapturePort, gap = false) {
    await c.graphSample({
      sequence: 1,
      sample: sample(1, gap ? { observedRequiredGap: "native_protection_geometry_stale" } : {}),
    });
    const challenge = await c.physicalStopped({
      epoch: c.epoch,
      started: 1000,
      ended: 2000,
      physicalCoverage: "complete",
    });
    await c.graphSample({
      sequence: 2,
      sample: sample(2, { finalReadChallenge: challenge.challenge }),
    });
    await c.graphClosed({ lastSequence: 2 });
    return c.seal();
  }
  async function replace(f: Awaited<ReturnType<typeof fixture>>) {
    await effects!.retireOwner({ owner: f.owner, browserStopped: true, recordingDrained: true });
    const claim = await effects!.claimOwner(f.sessionId, "task-sql-v2-replacement", 60000),
      owner = {
        sessionId: f.sessionId,
        generation: claim.generation,
        leaseToken: claim.leaseToken,
      };
    const lease = new PraxisOwnerLease(owner, effects!, claim);
    cleanup.push({ lease, owner });
    const scope = { ...f.scope, admission: lease },
      session = await f.service.openSession(scope),
      native = await session.createNativeRecording();
    return { owner, lease, scope, session, native };
  }
  it("actual_scope_and_owner_fencing", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await seal(c);
    const before = await effects!.readEvidenceStream(f.owner);
    await assert.rejects(effects!.openEvidenceStream(f.owner, randomUUID()), /SCOPE_MISMATCH/);
    await assert.rejects(
      effects!.admitEvidenceChunk({ ...f.owner, leaseToken: randomUUID() }, before.chunks[0]!),
      /OWNER_FENCED/,
    );
    await assert.rejects(
      new AdmittedEvidenceReader({
        directory: path.join(f.root, "evidence"),
        runId: randomUUID(),
        scopeId: f.sessionId,
        protection: f.scope.protection,
        admission: f.lease,
      }).verify(),
      /scope_invalid/,
    );
    assert.deepEqual(await effects!.readEvidenceStream(f.owner), before);
  });
  it("concurrent_v2_recovery_exact_receipt_retry_and_immutable_completion", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await seal(c);
    const recovered = await Promise.all([
      f.session.recoverNativeCaptures(f.native),
      f.session.recoverNativeCaptures(f.native),
    ]);
    assert.deepEqual(
      recovered.map((r) => r.admitted),
      [1, 1],
    );
    const verified = await f.verify();
    assert.equal(verified.events.filter((e) => e.type === "native_media").length, 1);
    const before = await effects!.readEvidenceStream(f.owner);
    await effects!.admitEvidenceChunk(f.owner, before.chunks[0]!);
    assert.deepEqual(await effects!.readEvidenceStream(f.owner), before);
    await assert.rejects(
      effects!.admitEvidenceChunk(f.owner, { ...before.chunks[0]!, objectDigest: "b".repeat(64) }),
      /RECEIPT_CONFLICT/,
    );
    await f.session.stopCapture({ browserStopped: true, recordingDrained: true });
    const completion = await f.session.seal({ renderVideo: true, actionLedger: async () => [] });
    assert.equal(completion.state, "complete");
    assert.ok(completion.videoObjectKey);
    await effects!.completeEvidence(f.owner, completion);
    await effects!.completeEvidence(f.owner, completion);
    await assert.rejects(
      database!.query(
        "UPDATE browser_evidence_streams SET video_artifact_key='local://fixture-forbidden' WHERE session_id=$1",
        [f.sessionId],
      ),
      /evidence_sealed_immutable/,
    );
    const snapshot = await new AdmittedEvidenceRepository(database!).snapshot(f.sessionId, false);
    const inventory = await readNativeEvidenceInventory({
      root: f.root,
      snapshot,
      protection: f.scope.protection,
    });
    assert.equal(inventory.media.length, 1);
    assert.equal(inventory.recordingAssessment?.state, "best_effort_assessed");
  });
  it("replacement_preserves_original_lineage_and_fences_stale_writer", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await seal(c);
    const original = await effects!.readEvidenceStream(f.owner);
    const next = await replace(f);
    assert.equal(next.owner.generation, 2);
    await assert.rejects(effects!.admitEvidenceChunk(f.owner, original.chunks[0]!), /OWNER_FENCED/);
    assert.equal((await next.session.recoverNativeCaptures(next.native)).admitted, 1);
    const snapshot = await effects!.readEvidenceStream(next.owner),
      verified = await new AdmittedEvidenceReader<Record<string, unknown>>({
        directory: path.join(f.root, "evidence"),
        runId: f.runId,
        scopeId: f.sessionId,
        protection: f.scope.protection,
        admission: next.lease,
      }).verify();
    const media = verified.events.find((e) => e.type === "native_media")!;
    assert.equal((media.captureEpoch as any).originalWriterGeneration, 1);
    assert.equal(media.admittingGeneration, 2);
    assert.equal(verified.eventOwnerGenerations[verified.events.indexOf(media)], 2);
    assert.equal(snapshot.writerGeneration, 2);
    await next.session.stopCapture({ browserStopped: true, recordingDrained: true });
    const completion = await next.session.seal({ renderVideo: true, actionLedger: async () => [] });
    assert.equal(completion.state, "incomplete");
    assert.ok(completion.videoObjectKey);
  });
  it("media_receipt_lost_ack_recovers_only_committed_sql_prefix", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await seal(c);
    const admit = effects!.admitEvidenceChunk.bind(effects!);
    let injected = false;
    effects!.admitEvidenceChunk = async (...args) => {
      await admit(...args);
      if (!injected) {
        injected = true;
        throw new Error("fixture_media_receipt_ack_lost_after_commit");
      }
    };
    try {
      await assert.rejects(f.session.recoverNativeCaptures(f.native), /ack_lost|OWNER_FENCED/);
    } finally {
      effects!.admitEvidenceChunk = admit;
    }
    assert.equal(injected, true);
    const next = await replace(f),
      recovered = await next.session.recoverNativeCaptures(next.native);
    assert.equal(recovered.admitted, 1);
    const snapshot = await effects!.readEvidenceStream(next.owner),
      inventory = await readNativeEvidenceInventory({
        root: f.root,
        snapshot,
        protection: f.scope.protection,
        allowOpen: true,
      });
    assert.equal(inventory.media.length, 1);
    assert.equal(inventory.recordingAssessment?.state, "best_effort_assessed");
  });
  it("sql_head_failure_rolls_back_v2_media_receipt_and_recovery_can_retry", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await seal(c);
    const before = await effects!.readEvidenceStream(f.owner),
      name = `v2_fail_${suffix}`;
    await database!.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_v2_media_head_failed'; END $$`,
    );
    await database!.query(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON browser_evidence_streams FOR EACH ROW WHEN(NEW.session_id='${f.sessionId}'::uuid) EXECUTE FUNCTION ${name}()`,
    );
    try {
      await assert.rejects(
        f.session.recoverNativeCaptures(f.native),
        /fixture_v2_media_head_failed|OWNER_FENCED/,
      );
    } finally {
      await database!.query(`DROP TRIGGER ${name} ON browser_evidence_streams`);
      await database!.query(`DROP FUNCTION ${name}()`);
    }
    const count = Number(
      (
        await database!.query(
          "SELECT chunk_count FROM browser_evidence_streams WHERE session_id=$1",
          [f.sessionId],
        )
      ).rows[0]!.chunk_count,
    );
    assert.equal(count, before.chunkCount);
    const next = await replace(f);
    assert.equal((await next.session.recoverNativeCaptures(next.native)).admitted, 1);
    const snapshot = await effects!.readEvidenceStream(next.owner);
    assert.equal(snapshot.chunkCount, before.chunkCount + 1);
  });
  it("actual_incomplete_invalid_and_changed_bytes_withhold_without_dom_fallback", async () => {
    for (const kind of ["missing_seal", "known_gap", "policy_gap", "changed_bytes"] as const) {
      const f = await fixture(),
        c = await reserve(f);
      if (kind !== "missing_seal") {
        if (kind === "policy_gap")
          await c.policyTransition({ from: 1, to: 2, acknowledged: false });
        await seal(c, kind === "known_gap");
        if (kind === "changed_bytes")
          await writeFile(path.join(c.directory, c.filename), "different public task bytes");
      }
      const recovered = await f.session.recoverNativeCaptures(f.native);
      assert.equal(recovered.admitted, 0);
      await f.session.stopCapture({ browserStopped: true, recordingDrained: true });
      const completion = await f.session.seal({ renderVideo: true, actionLedger: async () => [] });
      assert.equal(completion.state, "incomplete");
      assert.equal(completion.videoObjectKey, undefined);
      await effects!.completeEvidence(f.owner, completion);
      const snapshot = await new AdmittedEvidenceRepository(database!).snapshot(f.sessionId, false),
        inventory = await readNativeEvidenceInventory({
          root: f.root,
          snapshot,
          protection: f.scope.protection,
        });
      assert.equal(inventory.media.length, 0);
      assert.equal(inventory.recordingAssessment?.state, "withheld");
      await effects!.retireOwner({ owner: f.owner, browserStopped: true, recordingDrained: true });
      await effects!.finalizeFailedSession(f.sessionId, f.owner.generation);
    }
  });
  it("legacy_event_protocol_recovery_preserves_safe_sibling_after_v2_withholding", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await seal(c, true);
    const next = await replace(f);
    // Exercise the historical writer's authenticated event protocol with the
    // current store. This does not launch an old binary or prove binary rollback.
    // The reservation is not relabeled as v2 or globally cut off.
    const store = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
      directory: path.join(f.root, "evidence"),
      runId: f.runId,
      scopeId: f.sessionId,
      protection: f.scope.protection,
      admission: next.lease,
      maxSessionBytes: 8 * 1024 * 1024,
    }).initialize();
    const legacy = `native/${next.owner.generation}/${randomUUID()}/capture`;
    await mkdir(path.join(f.root, legacy), { recursive: true });
    await writeFile(path.join(f.root, legacy, "recording.mp4"), "public old-policy task video");
    await writeFile(
      path.join(f.root, legacy, "recording.json"),
      JSON.stringify({ started: 3000, duration: "1", coverage: "complete" }),
    );
    await store.append({ type: "native_capture_started", directory: legacy });
    await store.flush();
    // Reopen the actual new reader after the old writer's authoritative prefix.
    const readerSession = await f.service.openSession({ ...f.scope, admission: next.lease }),
      native = await readerSession.createNativeRecording();
    const result = await readerSession.recoverNativeCaptures(native);
    assert.equal(result.admitted, 1);
    assert.equal(result.recordingAssessment?.state, "withheld");
    const snapshot = await effects!.readEvidenceStream(next.owner),
      inventory = await readNativeEvidenceInventory({
        root: f.root,
        snapshot,
        protection: f.scope.protection,
        allowOpen: true,
      });
    assert.equal(inventory.media.length, 1);
    assert.equal(inventory.media[0]!.masking, "best_effort");
    assert.equal(inventory.recordingAssessment?.state, "withheld");
  });
});
