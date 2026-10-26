import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupervisedBrowser, type BrowserAuthoritySnapshot } from "../src/supervised-browser.js";

const f = vi.hoisted(() => ({ fork: vi.fn(), connect: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: f.fork }));
vi.mock("playwright", () => ({ chromium: { connect: f.connect } }));
class Helper extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: string | null = null;
  sequence = 0;
  automatic = true;
  pending = false;
  refresh = false;
  authorities: Array<Record<string, any>> = [];
  browser = { isConnected: vi.fn(() => true), once: vi.fn() };
  challenge() {
    if (this.pending) {
      this.refresh = true;
      return;
    }
    this.pending = true;
    this.emit("message", { kind: "challenge", challenge: ++this.sequence });
  }
  acknowledge(value: Record<string, any>) {
    this.pending = false;
    this.emit("message", {
      kind: "accepted",
      acknowledgment: {
        challenge: value.challenge,
        commandSequence: value.command.sequence,
        ownerRevision: value.owner.revision,
        phaseSequence: value.command.state === "active" ? value.command.phase.sequence : null,
        claimRevision: value.command.state === "active" ? value.command.claim.revision : null,
      },
    });
    if (this.refresh) {
      this.refresh = false;
      this.challenge();
    }
  }
  stopped() {
    this.emit("message", { kind: "stopped", exitConfirmed: true, forced: true });
  }
  send = vi.fn((value: Record<string, any>, callback?: (error: Error | null) => void) => {
    callback?.(null);
    if (value.kind === "initialize" || value.kind === "challenge_request") this.challenge();
    else if (value.kind === "authority") {
      this.authorities.push(value);
      if (this.automatic) {
        this.acknowledge(value);
        if (this.sequence === 1)
          this.emit("message", {
            kind: "ready",
            endpoint: "ws://127.0.0.1:12345/private-fixture-endpoint",
          });
      }
    } else if (value.kind === "setup_complete") this.emit("message", { kind: "setup_completed" });
    else if (value.kind === "stop") this.stopped();
    else if (value.kind === "receipt_acknowledged") this.exit();
    return true;
  });
  kill = vi.fn(() => {
    this.signalCode = "SIGKILL";
    this.exit();
    return true;
  });
  exit() {
    if (!this.connected) return;
    this.connected = false;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}
