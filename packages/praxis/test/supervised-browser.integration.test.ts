import { performance } from "node:perf_hooks";
import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupervisedBrowser } from "../src/supervised-browser.js";
import { ExecutionSupervision } from "../src/execution-supervision.js";
import { CommandAttempt } from "../src/command-lane.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
const live = process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
const cleanup = new Set<SupervisedBrowser>();
afterEach(async () => {
  await Promise.allSettled([...cleanup].map((browser) => browser.terminate()));
  cleanup.clear();
  vi.restoreAllMocks();
});
async function fixture() {
  const control = new ExecutionSupervision();
  const unconfirmed = vi.fn();
  let ownerDeadline = performance.now() + 60000,
    ownerRevision = 0;
  const owned = await SupervisedBrowser.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chromium",
    onUnconfirmedStop: unconfirmed,
    sampleAuthority: () => ({
      owner: {
        revision: ownerRevision,
        remainingMs: Math.max(0, Math.floor(ownerDeadline - performance.now())),
      },
      command: control.sample(),
    }),
  });
  cleanup.add(owned);
  const context = await owned.browser.newContext(),
    page = await context.newPage();
  await page.setContent("<button onclick='this.textContent=\"Clicked\"'>Ready</button>");
  await owned.completeSetup();
  return {
    owned,
    control,
    page,
    unconfirmed,
    renew: (ms: number, revision = true) => {
      ownerDeadline = performance.now() + ms;
      if (revision) ownerRevision++;
    },
  };
}
live("independent native browser custodian", () => {
  it("stops native activity at the phase deadline while the controller loop is blocked, unlike the healthy control", async () => {
    const results: Array<{ gap: number; stopped: boolean }> = [];
    for (const shortPhase of [false, true]) {
      const metrics = new BigInt64Array(new SharedArrayBuffer(16));
      const witness = new Worker(
        new URL("./fixtures/native-browser-witness.mjs", import.meta.url),
        { workerData: { metrics: metrics.buffer }, execArgv: [] },
      );
      const origin = await new Promise<string>((resolve, reject) => {
        witness.once("message", (value) => resolve(value.origin));
        witness.once("error", reject);
      });
      const { owned, control, page } = await fixture();
      try {
        await page.goto(origin, { timeout: 5000 });
        await expect
          .poll(() => Number(Atomics.load(metrics, 0)), { timeout: 3000 })
          .toBeGreaterThanOrEqual(3);
        await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
          control.begin(attempt);
          const token = control.enterPhase(shortPhase ? 250 : 3000);
          await owned.synchronize();
          const until = performance.now() + 650;
          while (performance.now() < until) {
            /* deliberate controller-only stall */
          }
          const ended = Date.now();
          const gap = ended - Number(Atomics.load(metrics, 1));
          if (shortPhase) {
            await expect.poll(() => owned.exitConfirmed, { timeout: 2000 }).toBe(true);
            expect(() => control.leavePhase(token)).toThrow("PHASE_EXPIRED");
            control.finish(true);
          } else {
            control.leavePhase(token);
            await owned.synchronize();
            control.finish();
            await owned.synchronize();
          }
          results.push({ gap, stopped: owned.exitConfirmed });
        });
      } finally {
        witness.postMessage("stop");
        await witness.terminate();
        await owned.terminate();
      }
    }
    expect(results[0]!.stopped).toBe(false);
    expect(results[0]!.gap).toBeLessThan(200);
    expect(results[1]!.stopped).toBe(true);
    expect(results[1]!.gap).toBeGreaterThan(250);
  }, 20000);
  it("executes sequential native commands with exact phase acknowledgments and positive stop proof", async () => {
    const { owned, control, page } = await fixture();
    for (let index = 0; index < 2; index++) {
      await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
        control.begin(attempt);
        await owned.synchronize();
        const phase = control.enterPhase(2000);
        await owned.synchronize();
        await page.locator("button").click({ timeout: 2000 });
        control.leavePhase(phase);
        await owned.synchronize();
        control.finish();
        await owned.synchronize();
      });
    }
    expect(await page.locator("button").textContent()).toBe("Clicked");
    const closing = owned.close();
    expect(owned.close()).toBe(closing);
    expect(await closing).toEqual({ exitConfirmed: true, forced: false });
    expect(owned.exitConfirmed).toBe(true);
    expect(owned.terminationState).toBe("exited");
    const options = vi.mocked(fork).mock.calls.at(-1)![2]!;
    expect(Object.keys(options.env!)).not.toContain("DATABASE_URL");
    expect(Object.keys(options.env!)).not.toContain("NODE_OPTIONS");
    expect(options.stdio).toEqual(["ignore", "ignore", "ignore", "ipc"]);
  }, 20000);
  it("keeps owner authority valid only through a new acknowledged renewal revision", async () => {
    const { owned, renew, page } = await fixture();
    renew(800);
    await owned.synchronize();
    await new Promise((resolve) => setTimeout(resolve, 200));
    renew(1500);
    await owned.synchronize();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await page.locator("button").click({ timeout: 1000 });
    expect(owned.exitConfirmed).toBe(false);
    expect((await owned.terminate()).exitConfirmed).toBe(true);
  }, 15000);
  it("does not turn unexpected helper death into an exit-confirmed native receipt", async () => {
    const { owned, unconfirmed } = await fixture();
    const helper = vi.mocked(fork).mock.results.at(-1)!.value;
    const exited = new Promise<void>((resolve) => helper.once("exit", () => resolve()));
    helper.kill("SIGKILL");
    await exited;
    await expect(owned.terminate()).rejects.toThrow(
      /^SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED$/u,
    );
    expect(owned.exitConfirmed).toBe(false);
    expect(owned.terminationState).toBe("unconfirmed");
    expect(unconfirmed).toHaveBeenCalledTimes(1);
  }, 15000);
  it("treats IPC backpressure as unconfirmed containment, never permission to run", async () => {
    const { owned, control } = await fixture();
    const helper = vi.mocked(fork).mock.results.at(-1)!.value;
    vi.spyOn(helper, "send").mockReturnValue(false);
    await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
      control.begin(attempt);
      await expect(owned.synchronize()).rejects.toThrow("TERMINATION_UNCONFIRMED");
      control.finish();
    });
    await expect(owned.terminate()).rejects.toThrow("TERMINATION_UNCONFIRMED");
    expect(owned.exitConfirmed).toBe(false);
  }, 15000);
  it("contains a stalled custodian from the still-responsive controller without inventing native exit", async () => {
    const { owned, unconfirmed } = await fixture();
    const helper = vi.mocked(fork).mock.results.at(-1)!.value;
    try {
      helper.kill("SIGSTOP");
      await expect.poll(() => unconfirmed.mock.calls.length, { timeout: 2800 }).toBe(1);
      expect(owned.exitConfirmed).toBe(false);
      await expect(owned.terminate()).rejects.toThrow("TERMINATION_UNCONFIRMED");
    } finally {
      helper.kill("SIGCONT");
      await owned.terminate().catch(() => undefined);
    }
  }, 10000);
  it("does not renew a short admitted owner deadline through repeated same-revision replies", async () => {
    const { owned, renew } = await fixture();
    renew(350);
    await owned.synchronize();
    const growing = setInterval(() => renew(1500, false), 30);
    try {
      await expect.poll(() => owned.exitConfirmed, { timeout: 1500 }).toBe(true);
    } finally {
      clearInterval(growing);
    }
    expect((await owned.close()).exitConfirmed).toBe(true);
  }, 15000);
});
