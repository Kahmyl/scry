import { DelayedError, type Job, type Worker } from "bullmq";
import type { PraxisExecutionPort } from "@scry/contracts";

type QueueJob = Pick<Job, "moveToDelayed">;

/** One-way admission stop with accounting for actual processors. Shutdown does
 * not depend on BullMQ's private active-job APIs or start an un-escalatable
 * graceful Worker.close before browser cancellation has happened. */
export class BrowserWorkRegistry {
  #accepting = true;
  #transportFailed = false;
  readonly #active = new Set<Promise<unknown>>();

  run<T>(job: QueueJob, token: string | undefined, work: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(async () => {
      if (!this.#accepting) {
        await job.moveToDelayed(Date.now() + 1000, token);
        throw new DelayedError();
      }
      return work();
    });
    this.#active.add(operation);
    void operation.then(
      () => this.#active.delete(operation),
      () => this.#active.delete(operation),
    );
    return operation;
  }

  stop(): void {
    this.#accepting = false;
  }
  failTransport(): void {
    this.#transportFailed = true;
    this.stop();
  }
  get transportFailed(): boolean {
    return this.#transportFailed;
  }
  get activeCount(): number {
    return this.#active.size;
  }
  async drain(): Promise<void> {
    while (this.#active.size) await Promise.allSettled([...this.#active]);
  }
}

export type ShutdownPhase = "admission" | "runtime" | "commands" | "transport" | "application";
const defaults: Readonly<Record<ShutdownPhase, number>> = Object.freeze({
  admission: 1000,
  runtime: 25000,
  commands: 5000,
  transport: 5000,
  application: 5000,
});

export class BrowserWorkerShutdownError extends Error {
  readonly phases: readonly ShutdownPhase[];
  constructor(phases: readonly ShutdownPhase[]) {
    super("SCRY_BROWSER_WORKER_SHUTDOWN_INCOMPLETE");
    this.phases = Object.freeze([...phases]);
  }
}

export interface BrowserWorkerShutdownOptions {
  registry: BrowserWorkRegistry;
  workers: readonly Pick<Worker, "pause" | "close">[];
  praxis: Pick<PraxisExecutionPort, "shutdown">;
  closeApplication: () => Promise<void>;
  /** Internal validated test/host budgets, not customer command extensions. */
  budgets?: Partial<Readonly<Record<ShutdownPhase, number>>>;
}

/** Scheduled cleanup budgets total at most 50s, within the deployment's 60s
 * external termination grace (the backstop for an unresponsive event loop).
 * A timeout is an incomplete shutdown, never a successful cancellation receipt.
 * The host must exit nonzero on rejection, allowing its process namespace to be
 * terminated rather than reusing this worker after unconfirmed containment.
 */
export function createBrowserWorkerShutdown(
  options: BrowserWorkerShutdownOptions,
): () => Promise<void> {
  const budgets = { ...defaults, ...options.budgets };
  const values = Object.values(budgets);
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > 30000) ||
    values.reduce((total, value) => total + value, 0) > 50000
  )
    throw new Error("SCRY_BROWSER_WORKER_SHUTDOWN_CONFIGURATION_INVALID");
  let operation: Promise<void> | undefined;
  return () => {
    if (operation) return operation;
    // Synchronous admission stop also covers work queued in a JS microtask.
    options.registry.stop();
    operation = Promise.resolve().then(async () => {
      const failures: ShutdownPhase[] = [];
      const phase = async (name: ShutdownPhase, work: () => Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(work),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("phase_timeout")), budgets[name]);
            }),
          ]);
          return true;
        } catch {
          failures.push(name);
          return false;
        } finally {
          clearTimeout(timer);
        }
      };
      const all = async (work: () => Promise<unknown>[]) => {
        const outcomes = await Promise.allSettled(work());
        if (outcomes.some((outcome) => outcome.status === "rejected"))
          throw new Error("phase_failed");
      };
      await phase("admission", () =>
        all(() =>
          options.workers.map((worker) => Promise.resolve().then(() => worker.pause(true))),
        ),
      );
      await phase("runtime", () => options.praxis.shutdown());
      const drained = await phase("commands", () => options.registry.drain());
      // Preserve BullMQ's own final job acknowledgement after processors drain.
      // If drain failed, choose force on the FIRST close call. A graceful close
      // cannot later be escalated via this public API. A stuck graceful transport
      // is an incomplete shutdown; app cleanup and nonzero host exit remain.
      await phase("transport", () =>
        all(() =>
          options.workers.map((worker) => Promise.resolve().then(() => worker.close(!drained))),
        ),
      );
      await phase("application", options.closeApplication);
      // BullMQ may emit an error while fulfilling close(). The host's error
      // listener records that failure here; a fulfilled close is not a waiver.
      if (options.registry.transportFailed && !failures.includes("transport"))
        failures.push("transport");
      if (failures.length) throw new BrowserWorkerShutdownError(failures);
    });
    return operation;
  };
}
