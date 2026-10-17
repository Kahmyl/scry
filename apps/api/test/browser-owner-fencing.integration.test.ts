import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PraxisExecutionPort } from "@scry/contracts";
import { ChronicleEvidenceService } from "@scry/chronicle";
import { EvidenceCipher } from "@scry/veil";
import { composePraxisExecutionPort } from "../src/browser-execution/browser-boundary-composition.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";

const databaseUrl = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const run = databaseUrl && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;

run("browser ownership admission", () => {
  const server = createServer((_request, response) =>
    response.writeHead(200, { "content-type": "text/html" }).end("<main>Owned document</main>"),
  );
  let origin: string;
  let database: Database;
  let effects: BrowserExecutionRepository;
  let commands: BrowserCommandRepository;
  let praxis: PraxisExecutionPort;
  let root: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    process.env.SCRY_BROWSER_RENDER_VIDEO = "false";
    root = await mkdtemp(path.join(os.tmpdir(), "praxis-owner-"));
    process.env.SCRY_BROWSER_ARTIFACT_ROOT = root;
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    effects = new BrowserExecutionRepository(database, cipher);
    commands = new BrowserCommandRepository(database, cipher);
    praxis = composePraxisExecutionPort(commands, effects);
  });
  afterAll(async () => {
    await praxis?.shutdown();
    await database?.onModuleDestroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects normal closure by a living replaced owner without appending chunks or completing evidence", async () => {
    const sessionId = await seedSession(database, effects, origin);
    await praxis.openSession(sessionId);
    await praxis.executeCommand(sessionId, { kind: "navigate", url: origin });
    const manifestPath = path.join(root, sessionId, "evidence", "manifest.jsonl");
    const before = await readFile(manifestPath, "utf8").catch(() => "");
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
      [sessionId],
    );
    const replacement = await effects.claimOwner(sessionId, `replacement-${randomUUID()}`, 60_000);
    expect(replacement.generation).toBe(2);
    await expect(praxis.executeCommand(sessionId, { kind: "close" })).rejects.toThrow(
      "SCRY_BROWSER_OWNER_FENCED",
    );
    expect(await commands.evidenceComplete(sessionId)).toBe(false);
    expect(await readFile(manifestPath, "utf8").catch(() => "")).toBe(before);
  });

  it("rejects commands and failure closure when the lease expires without replacement", async () => {
    for (const kind of ["observe", "close_for_failure"] as const) {
      const sessionId = await seedSession(database, effects, origin);
      await praxis.openSession(sessionId);
      await database.query(
        "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
        [sessionId],
      );
      await expect(praxis.executeCommand(sessionId, { kind })).rejects.toThrow(
        "SCRY_BROWSER_OWNER_FENCED",
      );
      expect(await commands.evidenceComplete(sessionId)).toBe(false);
    }
  });

  it("requires the current owner token and exact session/run scope before idempotent stream completion", async () => {
    const sessionId = await seedSession(database, effects, origin);
    const claimed = await effects.claimOwner(sessionId, "completion-owner", 60_000);
    const owner = { sessionId, generation: claimed.generation, leaseToken: claimed.leaseToken };
    const { runId } = await commands.sessionContext(sessionId);
    const completion = {
      sessionId,
      runId,
      chainHead: "a".repeat(64),
      chunkCount: 1,
      totalBytes: 64,
      replayObjectKey: "local://qualification",
    };
    await expect(
      effects.completeEvidence({ ...owner, leaseToken: randomUUID() }, completion),
    ).rejects.toThrow("SCRY_BROWSER_OWNER_FENCED");
    await expect(
      effects.completeEvidence(owner, { ...completion, runId: randomUUID() }),
    ).rejects.toThrow("SCRY_BROWSER_EVIDENCE_SCOPE_MISMATCH");
    await expect(
      effects.completeEvidence(owner, { ...completion, sessionId: randomUUID() }),
    ).rejects.toThrow("SCRY_BROWSER_EVIDENCE_SCOPE_MISMATCH");
    expect(await commands.evidenceComplete(sessionId)).toBe(false);
    await effects.completeEvidence(owner, completion);
    await effects.completeEvidence(owner, completion);
    expect(
      (
        await database.query(
          "SELECT chain_head FROM browser_evidence_streams WHERE session_id=$1",
          [sessionId],
        )
      ).rows,
    ).toEqual([{ chain_head: completion.chainHead }]);
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
      [sessionId],
    );
    await effects.claimOwner(sessionId, "replacement-completion-owner", 60_000);
    await expect(effects.completeEvidence(owner, completion)).rejects.toThrow(
      "SCRY_BROWSER_OWNER_FENCED",
    );
  });

  it("fences buffered Chronicle writes against the real owner row and preserves a valid replacement continuation", async () => {
    const sessionId = await seedSession(database, effects, origin);
    const claimed = await effects.claimOwner(sessionId, "recording-owner", 60_000);
    const owner = { sessionId, generation: claimed.generation, leaseToken: claimed.leaseToken };
    const { runId } = await commands.sessionContext(sessionId);
    const directory = await mkdtemp(path.join(os.tmpdir(), "praxis-recording-gate-"));
    const protection = new EvidenceCipher(randomBytes(32));
    const service = new ChronicleEvidenceService({
      render: async () => {
        throw new Error("unused");
      },
    });
    const session = await service.openSession({
      root: directory,
      sessionId,
      runId,
      protection,
      maxSessionBytes: 1024 * 1024,
      admission: { run: (work) => effects.withOwner(owner, work) },
    });
    const recording = session.createRecording({ snapshot: () => (value) => value });
    recording.receive('{"valid":true}');
    await recording.flush();
    const manifestPath = path.join(directory, "evidence", "manifest.jsonl");
    const before = await readFile(manifestPath, "utf8");
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
      [sessionId],
    );
    const replacement = await effects.claimOwner(sessionId, "replacement-recording-owner", 60_000);
    recording.receive('{"stale":true}');
    await expect(recording.flush()).rejects.toThrow("SCRY_BROWSER_OWNER_FENCED");
    expect(await readFile(manifestPath, "utf8")).toBe(before);
    const identity = {
      sessionId,
      generation: replacement.generation,
      leaseToken: replacement.leaseToken,
    };
    const resumed = await service.openSession({
      root: directory,
      sessionId,
      runId,
      protection,
      maxSessionBytes: 1024 * 1024,
      admission: { run: (work) => effects.withOwner(identity, work) },
    });
    const continuation = resumed.createRecording({ snapshot: () => (value) => value });
    continuation.receive('{"replacement":true}');
    await continuation.flush();
    expect(
      (await resumed.seal({ renderVideo: false, actionLedger: async () => [] })).chunkCount,
    ).toBe(2);
  });

  it("serializes owner replacement after an admitted durable write, including a lease expiring during that write", async () => {
    const sessionId = await seedSession(database, effects, origin);
    const claimed = await effects.claimOwner(sessionId, "writer-owner", 60_000);
    const owner = { sessionId, generation: claimed.generation, leaseToken: claimed.leaseToken };
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE session_id=$1 AND state='active'",
      [sessionId],
    );
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const order: string[] = [];
    const write = effects.withOwner(owner, async () => {
      started();
      await gate;
      order.push("write");
    });
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 650));
    const replace = effects.claimOwner(sessionId, "replacement-writer", 60_000).then((receipt) => {
      order.push("replace");
      return receipt;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual([]);
    } finally {
      finish();
    }
    await write;
    expect((await replace).generation).toBe(2);
    expect(order).toEqual(["write", "replace"]);
    await expect(effects.withOwner(owner, async () => undefined)).rejects.toThrow(
      "SCRY_BROWSER_OWNER_FENCED",
    );
  });
});
