import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChronicleEvidenceService } from "@scry/chronicle";
import { EvidenceCipher } from "@scry/veil";
import { PraxisOwnerLease } from "../../../../packages/praxis/src/owner-lease.js";
import type { BrowserExecutionRepository } from "../../src/browser-execution/repositories/browser-execution.repository.js";
import type { Database } from "../../src/infrastructure/database.js";

/** Relational lifecycle fixture, not a live-browser acceptance claim. A fictional
 * event is encrypted, staged, admitted and sealed by the actual custody code.
 * No browser is created, so the fixture's native stop receipt is trivially true. */
export async function publishFixtureEvidence(
  database: Database,
  effects: BrowserExecutionRepository,
  sessionId: string,
  generation: number,
  incomplete = false,
  stopReceipt: { recordingComplete?: boolean } = {},
) {
  const row = (
    await database.query<{ run_id: string; lease_token: string }>(
      `SELECT s.run_id,o.lease_token FROM browser_execution_sessions s JOIN browser_owner_generations o ON o.session_id=s.id
      WHERE s.id=$1 AND o.generation=$2 AND o.state='active'`,
      [sessionId, generation],
    )
  ).rows[0];
  if (!row) throw new Error("fixture_owner_missing");
  const owner = { sessionId, generation, leaseToken: row.lease_token };
  const sample = await effects.heartbeatOwner(sessionId, generation, row.lease_token, 60000);
  const lease = new PraxisOwnerLease(owner, effects, sample);
  try {
    const evidence = await new ChronicleEvidenceService({
      render: async () => {
        throw new Error("fixture_render_unused");
      },
    }).openSession({
      root: await mkdtemp(path.join(os.tmpdir(), "scry-relational-evidence-")),
      sessionId,
      runId: row.run_id,
      protection: new EvidenceCipher(randomBytes(32)),
      admission: lease,
      maxSessionBytes: 1048576,
    });
    const recording = evidence.createRecording({ snapshot: () => (value) => value });
    if (!incomplete) {
      await evidence.startCapture();
      recording.receive('{"fixture":"relational_lifecycle","timestamp":1000}');
    }
    await evidence.prepareClosure();
    await evidence.stopCapture({ browserStopped: true, recordingDrained: true, ...stopReceipt });
    const completion = await evidence.seal({ renderVideo: false, actionLedger: async () => [] });
    await effects.completeEvidence(owner, completion);
    return completion;
  } finally {
    lease.revoke();
  }
}
