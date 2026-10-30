import { beforeEach, describe, expect, it, vi } from "vitest";
import { OwnedBrowser } from "../src/owned-browser.js";

const f = vi.hoisted(() => {
  const child = { exitCode: null as number | null, signalCode: null as string | null };
  const browser = {
    isConnected: vi.fn(() => true),
    once: vi.fn((_event: string, _callback: () => void) => undefined),
  };
  const server = {
    process: () => child,
    wsEndpoint: vi.fn(() => "ws://127.0.0.1:4444/private-test-credential"),
    close: vi.fn(async () => {
      child.exitCode = 0;
    }),
    kill: vi.fn(async () => {
      child.signalCode = "SIGKILL";
    }),
  };
  return {
    child,
    browser,
    server,
    launch: vi.fn(async () => server),
    connect: vi.fn(async () => browser),
  };
});
vi.mock("playwright", () => ({ chromium: { launchServer: f.launch, connect: f.connect } }));
beforeEach(() => {
  vi.clearAllMocks();
  f.child.exitCode = null;
  f.child.signalCode = null;
  f.server.close.mockReset().mockImplementation(async () => {
    f.child.exitCode = 0;
  });
  f.server.kill.mockReset().mockImplementation(async () => {
    f.child.signalCode = "SIGKILL";
  });
  f.server.wsEndpoint.mockReset().mockReturnValue("ws://127.0.0.1:4444/private-test-credential");
  f.launch.mockReset().mockResolvedValue(f.server);
  f.connect.mockReset().mockResolvedValue(f.browser);
  f.browser.isConnected.mockReset().mockReturnValue(true);
});
describe("local browser process custody", () => {
  it("binds to loopback with finite launch/connection budgets and shares one close", async () => {
    const owned = await OwnedBrowser.launch();
    expect(f.launch).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 0, timeout: 15000 }),
    );
    expect(f.connect).toHaveBeenCalledWith(f.server.wsEndpoint(), { timeout: 5000 });
    const first = owned.close(),
      second = owned.close();
    expect(first).toBe(second);
    expect(await first).toEqual({ forced: false, exitConfirmed: true });
    expect(owned.exitConfirmed).toBe(true);
    expect(f.server.close).toHaveBeenCalledTimes(1);
    expect(f.server.kill).not.toHaveBeenCalled();
  });
  it("kills when a fulfilled close did not prove process exit", async () => {
    f.server.close.mockImplementationOnce(async () => {});
    const owned = await OwnedBrowser.launch();
    expect(await owned.close()).toEqual({ forced: true, exitConfirmed: true });
    expect(f.server.kill).toHaveBeenCalledTimes(1);
  });
  it("escalates an in-flight stuck close immediately and never duplicates disposal", async () => {
    f.server.close.mockImplementationOnce(() => new Promise(() => {}));
    const owned = await OwnedBrowser.launch({ gracefulCloseMs: 30000 });
    const closing = owned.close();
    await Promise.resolve();
    expect(f.server.close).toHaveBeenCalledTimes(1);
    expect(owned.terminate()).toBe(closing);
    expect(await closing).toEqual({ forced: true, exitConfirmed: true });
    expect(f.server.kill).toHaveBeenCalledTimes(1);
  });
  it("forces cancellation without a graceful close", async () => {
    const owned = await OwnedBrowser.launch();
    expect(await owned.terminate()).toEqual({ forced: true, exitConfirmed: true });
    expect(f.server.close).not.toHaveBeenCalled();
  });
  it("stops an owned child when its control connection is lost", async () => {
    const owned = await OwnedBrowser.launch();
    f.browser.once.mock.calls.at(-1)![1]();
    expect(await owned.close()).toEqual({ forced: true, exitConfirmed: true });
    expect(owned.terminationState).toBe("exited");
  });
  it("does not claim cancellation when the operating-system exit remains unconfirmed", async () => {
    f.server.kill.mockImplementationOnce(() => new Promise(() => {}));
    const owned = await OwnedBrowser.launch({ gracefulCloseMs: 0, killTimeoutMs: 10 });
    await expect(owned.terminate()).rejects.toThrow("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
    expect(owned.exitConfirmed).toBe(false);
    expect(owned.terminationState).toBe("unconfirmed");
  });
  it("cleans up an owned child when connection fails and never exposes endpoint credentials", async () => {
    f.connect.mockRejectedValueOnce(new Error("fixture-only-private-endpoint"));
    await expect(OwnedBrowser.launch()).rejects.toThrow(/^SCRY_BROWSER_PROCESS_CONNECT_FAILED$/u);
    expect(f.child.exitCode).toBe(0);
  });
  it("rejects an unexpected endpoint and still closes the child", async () => {
    f.server.wsEndpoint.mockReturnValueOnce("ws://0.0.0.0:4444/private");
    await expect(OwnedBrowser.launch()).rejects.toThrow("SCRY_BROWSER_PROCESS_ENDPOINT_INVALID");
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.child.exitCode).toBe(0);
  });
  it("reports failed-connection cleanup as unconfirmed when the owned child cannot be stopped", async () => {
    f.connect.mockRejectedValueOnce(new Error("fixture-only-private-endpoint"));
    f.server.kill.mockImplementationOnce(() => new Promise(() => {}));
    await expect(OwnedBrowser.launch({ gracefulCloseMs: 0, killTimeoutMs: 10 })).rejects.toThrow(
      "SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED",
    );
    expect(f.child.exitCode).toBeNull();
    expect(f.child.signalCode).toBeNull();
  });
  it.each([0, -1, NaN, Infinity, 120001])(
    "rejects unbounded/invalid launch budget %s before spawning",
    async (value) => {
      await expect(OwnedBrowser.launch({ launchTimeoutMs: value })).rejects.toThrow(
        "CONFIGURATION_INVALID",
      );
      expect(f.launch).not.toHaveBeenCalled();
    },
  );
  it("does not expose raw launch failures", async () => {
    f.launch.mockRejectedValueOnce(new Error("fixture-only-private-path"));
    await expect(OwnedBrowser.launch()).rejects.toThrow(/^SCRY_BROWSER_PROCESS_LAUNCH_FAILED$/u);
  });
});
