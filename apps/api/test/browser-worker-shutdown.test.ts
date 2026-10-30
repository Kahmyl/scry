import { DelayedError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserWorkRegistry,
  createBrowserWorkerShutdown,
  BrowserWorkerShutdownError,
} from "../src/browser-execution/worker-lifecycle.js";

afterEach(() => vi.useRealTimers());
const job = () => ({ moveToDelayed: vi.fn(async () => undefined) });
function fixture() {
  const registry = new BrowserWorkRegistry(),
    events: string[] = [];
  const worker = {
    pause: vi.fn(async () => {
      events.push("pause");
    }),
    close: vi.fn(async () => {
      events.push("transport");
    }),
  };
  const praxis = {
    shutdown: vi.fn(async () => {
      events.push("runtime");
    }),
  };
  const application = vi.fn(async () => {
    events.push("application");
  });
  const shutdown = createBrowserWorkerShutdown({
    registry,
    workers: [worker],
    praxis,
    closeApplication: application,
    budgets: { admission: 100, runtime: 100, commands: 100, transport: 100, application: 100 },
  });
  return { registry, worker, praxis, application, events, shutdown };
}
describe("bounded worker shutdown lifecycle", () => {
  it("stops admission synchronously and shares a single shutdown across signals", async () => {
    const f = fixture(),
      j = job(),
      work = vi.fn(async () => ({ done: true }));
    const first = f.shutdown();
    expect(f.shutdown()).toBe(first);
    await expect(f.registry.run(j, "queue-token", work)).rejects.toBeInstanceOf(DelayedError);
    await first;
    expect(work).not.toHaveBeenCalled();
    expect(j.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "queue-token");
    expect(f.events).toEqual(["pause", "runtime", "transport", "application"]);
    expect(f.worker.pause).toHaveBeenCalledWith(true);
    expect(f.worker.close).toHaveBeenCalledWith(false);
  });
  it("defers work admitted into a JS microtask just before shutdown without invoking it", async () => {
    const f = fixture(),
      work = vi.fn(async () => ({ done: true })),
      pending = f.registry.run(job(), "queue-token", work);
    const refused = expect(pending).rejects.toBeInstanceOf(DelayedError);
    await Promise.all([f.shutdown(), refused]);
    expect(work).not.toHaveBeenCalled();
    expect(f.registry.activeCount).toBe(0);
  });
  it("cancels browser runtime before waiting for an actual processor to settle", async () => {
    const f = fixture();
    let finish!: (value: { interrupted: true }) => void;
    const pending = f.registry.run(
      job(),
      "queue-token",
      () =>
        new Promise<{ interrupted: true }>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    f.praxis.shutdown.mockImplementationOnce(async () => {
      f.events.push("runtime");
      finish({ interrupted: true });
    });
    await f.shutdown();
    expect(await pending).toEqual({ interrupted: true });
    expect(f.registry.activeCount).toBe(0);
    expect(f.events).toEqual(["pause", "runtime", "transport", "application"]);
  });
  it("drains rejected processors without turning their product outcome into shutdown success or retry", async () => {
    const f = fixture();
    const pending = f.registry.run(job(), "queue-token", async () => {
      throw new Error("fixture-native-failure");
    });
    await expect(pending).rejects.toThrow("fixture-native-failure");
    await f.shutdown();
    expect(f.registry.activeCount).toBe(0);
  });
  it.each(["admission", "runtime", "commands", "transport", "application"] as const)(
    "continues containment and reports %s timeout without exposing arbitrary errors",
    async (name) => {
      vi.useFakeTimers();
      const f = fixture(),
        hang = () => new Promise<void>(() => {});
      if (name === "admission") f.worker.pause.mockImplementationOnce(hang);
      if (name === "runtime") f.praxis.shutdown.mockImplementationOnce(hang);
      if (name === "commands") {
        const pending = f.registry.run(job(), "queue-token", hang);
        void pending;
        await Promise.resolve();
      }
      if (name === "transport") f.worker.close.mockImplementationOnce(hang);
      if (name === "application") f.application.mockImplementationOnce(hang);
      const result = f.shutdown().catch((error) => error);
      await vi.advanceTimersByTimeAsync(1000);
      const error = await result;
      expect(error).toBeInstanceOf(BrowserWorkerShutdownError);
      expect(error.phases).toEqual([name]);
      expect(error.message).toBe("SCRY_BROWSER_WORKER_SHUTDOWN_INCOMPLETE");
      expect(f.worker.close).toHaveBeenCalledWith(name === "commands");
      expect(f.application).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("attempts every transport when one pause or close rejects and retains both failed phases", async () => {
    const f = fixture();
    f.worker.pause.mockRejectedValueOnce(new Error("fixture-private-pause"));
    f.worker.close.mockRejectedValueOnce(new Error("fixture-private-close"));
    const extra = { pause: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const shutdown = createBrowserWorkerShutdown({
      registry: f.registry,
      workers: [f.worker, extra],
      praxis: f.praxis,
      closeApplication: f.application,
    });
    const error = await shutdown().catch((error) => error);
    expect(error.phases).toEqual(["admission", "transport"]);
    expect(extra.pause).toHaveBeenCalled();
    expect(extra.close).toHaveBeenCalledWith(false);
    expect(f.application).toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain("fixture-private");
  });
  it("does not treat a fulfilled transport close as clean if the transport emitted an error", async () => {
    const f = fixture();
    f.worker.close.mockImplementationOnce(async () => {
      f.registry.failTransport();
    });
    const error = await f.shutdown().catch((error) => error);
    expect(error).toBeInstanceOf(BrowserWorkerShutdownError);
    expect(error.phases).toEqual(["transport"]);
    expect(f.application).toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity, 30001])(
    "rejects invalid runtime budget %s before starting shutdown",
    (value) => {
      const f = fixture();
      expect(() =>
        createBrowserWorkerShutdown({
          registry: f.registry,
          workers: [f.worker],
          praxis: f.praxis,
          closeApplication: f.application,
          budgets: { runtime: value },
        }),
      ).toThrow("SHUTDOWN_CONFIGURATION_INVALID");
      expect(f.praxis.shutdown).not.toHaveBeenCalled();
    },
  );
  it("refuses a collection of individually finite budgets exceeding the host's total cleanup limit", () => {
    const f = fixture();
    expect(() =>
      createBrowserWorkerShutdown({
        registry: f.registry,
        workers: [f.worker],
        praxis: f.praxis,
        closeApplication: f.application,
        budgets: { runtime: 30000, commands: 20000 },
      }),
    ).toThrow("SHUTDOWN_CONFIGURATION_INVALID");
  });
});
