import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChronicleEvidencePort,
  PraxisCommandsPort,
  PraxisEffectsPort,
  VeilBrowserProtectionPort,
} from "@scry/contracts";
import { PraxisBrowserEngine } from "../src/browser-engine.js";
import { BrowserReplayRenderer } from "../src/replay-browser.js";
import { PraxisOwnerLease } from "../src/owner-lease.js";

const browserFixture = vi.hoisted(() => {
  const page = { on: vi.fn(), setContent: vi.fn() };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
    route: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
    once: vi.fn((_event: string, _callback: () => void) => undefined),
  };
  const custody = {
    browser,
    close: vi.fn(async () => {
      await browser.close();
      return { forced: false, exitConfirmed: true as const };
    }),
    terminate: vi.fn(async () => {
      await browser.close();
      return { forced: true, exitConfirmed: true as const };
    }),
  };
  const recorder = {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  return {
    page,
    context,
    browser,
    recorder,
    custody,
    ownedLaunch: vi.fn(async () => custody),
    launch: vi.fn(async () => browser),
  };
});
vi.mock("../src/owned-browser.js", () => ({
  OwnedBrowser: { launch: browserFixture.ownedLaunch },
}));
vi.mock("playwright", () => ({ chromium: { launch: browserFixture.launch } }));
vi.mock("../src/recorder.js", () => ({
  SanitizedBrowserRecorder: class {
    start = browserFixture.recorder.start;
    close = browserFixture.recorder.close;
    abort = browserFixture.recorder.abort;
  },
}));

function fixture() {
  const commands = {
    sessionContext: vi.fn(async () => ({
      sessionId: "session",
      runId: "run",
      baseOrigin: "https://fixture.example",
    })),
    protectedValuesForSession: vi.fn(async () => ({})),
    publicValuesForSession: vi.fn(async () => []),
    loadBrowserCheckpoint: vi.fn(async () => null),
    deleteBrowserCheckpoint: vi.fn(async () => undefined),
  };
  const effects = {
    assertCompatibleBaseline: vi.fn(async () => undefined),
    claimOwner: vi.fn(async () => ({ generation: 1, leaseToken: "token", fencingToken: 1 })),
    heartbeatOwner: vi.fn(async () => undefined),
    releaseOwner: vi.fn(async () => undefined),
    durableCapturesForSession: vi.fn(async () => []),
    withOwner: vi.fn(async <T>(_owner: unknown, work: () => Promise<T>) => work()),
    assertNoPendingEffectOutcomes: vi.fn(async () => undefined),
    unsettledCaptureIds: vi.fn(async () => []),
    completeEvidence: vi.fn(async () => undefined),
  };
  const session = {
    createRecording: vi.fn(),
    prepareClosure: vi.fn(async () => undefined),
    seal: vi.fn(async () => ({
      sessionId: "session",
      runId: "run",
      chainHead: "head",
      chunkCount: 1,
      totalBytes: 1,
      replayObjectKey: "local://fixture",
    })),
  };
  const evidence = { openSession: vi.fn(async () => session) };
  const protection = {
    createSession: vi.fn(() => ({
      authority: {},
      vault: {},
      restoreCaptures: vi.fn(async () => undefined),
      evidenceProtection: {},
      recordingProtection: {},
      privacyOptions: {},
      semanticHint: (value: string) => value,
    })),
  };
  const engine = new PraxisBrowserEngine(
    commands as unknown as PraxisCommandsPort,
    effects as unknown as PraxisEffectsPort,
    evidence as unknown as ChronicleEvidencePort,
    protection as unknown as VeilBrowserProtectionPort,
  );
  return { engine, commands, effects, session, protection };
}

