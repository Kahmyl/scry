import "reflect-metadata";
import type { PoolClient } from "pg";
import { AuthenticatedEvidenceStore } from "@scry/chronicle";
import { EvidenceCipher } from "@scry/veil";
import { PraxisOwnerLease } from "../../../../packages/praxis/src/owner-lease.js";
import { BrowserExecutionRepository } from "../../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../../src/browser-execution/protected-value-cipher.js";
import { Database } from "../../src/infrastructure/database.js";

type Input = {
  point: "before_admission" | "before_commit" | "after_admission";
  owner: { sessionId: string; generation: number; leaseToken: string };
  runId: string;
  directory: string;
  key: string;
};
async function hold(): Promise<never> {
  process.send?.({ phase: "ready" });
  return new Promise<never>(() => undefined);
}
process.once("message", (input: Input) => {
  void (async () => {
    const database = new Database();
    const effects = new BrowserExecutionRepository(database, new BrowserProtectedValueCipher());
    // Sample in THIS process. A parent's performance.now origin is not a lease.
    const sample = await effects.heartbeatOwner(
      input.owner.sessionId,
      input.owner.generation,
      input.owner.leaseToken,
      60000,
    );
    const lease = new PraxisOwnerLease(input.owner, effects, sample);
    let admitting = false;
    const transaction = database.transaction.bind(database);
    database.transaction = <T>(work: (client: PoolClient) => Promise<T>): Promise<T> =>
      transaction(async (client) => {
        const result = await work(client);
        if (admitting && input.point === "before_commit") await hold();
        return result;
      });
    const admit = lease.admitChunk.bind(lease);
    lease.admitChunk = async (receipt) => {
      if (input.point === "before_admission") await hold();
      admitting = true;
      try {
        await admit(receipt);
        if (input.point === "after_admission") await hold();
      } finally {
        admitting = false;
      }
    };
    const store = await new AuthenticatedEvidenceStore({
      directory: input.directory,
      runId: input.runId,
      scopeId: input.owner.sessionId,
      admission: lease,
      protection: new EvidenceCipher(Buffer.from(input.key, "base64")),
    }).initialize();
    await store.append({ fixture: "actual_process_crash_protected_event" });
    await store.flush();
    throw new Error("fixture_crash_point_not_reached");
  })().catch(() => {
    process.send?.({ phase: "failed" });
    process.exitCode = 1;
    process.disconnect();
  });
});
