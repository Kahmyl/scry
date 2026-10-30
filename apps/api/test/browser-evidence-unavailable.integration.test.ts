import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PraxisExecutionPort } from "@scry/contracts";
import { EvidenceCipher } from "@scry/veil";
import { AdmittedEvidenceReader, ChronicleRepository } from "@scry/chronicle";
import { SupervisedBrowser } from "../../../packages/praxis/src/supervised-browser.js";
import { composePraxisExecutionPort } from "../src/browser-execution/browser-boundary-composition.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";

const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
live("honest unavailable stopped evidence closure", () => {
  const server = createServer((_request, response) =>
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        "<!doctype html><main><h1>Original application</h1><p>Fictional availability journey.</p></main>",
      ),
  );
  let database: Database, effects: BrowserExecutionRepository, commands: BrowserCommandRepository;
  let praxis: PraxisExecutionPort, origin: string, root: string;
  let launched: import("vitest").MockInstance<typeof SupervisedBrowser.launch>;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_address_missing");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    root = await mkdtemp(path.join(os.tmpdir(), "scry-unavailable-closure-"));
    process.env.SCRY_BROWSER_ARTIFACT_ROOT = root;
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    effects = new BrowserExecutionRepository(database, cipher);
    commands = new BrowserCommandRepository(database, cipher);
  });
  beforeEach(() => {
    process.env.SCRY_BROWSER_RENDER_VIDEO = "false";
    praxis = composePraxisExecutionPort(commands, effects);
    launched = vi.spyOn(SupervisedBrowser, "launch");
  });
  afterEach(async () => {
    await praxis?.shutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await database?.onModuleDestroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function facts(id: string) {
    return (
      await database.query("SELECT * FROM browser_evidence_streams WHERE session_id=$1", [id])
    ).rows[0]!;
  }
  async function stoppedJourney() {
    const id = await seedSession(database, effects, origin);
    await praxis.executeCommand(id, { kind: "navigate", url: origin });
    vi.spyOn(effects, "completeEvidence").mockRejectedValueOnce(new Error("fixture_before_seal"));
    await expect(praxis.executeCommand(id, { kind: "close" })).rejects.toThrow(
      "fixture_before_seal",
    );
    const before = await facts(id);
    expect(before).toMatchObject({
      state: "open",
      capture_complete: true,
      capture_stopped_at: expect.any(Date),
    });
    expect(before.chunk_count).toBeGreaterThan(0);
    return { id, before };
  }
  async function assertFailedClosure(id: string, before: Record<string, unknown>, issue: string) {
    expect(await praxis.executeCommand(id, { kind: "close_for_failure" })).toMatchObject({
      closed: true,
      evidenceState: "incomplete",
      evidenceIssue: issue,
    });
    const after = await facts(id);
    expect(after).toMatchObject({
      state: "incomplete",
      closure_issue: issue,
      completed_at: null,
      chain_head: before.chain_head,
      chunk_count: before.chunk_count,
      total_bytes: before.total_bytes,
    });
    expect(after.sealed_at).toBeInstanceOf(Date);
    const owner = (await commands.sessionContext(id)).ownerGeneration;
    await expect(effects.finalizeSession(id, owner)).rejects.toThrow("EVIDENCE_INCOMPLETE");
    await effects.finalizeFailedSession(id, owner);
    const scope = await commands.sessionContext(id);
    expect(
      await new ChronicleRepository(database).missionEvidenceCoverage(scope.missionId),
    ).toMatchObject({ incomplete: 1, unavailable: 1, complete: 0 });
    await expect(
      new ChronicleRepository(database).missionEvidenceDigest(scope.missionId),
    ).rejects.toThrow("MISSION_EVIDENCE_INCOMPLETE");
    expect(launched).toHaveBeenCalledTimes(1);
    return after;
  }
  it.each(["missing", "tampered", "wrong_key", "missing_key"] as const)(
    "terminalizes %s admitted content without fabricating replay or reopening the application",
    async (mode) => {
      const { id, before } = await stoppedJourney();
      const receipt = (
        await database.query(
          "SELECT c.object_key FROM browser_evidence_chunks c JOIN browser_evidence_streams s ON s.id=c.stream_id WHERE s.session_id=$1 ORDER BY c.chunk_index LIMIT 1",
          [id],
        )
      ).rows[0]!;
      const filename = path.join(root, id, "evidence", receipt.object_key as string);
      if (mode === "missing") await rename(filename, `${filename}.fixture-held`);
      else if (mode === "tampered")
        await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from(" ")]));
      else if (mode === "wrong_key")
        vi.spyOn(EvidenceCipher.prototype, "decryptCompressed").mockImplementation(() => {
          throw new Error("evidence_chunk_authentication_invalid");
        });
      else {
        for (const name of [
          "SCRY_BROWSER_PROTECTED_KEY_BASE64",
          "BROWSER_V2_PROTECTED_KEY_BASE64",
          "SCRY_BROWSER_PROTECTED_KEYS_JSON",
          "BROWSER_V2_PROTECTED_KEYS_JSON",
        ])
          vi.stubEnv(name, "");
      }
      const issue =
        mode === "missing"
          ? "object_unavailable"
          : mode === "tampered"
            ? "integrity_mismatch"
            : "content_unverifiable";
      const after = await assertFailedClosure(id, before, issue);
      expect(after.replay_artifact_key).toBeNull();
      expect(after.video_artifact_key).toBeNull();
    },
    30000,
  );
  it("retains admitted metadata but terminalizes a missing native video as unavailable", async () => {
    const { id, before } = await stoppedJourney();
    const directory = path.join(root, id, "native");
    const files = await readdir(directory, { recursive: true });
    const video = files.find((file) => file.endsWith(".webm"));
    expect(video).toBeTruthy();
    const filename = path.join(directory, video!);
    await rename(filename, `${filename}.fixture-held`);
    const after = await assertFailedClosure(id, before, "object_unavailable");
    expect(after.replay_artifact_key).toBeNull();
    expect(after.video_artifact_key).toBeNull();
  }, 30000);
  it("unavailable SQL metadata cannot substitute for stopped or interrupted capture proof", async () => {
    const id = await seedSession(database, effects, origin);
    const scope = await commands.sessionContext(id);
    const claim = await effects.claimOwner(id, "fixture_no_native_browser", 60000);
    const owner = { sessionId: id, generation: claim.generation, leaseToken: claim.leaseToken };
    try {
      await effects.openEvidenceStream(owner, scope.runId);
      await effects.startEvidenceCapture(owner);
      await expect(
        effects.completeEvidence(owner, {
          sessionId: id,
          runId: scope.runId,
          state: "incomplete",
          chainHead: null,
          chunkCount: 0,
          totalBytes: 0,
          issue: "object_unavailable",
        }),
      ).rejects.toThrow("EVIDENCE_COMPLETION_INVALID");
      await expect(
        database.query(
          "UPDATE browser_evidence_streams SET state='incomplete',sealed_at=clock_timestamp(),closure_issue='object_unavailable' WHERE session_id=$1",
          [id],
        ),
      ).rejects.toThrow("evidence_closure_proof_shape");
      expect(await facts(id)).toMatchObject({
        state: "open",
        sealed_at: null,
        closure_issue: null,
      });
    } finally {
      // This relational fixture created no browser or recorder to drain.
      await effects.retireOwner({ owner, browserStopped: true, recordingDrained: true });
    }
  });
  async function holdFirstObject(id: string) {
    const object = (
      await database.query(
        "SELECT c.object_key FROM browser_evidence_chunks c JOIN browser_evidence_streams s ON s.id=c.stream_id WHERE s.session_id=$1 ORDER BY c.chunk_index LIMIT 1",
        [id],
      )
    ).rows[0]!;
    const filename = path.join(root, id, "evidence", object.object_key as string);
    await rename(filename, `${filename}.fixture-held`);
  }
  it("normal close does not downgrade missing content into a failed evidence seal", async () => {
    const { id } = await stoppedJourney();
    await holdFirstObject(id);
    await expect(praxis.executeCommand(id, { kind: "close" })).rejects.toMatchObject({
      issue: "object_unavailable",
    });
    expect(await facts(id)).toMatchObject({ state: "open", sealed_at: null, closure_issue: null });
    expect(launched).toHaveBeenCalledTimes(1);
  }, 30000);
  it("does not retrieve application secrets or construct a capture vault to recover stopped evidence", async () => {
    const { id, before } = await stoppedJourney();
    vi.spyOn(commands, "protectedValuesForSession").mockRejectedValue(
      new Error("fixture_forbidden_application_secret_read"),
    );
    vi.spyOn(commands, "publicValuesForSession").mockRejectedValue(
      new Error("fixture_forbidden_application_value_read"),
    );
    expect(await praxis.executeCommand(id, { kind: "close" })).toMatchObject({
      closed: true,
      evidenceState: "complete",
    });
    expect(await facts(id)).toMatchObject({
      chain_head: before.chain_head,
      state: "complete",
      closure_issue: null,
    });
    expect(commands.protectedValuesForSession).not.toHaveBeenCalled();
    expect(commands.publicValuesForSession).not.toHaveBeenCalled();
    expect(launched).toHaveBeenCalledTimes(1);
  }, 30000);
  it("does not convert a lost owner into artifact availability or seal after admission refuses", async () => {
    const { id } = await stoppedJourney();
    const original = AdmittedEvidenceReader.prototype.verify;
    vi.spyOn(AdmittedEvidenceReader.prototype, "verify").mockImplementationOnce(async function (
      this: AdmittedEvidenceReader<unknown>,
    ) {
      try {
        return await original.call(this);
      } finally {
        // Replace the actual durable authority, not an incidental verifier
        // callback formerly called by the retired DOM-rendering path.
        const current = (
          await database.query<{ generation: string; lease_token: string }>(
            "SELECT generation,lease_token FROM browser_owner_generations WHERE session_id=$1 AND state='active' ORDER BY generation DESC LIMIT 1",
            [id],
          )
        ).rows[0]!;
        await effects.retireOwner({
          owner: {
            sessionId: id,
            generation: Number(current.generation),
            leaseToken: current.lease_token,
          },
          browserStopped: true,
          recordingDrained: true,
        });
      }
    });
    await expect(praxis.executeCommand(id, { kind: "close_for_failure" })).rejects.toThrow(
      "SCRY_BROWSER_OWNER_FENCED",
    );
    expect(await facts(id)).toMatchObject({ state: "open", sealed_at: null, closure_issue: null });
  }, 30000);
  it("recovers unavailable seal acknowledgment loss without new ownership or changing the admitted issue", async () => {
    const { id } = await stoppedJourney();
    await holdFirstObject(id);
    const complete = effects.completeEvidence.bind(effects);
    vi.spyOn(effects, "completeEvidence").mockImplementationOnce(async (...args) => {
      await complete(...args);
      throw new Error("fixture_unavailable_seal_ack_lost");
    });
    await expect(praxis.executeCommand(id, { kind: "close_for_failure" })).rejects.toThrow(
      "fixture_unavailable_seal_ack_lost",
    );
    const before = await facts(id);
    const ownersBefore = (
      await database.query(
        "SELECT count(*)::int AS n FROM browser_owner_generations WHERE session_id=$1",
        [id],
      )
    ).rows[0]!.n;
    expect(await praxis.executeCommand(id, { kind: "close_for_failure" })).toMatchObject({
      evidenceState: "incomplete",
      evidenceIssue: "object_unavailable",
    });
    expect(await facts(id)).toEqual(before);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM browser_owner_generations WHERE session_id=$1",
          [id],
        )
      ).rows[0]!.n,
    ).toBe(ownersBefore);
    await expect(
      database.query(
        "UPDATE browser_evidence_streams SET closure_issue='content_unverifiable' WHERE session_id=$1",
        [id],
      ),
    ).rejects.toThrow("evidence_sealed_immutable");
    expect(launched).toHaveBeenCalledTimes(1);
  }, 30000);
});
