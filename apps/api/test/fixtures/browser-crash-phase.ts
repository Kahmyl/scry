import { randomUUID } from "node:crypto";

import { BrowserCommandRepository } from "../../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../../src/browser-execution/protected-value-cipher.js";
import { Database } from "../../src/infrastructure/database.js";

const phase = process.argv[2];
const encoded = process.argv[3];
if (!phase || !encoded) throw new Error("crash_phase_arguments_required");
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
  string,
  unknown
>;
const database = new Database();
const cipher = new BrowserProtectedValueCipher();
const effects = new BrowserExecutionRepository(database, cipher);
const commands = new BrowserCommandRepository(database, cipher);
let backendPid: number | undefined;

if (phase === "before_dispatch") {
  await effects.admitEffect(
    input.effect as Parameters<BrowserExecutionRepository["admitEffect"]>[0],
  );
} else if (phase === "after_provider_receipt") {
  // The provider may have received the request, but no owned response capture is
  // durable. The authoritative effect must remain started until owner recovery
  // converts it to UNKNOWN; this process intentionally records no false ACK.
} else if (phase === "after_capture_commit") {
  const capture = input.capture as Record<string, unknown>;
  const serializedPayload = capture.encryptedPayload as
    { type?: string; data?: number[] } | undefined;
  if (serializedPayload?.type === "Buffer" && Array.isArray(serializedPayload.data)) {
    capture.encryptedPayload = Buffer.from(serializedPayload.data);
  }
  await effects.registerCapture(
    capture as unknown as Parameters<BrowserExecutionRepository["registerCapture"]>[0],
  );
} else if (phase === "during_publication") {
  const client = await database.pool.connect();
  await client.query("BEGIN");
  backendPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  await client.query("SELECT id FROM browser_captures WHERE id=$1 FOR UPDATE", [input.captureId]);
  await client.query(
    `INSERT INTO browser_publications(
       id,capture_id,effect_id,session_id,selection_digest,decision_set_digest,output_count)
     VALUES($1,$2,$3,$4,$5,$5,1)`,
    [randomUUID(), input.captureId, input.effectId, input.sessionId, input.selectionDigest],
  );
} else if (phase === "before_continuation_ack") {
  const claimed = await commands.claim(String(input.commandId), 30_000);
  if (!claimed?.claim_token) throw new Error("crash_phase_command_claim_failed");
} else {
  throw new Error(`unknown_crash_phase:${phase}`);
}

if (backendPid === undefined) {
  backendPid = (await database.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
    .pid;
}
process.stdout.write(`READY:${phase}:${backendPid}\n`);
await new Promise<never>(() => undefined);