let helper: Helper;
beforeEach(() => {
  vi.clearAllMocks();
  helper = new Helper();
  f.fork.mockReturnValue(helper);
  f.connect.mockResolvedValue(helper.browser);
});
const idle = (): BrowserAuthoritySnapshot => ({
  owner: { revision: 0, remainingMs: 60000 },
  command: { state: "idle", sequence: 0 },
});
function active(phase = 0): BrowserAuthoritySnapshot {
  return {
    owner: { revision: 0, remainingMs: 60000 },
    command: {
      state: "active",
      sequence: 1,
      executionRemainingMs: 5000,
      claim: { revision: 0, remainingMs: 5000 },
      phase: { sequence: phase, remainingMs: 1000 },
    },
  };
}
describe("bounded parent custodian transport", () => {
  it("does not serialize callbacks or application environment into the launch control message", async () => {
    const observer = vi.fn();
    const owned = await SupervisedBrowser.launch({
      sampleAuthority: idle,
      onUnconfirmedStop: observer,
      headless: true,
    });
    expect(helper.send.mock.calls[0]![0]).toEqual({
      kind: "initialize",
      options: { headless: true },
    });
    expect(Object.keys(f.fork.mock.calls[0]![2].env)).not.toContain("DATABASE_URL");
    await owned.completeSetup();
    await owned.completeSetup();
    expect(
      helper.send.mock.calls.filter(([value]) => value.kind === "setup_complete"),
    ).toHaveLength(1);
    expect((await owned.close()).exitConfirmed).toBe(true);
    expect(observer).not.toHaveBeenCalled();
  });
  it("does not return a browser whose native stop receipt arrived during client connection", async () => {
    let connect!: (value: typeof helper.browser) => void;
    f.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          connect = resolve;
        }),
    );
    const opening = SupervisedBrowser.launch({ sampleAuthority: idle });
    await Promise.resolve();
    helper.stopped();
    connect(helper.browser);
    await expect(opening).rejects.toThrow("PROCESS_CONNECT_FAILED");
  });
  it("requires a matching phase acknowledgment, not merely a successful send callback", async () => {
    let snapshot = idle();
    const owned = await SupervisedBrowser.launch({ sampleAuthority: () => snapshot });
    helper.automatic = false;
    // An earlier idle heartbeat is already in transport when the command begins.
    helper.challenge();
    const earlier = helper.authorities.at(-1)!;
    snapshot = active(1);
    let done = false;
    const barrier = owned.synchronize().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    helper.acknowledge(earlier);
    await Promise.resolve();
    expect(done).toBe(false);
    helper.acknowledge(helper.authorities.at(-1)!);
    await barrier;
    expect(done).toBe(true);
    await owned.close();
  });
  it("coalesces concurrent phase barriers around the latest complete inventory", async () => {
    let snapshot = idle();
    const owned = await SupervisedBrowser.launch({ sampleAuthority: () => snapshot });
    helper.automatic = false;
    snapshot = active(1);
    const first = owned.synchronize();
    const older = helper.authorities.at(-1)!;
    snapshot = active(2);
    const second = owned.synchronize();
    expect(first).toBe(second);
    let done = false;
    void first.then(() => {
      done = true;
    });
    helper.acknowledge(older);
    await Promise.resolve();
    expect(done).toBe(false);
    helper.acknowledge(helper.authorities.at(-1)!);
    await second;
    expect(done).toBe(true);
    await owned.close();
  });
  it.each([null, {}, { kind: "ready", endpoint: "ws://0.0.0.0:1/private-canary" }])(
    "contains malformed helper traffic without leaking values: %j",
    async (value) => {
      const observer = vi.fn();
      const owned = await SupervisedBrowser.launch({
        sampleAuthority: idle,
        onUnconfirmedStop: observer,
      });
      helper.emit("message", value);
      await expect(owned.close()).rejects.toThrow(
        /^SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED$/u,
      );
      expect(owned.exitConfirmed).toBe(false);
      await Promise.resolve();
      expect(observer).toHaveBeenCalledTimes(1);
    },
  );
  it("cannot use a previous acknowledgment after independent native stop", async () => {
    const owned = await SupervisedBrowser.launch({ sampleAuthority: idle });
    helper.stopped();
    await expect(owned.synchronize()).rejects.toThrow("OWNER_FENCED");
    expect((await owned.close()).exitConfirmed).toBe(true);
  });
  it("rejects a pending dispatch as fenced, not unconfirmed, when positive native stop arrives", async () => {
    let snapshot = idle();
    const observer = vi.fn();
    const owned = await SupervisedBrowser.launch({
      sampleAuthority: () => snapshot,
      onUnconfirmedStop: observer,
    });
    helper.automatic = false;
    snapshot = active(1);
    const barrier = owned.synchronize();
    helper.stopped();
    await expect(barrier).rejects.toThrow("SCRY_BROWSER_OWNER_FENCED");
    expect((await owned.close()).exitConfirmed).toBe(true);
    expect(observer).not.toHaveBeenCalled();
  });
  it("preserves unconfirmed classification when a pending dispatch loses the helper without native proof", async () => {
    let snapshot = idle();
    const observer = vi.fn();
    const owned = await SupervisedBrowser.launch({
      sampleAuthority: () => snapshot,
      onUnconfirmedStop: observer,
    });
    helper.automatic = false;
    snapshot = active(1);
    const barrier = owned.synchronize();
    helper.exit();
    await expect(barrier).rejects.toThrow("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
    await expect(owned.close()).rejects.toThrow("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
    await Promise.resolve();
    expect(observer).toHaveBeenCalledTimes(1);
  });
  it("classifies refused authority as fenced after terminate returns confirmed native exit", async () => {
    let available = true;
    const observer = vi.fn();
    const owned = await SupervisedBrowser.launch({
      sampleAuthority: () => {
        if (!available) throw new Error("SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED");
        return idle();
      },
      onUnconfirmedStop: observer,
    });
    available = false;
    await expect(owned.synchronize()).rejects.toThrow("SCRY_BROWSER_OWNER_FENCED");
    expect((await owned.close()).exitConfirmed).toBe(true);
    expect(observer).not.toHaveBeenCalled();
  });
  it("does not manufacture proof when authority refusal is followed by helper loss", async () => {
    let available = true;
    const owned = await SupervisedBrowser.launch({
      sampleAuthority: () => {
        if (!available) throw new Error("SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED");
        return idle();
      },
    });
    available = false;
    helper.stopped = () => helper.exit();
    await expect(owned.synchronize()).rejects.toThrow(
      "SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED",
    );
    expect(owned.exitConfirmed).toBe(false);
  });
  it.each(["challenge", "commandSequence", "ownerRevision", "phaseSequence", "claimRevision"])(
    "refuses an acknowledgment that misstates the sent %s",
    async (field) => {
      const observer = vi.fn();
      const owned = await SupervisedBrowser.launch({
        sampleAuthority: () => active(1),
        onUnconfirmedStop: observer,
      });
      helper.automatic = false;
      helper.challenge();
      const sent = helper.authorities.at(-1)!;
      const ack: Record<string, number> = {
        challenge: sent.challenge,
        commandSequence: 1,
        ownerRevision: 0,
        phaseSequence: 1,
        claimRevision: 0,
      };
      ack[field] = ack[field]! + 1;
      helper.emit("message", { kind: "accepted", acknowledgment: ack });
      await expect(owned.close()).rejects.toThrow("TERMINATION_UNCONFIRMED");
      await Promise.resolve();
      expect(observer).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses overlapping challenges instead of allocating another pending control entry", async () => {
    const owned = await SupervisedBrowser.launch({ sampleAuthority: idle });
    helper.automatic = false;
    helper.challenge();
    helper.emit("message", { kind: "challenge", challenge: helper.sequence + 1 });
    await expect(owned.close()).rejects.toThrow("TERMINATION_UNCONFIRMED");
  });
  it.each([0, -1, NaN, Infinity, 120001])(
    "refuses invalid launch budget %s before forking",
    async (launchTimeoutMs) => {
      await expect(
        SupervisedBrowser.launch({ sampleAuthority: idle, launchTimeoutMs }),
      ).rejects.toThrow("CONFIGURATION_INVALID");
      expect(f.fork).not.toHaveBeenCalled();
    },
  );
});