beforeEach(() => {
  vi.clearAllMocks();
  browserFixture.custody.terminate.mockReset().mockImplementation(async () => {
    await browserFixture.browser.close();
    return { forced: true, exitConfirmed: true as const };
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("browser owner lifecycle", () => {
  it("holds replacement admission until the previous physical process exit is confirmed", async () => {
    const { engine, effects } = fixture();
    await engine.open("session");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    browserFixture.custody.terminate.mockImplementationOnce(async () => {
      await gate;
      return { forced: true, exitConfirmed: true as const };
    });
    effects.heartbeatOwner.mockRejectedValueOnce(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(20000);
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    const replacement = engine.open("session");
    await Promise.resolve();
    expect(effects.claimOwner).toHaveBeenCalledTimes(1);
    finish();
    await replacement;
    expect(effects.claimOwner).toHaveBeenCalledTimes(2);
    await engine.closeAll();
  });
  it("retains an unconfirmed retirement and refuses all later local replacement", async () => {
    const { engine, effects } = fixture();
    await engine.open("session");
    browserFixture.custody.terminate.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED"),
    );
    effects.heartbeatOwner.mockRejectedValueOnce(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(20000);
    await expect(engine.open("session")).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
    await expect(engine.closeAll()).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
    expect(effects.claimOwner).toHaveBeenCalledTimes(1);
    expect(effects.releaseOwner).not.toHaveBeenCalled();
  });
  it("does not release a startup owner when failed acquisition reports an unconfirmed child", async () => {
    const { engine, effects } = fixture();
    browserFixture.ownedLaunch.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED"),
    );
    await expect(engine.open("session")).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
    await expect(engine.open("session")).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
    expect(effects.claimOwner).toHaveBeenCalledTimes(1);
    expect(effects.releaseOwner).not.toHaveBeenCalled();
  });
  it("stops a process whose context creation finishes after host shutdown", async () => {
    const { engine } = fixture();
    let enter!: () => void, finish!: (value: typeof browserFixture.context) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<typeof browserFixture.context>((resolve) => {
      finish = resolve;
    });
    browserFixture.browser.newContext.mockImplementationOnce(async () => {
      enter();
      return gate;
    });
    const opening = engine.open("session");
    await entered;
    await engine.closeAll();
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    finish(browserFixture.context);
    await expect(opening).rejects.toThrow("SESSION_CLOSING");
    expect(browserFixture.context.newPage).not.toHaveBeenCalled();
  });
  it("waits for an already-acquired launch operation and terminates its late result on shutdown", async () => {
    const { engine } = fixture();
    let enter!: () => void, finish!: (value: typeof browserFixture.custody) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const launch = new Promise<typeof browserFixture.custody>((resolve) => {
      finish = resolve;
    });
    browserFixture.ownedLaunch.mockImplementationOnce(async () => {
      enter();
      return launch;
    });
    const opening = engine.open("session");
    await entered;
    let stopped = false;
    const stopping = engine.closeAll().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    const refused = expect(opening).rejects.toThrow("SESSION_CLOSING");
    finish(browserFixture.custody);
    await Promise.all([stopping, refused]);
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    expect(browserFixture.browser.newContext).not.toHaveBeenCalled();
  });
  it("never launches after a pending owner claim returns to a stopped host", async () => {
    const { engine, effects } = fixture();
    let entered!: () => void,
      release!: (value: { generation: number; leaseToken: string; fencingToken: number }) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<{ generation: number; leaseToken: string; fencingToken: number }>(
      (resolve) => {
        release = resolve;
      },
    );
    effects.claimOwner.mockImplementationOnce(async () => {
      entered();
      return gate;
    });
    const opening = engine.open("session");
    await started;
    await engine.closeAll();
    release({ generation: 1, leaseToken: "token", fencingToken: 1 });
    await expect(opening).rejects.toThrow("SESSION_CLOSING");
    expect(browserFixture.ownedLaunch).not.toHaveBeenCalled();
    expect(effects.releaseOwner).toHaveBeenCalledTimes(1);
  });
  it("maintains and revokes ownership during pre-browser startup rather than waiting for a page", async () => {
    const { engine, effects, commands } = fixture();
    let enter!: () => void, finish!: (value: null) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<null>((resolve) => {
      finish = resolve;
    });
    commands.loadBrowserCheckpoint.mockImplementationOnce(async () => {
      enter();
      return gate;
    });
    const opening = engine.open("session");
    await entered;
    effects.heartbeatOwner.mockRejectedValueOnce(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(20000);
    expect(effects.heartbeatOwner).toHaveBeenCalledTimes(1);
    finish(null);
    await expect(opening).rejects.toThrow("OWNER_FENCED");
    expect(browserFixture.ownedLaunch).not.toHaveBeenCalled();
    await engine.closeAll();
  });
  it("interrupts on shutdown without implicitly sealing evidence or determining product outcomes", async () => {
    const { engine, effects, session } = fixture();
    await engine.open("session");
    await engine.closeAll();
    expect(session.seal).not.toHaveBeenCalled();
    expect(effects.assertNoPendingEffectOutcomes).not.toHaveBeenCalled();
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    await expect(engine.open("session")).rejects.toThrow("SESSION_CLOSING");
  });
  it("continues stopping independent processes even if one exit is unconfirmed", async () => {
    const { engine } = fixture();
    await engine.open("session");
    await engine.open("other-session");
    browserFixture.custody.terminate.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED"),
    );
    await expect(engine.closeAll()).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(2);
  });
  it("physically stops before waiting for a stalled recorder detach and retains failed drain", async () => {
    const { engine } = fixture();
    await engine.open("session");
    browserFixture.recorder.abort.mockImplementationOnce(() => new Promise(() => {}));
    const stopping = engine.closeAll();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    await expect(stopping).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
    await expect(engine.closeAll()).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
  });
  it("retires unexpected browser disconnection without sealing or releasing product truth", async () => {
    const { engine, session, effects } = fixture();
    await engine.open("session");
    browserFixture.browser.once.mock.calls.at(-1)![1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    expect(session.seal).not.toHaveBeenCalled();
    expect(effects.completeEvidence).not.toHaveBeenCalled();
    await engine.closeAll();
  });
  it("disposes the browser on shutdown even when product closure is refused", async () => {
    const { engine, effects } = fixture();
    await engine.open("session");
    effects.assertNoPendingEffectOutcomes.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_EFFECT_OUTCOME_PENDING"),
    );
    await engine.closeAll();
    expect(browserFixture.browser.close).toHaveBeenCalled();
    expect(effects.completeEvidence).not.toHaveBeenCalled();
  });
  it("preserves an owned browser when close is refused for unresolved product state", async () => {
    const { engine, effects } = fixture();
    await engine.open("session");
    effects.assertNoPendingEffectOutcomes.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_EFFECT_OUTCOME_PENDING"),
    );
    await expect(engine.close("session")).rejects.toThrow("SCRY_BROWSER_EFFECT_OUTCOME_PENDING");
    expect(browserFixture.browser.close).not.toHaveBeenCalled();
    await engine.close("session");
    expect(effects.claimOwner).toHaveBeenCalledTimes(1);
    expect(effects.completeEvidence).toHaveBeenCalledTimes(1);
  });
  it("does not re-admit buffered work after a failed heartbeat even if database calls recover", async () => {
    const { effects } = fixture();
    const lease = new PraxisOwnerLease(
      { sessionId: "session", generation: 1, leaseToken: "token" },
      effects as unknown as PraxisEffectsPort,
    );
    effects.heartbeatOwner.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(lease.heartbeat(60_000)).rejects.toThrow("database unavailable");
    const write = vi.fn(async () => undefined);
    await expect(lease.run(write)).rejects.toThrow("SCRY_BROWSER_OWNER_FENCED");
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects work revoked while its database admission was waiting", async () => {
    const { effects } = fixture();
    let admit!: () => void;
    const gate = new Promise<void>((resolve) => {
      admit = resolve;
    });
    effects.withOwner.mockImplementationOnce(async (_owner, work) => {
      await gate;
      return work();
    });
    const lease = new PraxisOwnerLease(
      { sessionId: "session", generation: 1, leaseToken: "token" },
      effects as unknown as PraxisEffectsPort,
    );
    const write = vi.fn(async () => undefined);
    const pending = lease.run(write);
    lease.revoke();
    admit();
    await expect(pending).rejects.toThrow("SCRY_BROWSER_OWNER_FENCED");
    expect(write).not.toHaveBeenCalled();
  });
  it("stops the local browser on heartbeat failure without flushing or publishing evidence", async () => {
    const { engine, effects, session } = fixture();
    await engine.open("session");
    effects.heartbeatOwner.mockRejectedValueOnce(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(browserFixture.browser.close).toHaveBeenCalled();
    expect(browserFixture.recorder.abort).toHaveBeenCalled();
    expect(browserFixture.recorder.close).not.toHaveBeenCalled();
    expect(session.seal).not.toHaveBeenCalled();
    expect(effects.completeEvidence).not.toHaveBeenCalled();
    await engine.closeAll();
    expect(session.seal).not.toHaveBeenCalled();
  });

  it("rejects a stale command and evicts its browser without automatically claiming a new owner", async () => {
    const { engine, effects } = fixture();
    await engine.open("session");
    effects.withOwner.mockRejectedValueOnce(new Error("SCRY_BROWSER_OWNER_FENCED"));
    await expect(engine.execute("session", { kind: "observe" })).rejects.toThrow(
      "SCRY_BROWSER_OWNER_FENCED",
    );
    expect(browserFixture.browser.close).toHaveBeenCalled();
    expect(effects.claimOwner).toHaveBeenCalledTimes(1);
  });

  it("releases its claim if protection initialization fails before browser launch", async () => {
    const { engine, effects, protection } = fixture();
    protection.createSession.mockImplementationOnce(() => {
      throw new Error("protection unavailable");
    });
    await expect(engine.open("session")).rejects.toThrow("protection unavailable");
    expect(effects.releaseOwner).toHaveBeenCalledWith("session", 1, "token");
    expect(browserFixture.ownedLaunch).not.toHaveBeenCalled();
  });

  it("cleans up a failed close without publishing a stream", async () => {
    const { engine, effects, session } = fixture();
    await engine.open("session");
    session.prepareClosure.mockRejectedValueOnce(new Error("evidence incomplete"));
    await expect(engine.close("session")).rejects.toThrow("evidence incomplete");
    expect(browserFixture.browser.close).toHaveBeenCalled();
    expect(effects.completeEvidence).not.toHaveBeenCalled();
    await engine.closeAll();
    expect(session.prepareClosure).toHaveBeenCalledTimes(1);
  });

  it("shares an opening operation and maintains the lease while rendering before stream completion", async () => {
    const { engine, effects, session } = fixture();
    await Promise.all([engine.open("session"), engine.open("session")]);
    expect(effects.claimOwner).toHaveBeenCalledTimes(1);
    let rendered!: () => void;
    const rendering = new Promise<void>((resolve) => {
      rendered = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    session.seal.mockImplementationOnce(async () => {
      rendered();
      await gate;
      return {
        sessionId: "session",
        runId: "run",
        chainHead: "head",
        chunkCount: 1,
        totalBytes: 1,
        replayObjectKey: "local://fixture",
      };
    });
    const close = engine.close("session");
    await rendering;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(effects.heartbeatOwner).toHaveBeenCalled();
    expect(effects.completeEvidence).not.toHaveBeenCalled();
    await expect(engine.open("session")).rejects.toThrow("SCRY_BROWSER_SESSION_CLOSING");
    finish();
    await close;
    expect(effects.completeEvidence).toHaveBeenCalledWith(
      { sessionId: "session", generation: 1, leaseToken: "token" },
      expect.objectContaining({ chainHead: "head" }),
    );
  });

  it("closes the replay browser even when rendering setup fails", async () => {
    browserFixture.page.setContent.mockRejectedValueOnce(new Error("render setup failed"));
    await expect(
      new BrowserReplayRenderer().render({
        events: [],
        stagingDirectory: "/tmp/unused",
        framesDirectory: "/tmp/unused",
        frames: [],
        renderDurationMs: 1,
        playbackRate: 1,
      }),
    ).rejects.toThrow("render setup failed");
    expect(browserFixture.browser.close).toHaveBeenCalled();
  });
});
