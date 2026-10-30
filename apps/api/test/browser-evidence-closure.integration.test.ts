import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PraxisExecutionPort, RecordingProtectionPort } from "@scry/contracts";
import { ChronicleEvidenceSession, type ChronicleRecording } from "@scry/chronicle";
import { SupervisedBrowser } from "../../../packages/praxis/src/supervised-browser.js";
import { composePraxisExecutionPort } from "../src/browser-execution/browser-boundary-composition.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";

const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
live("actual browser stopped-capture publication recovery", () => {
  const server = createServer((_request, response) =>
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        "<!doctype html><main><h1>Captured once</h1><p>A fictional unchanged application.</p></main>",
      ),
  );
  let database: Database, effects: BrowserExecutionRepository, commands: BrowserCommandRepository;
  let praxis: PraxisExecutionPort, origin: string;
  let launched: import("vitest").MockInstance<typeof SupervisedBrowser.launch>;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_address_missing");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    process.env.SCRY_BROWSER_RENDER_VIDEO = "false";
    process.env.SCRY_BROWSER_ARTIFACT_ROOT = await mkdtemp(
      path.join(os.tmpdir(), "scry-closure-recovery-"),
    );
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    effects = new BrowserExecutionRepository(database, cipher);
    commands = new BrowserCommandRepository(database, cipher);
  });
  beforeEach(() => {
    praxis = composePraxisExecutionPort(commands, effects);
    launched = vi.spyOn(SupervisedBrowser, "launch");
  });
  afterEach(async () => {
    await praxis?.shutdown();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await database?.onModuleDestroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function journey() {
    const id = await seedSession(database, effects, origin);
    await praxis.executeCommand(id, { kind: "navigate", url: origin });
    expect(launched).toHaveBeenCalledTimes(1);
    return id;
  }
  async function facts(id: string) {
    return (
      await database.query("SELECT * FROM browser_evidence_streams WHERE session_id=$1", [id])
    ).rows[0]!;
  }
  it("finishes a capture stopped before failed publication without reopening or recapturing", async () => {
    const id = await journey();
    const publish = vi
      .spyOn(effects, "completeEvidence")
      .mockRejectedValueOnce(new Error("fixture_publication_unavailable"));
    await expect(praxis.executeCommand(id, { kind: "close" })).rejects.toThrow(
      "fixture_publication_unavailable",
    );
    const before = await facts(id);
    expect(before).toMatchObject({
      state: "open",
      capture_stopped_at: expect.any(Date),
      capture_complete: true,
      interruptions: 0,
    });
    expect(await praxis.executeCommand(id, { kind: "close" })).toMatchObject({
      closed: true,
      evidenceState: "complete",
    });
    const after = await facts(id);
    expect(after.chain_head).toBe(before.chain_head);
    expect(after.chunk_count).toBe(before.chunk_count);
    expect(after.state).toBe("complete");
    expect(launched).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
  }, 30000);
  it("recovers a committed seal's lost acknowledgment without new ownership or rewriting its artifacts", async () => {
    const id = await journey();
    const original = effects.completeEvidence.bind(effects);
    vi.spyOn(effects, "completeEvidence").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("fixture_seal_ack_lost");
    });
    await expect(praxis.executeCommand(id, { kind: "close" })).rejects.toThrow(
      "fixture_seal_ack_lost",
    );
    const before = await facts(id);
    expect(await praxis.executeCommand(id, { kind: "close" })).toMatchObject({
      evidenceState: "complete",
    });
    expect(await facts(id)).toEqual(before);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM browser_owner_generations WHERE session_id=$1",
          [id],
        )
      ).rows[0]!.n,
    ).toBe(1);
    expect(launched).toHaveBeenCalledTimes(1);
  }, 30000);
  it("retains a recorder failure discovered at native stop across no-browser closure retry", async () => {
    let recording: ChronicleRecording | undefined;
    const create = ChronicleEvidenceSession.prototype.createRecording;
    vi.spyOn(ChronicleEvidenceSession.prototype, "createRecording").mockImplementation(function (
      this: ChronicleEvidenceSession,
      protection: RecordingProtectionPort,
    ) {
      recording = create.call(this, protection);
      return recording;
    });
    const id = await journey();
    const stop = ChronicleEvidenceSession.prototype.stopCapture;
    vi.spyOn(ChronicleEvidenceSession.prototype, "stopCapture").mockImplementationOnce(function (
      this: ChronicleEvidenceSession,
      receipt,
    ) {
      recording!.recordError(
        "recorder_capture_failed",
        new Error("fixture_failure_during_native_stop"),
      );
      return stop.call(this, receipt);
    });
    await expect(praxis.executeCommand(id, { kind: "close" })).rejects.toThrow(
      "SCRY_BROWSER_RECORDER_FAILED",
    );
    expect(await facts(id)).toMatchObject({
      capture_complete: false,
      interruptions: 1,
      state: "open",
    });
    expect(await praxis.executeCommand(id, { kind: "close_for_failure" })).toMatchObject({
      evidenceState: "incomplete",
    });
    const owner = (await commands.sessionContext(id)).ownerGeneration;
    await expect(effects.finalizeSession(id, owner)).rejects.toThrow("EVIDENCE_INCOMPLETE");
    await effects.finalizeFailedSession(id, owner);
    expect(await facts(id)).toMatchObject({
      capture_complete: false,
      state: "incomplete",
      completed_at: null,
    });
    expect(launched).toHaveBeenCalledTimes(1);
  }, 30000);
  it("seals an abandoned admitted prefix as incomplete without starting a replacement browser", async () => {
    const id = await journey();
    await praxis.shutdown();
    praxis = composePraxisExecutionPort(commands, effects);
    expect(await praxis.executeCommand(id, { kind: "close_for_failure" })).toMatchObject({
      evidenceState: "incomplete",
    });
    expect(await facts(id)).toMatchObject({
      state: "incomplete",
      interruptions: 1,
      capture_stopped_at: null,
    });
    expect(launched).toHaveBeenCalledTimes(1);
  }, 30000);
  it("records unavailable zero-chunk closure without inventing a browser journey", async () => {
    const id = await seedSession(database, effects, origin);
    expect(await praxis.executeCommand(id, { kind: "close_for_failure" })).toMatchObject({
      evidenceState: "incomplete",
    });
    expect(await facts(id)).toMatchObject({
      state: "incomplete",
      chunk_count: 0,
      chain_head: null,
      capture_started_at: null,
      capture_stopped_at: null,
      completed_at: null,
    });
    expect(launched).not.toHaveBeenCalled();
  }, 30000);
});
