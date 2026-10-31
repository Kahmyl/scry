// Experiment only. The production durable command store remains authoritative.
// The executor may call official Playwright/MCP; this layer owns no app selectors.
import { createHash } from "node:crypto";
export class InteractionLifecycle {
  #receipts = new Map();
  #active = null;
  constructor({ capacity = 128 } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw Error("Positive receipt capacity required");
    this.capacity = capacity;
  }
  get size() {
    return this.#receipts.size;
  }
  get busy() {
    return this.#active !== null;
  }
  get(id) {
    return structuredClone(this.#receipts.get(id)?.receipt);
  }
  async run({ id, intent, prepare, execute, observe, deadlineMs = 1000 }) {
    const fingerprint = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
    const previous = this.#receipts.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return { status: "identity_conflict", dispatched: false };
      return structuredClone(previous.receipt);
    }
    if (this.#active) return { status: "session_busy", dispatched: false };
    if (this.#receipts.size >= this.capacity)
      return { status: "capacity_exhausted", dispatched: false };
    const receipt = {
      id,
      status: "preparing",
      dispatched: false,
      execution: "not_started",
      observation: "not_checked",
    };
    const record = { fingerprint, receipt };
    this.#receipts.set(id, record);
    this.#active = record;
    // This promise remains owned after the caller's deadline. It is not abandoned
    // or treated as cancelled; another mutation cannot interleave with it.
    record.settled = (async () => {
      try {
        if (!(await prepare())) {
          receipt.status = "not_dispatched";
          return;
        }
        receipt.dispatched = true;
        receipt.execution = "in_flight";
        receipt.status = "running";
        try {
          await execute();
          receipt.execution = "completed";
        } catch {
          receipt.execution = "error_after_possible_dispatch";
        }
        // Observation has an independent bounded implementation. False/missing
        // proof is not proof that replay is safe. No alternative is auto-run.
        try {
          const evidence = await observe();
          receipt.observation =
            evidence === "matched"
              ? "matched"
              : evidence === "mismatch"
                ? "mismatch"
                : "inconclusive";
          receipt.status =
            evidence === "matched"
              ? "verified"
              : evidence === "mismatch"
                ? "failed_expected_condition"
                : "needs_inspection";
        } catch {
          receipt.observation = "unavailable";
          receipt.status = "needs_inspection";
        }
      } catch {
        receipt.status = receipt.dispatched ? "needs_inspection" : "not_dispatched";
      } finally {
        if (this.#active === record) this.#active = null;
      }
    })();
    let timer;
    await Promise.race([
      record.settled,
      new Promise((r) => {
        timer = setTimeout(r, deadlineMs);
      }),
    ]);
    clearTimeout(timer);
    if (this.#active === record)
      receipt.status = receipt.dispatched ? "pending_after_deadline" : "preparing_after_deadline";
    // Return a snapshot; historical responses must not mutate when work settles.
    return structuredClone(receipt);
  }
  async settled(id) {
    await this.#receipts.get(id)?.settled;
    return structuredClone(this.get(id));
  }
  async reconcile(id, observe) {
    const record = this.#receipts.get(id);
    if (!record || this.#active) return { status: "inspection_not_available" };
    if (!record.receipt.dispatched) return structuredClone(record.receipt);
    // The caller supplies a read-only proof; this API cannot execute an action.
    const inspection = {};
    this.#active = inspection;
    try {
      const evidence = await observe();
      record.receipt.observation =
        evidence === "matched" ? "matched" : evidence === "mismatch" ? "mismatch" : "inconclusive";
      record.receipt.status =
        evidence === "matched"
          ? "verified"
          : evidence === "mismatch"
            ? "failed_expected_condition"
            : "needs_inspection";
      return structuredClone(record.receipt);
    } finally {
      if (this.#active === inspection) this.#active = null;
    }
  }
}
