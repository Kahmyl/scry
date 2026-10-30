import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import type {
  ChronicleEvidencePort,
  PraxisCommandsPort,
  PraxisEffectsPort,
  PraxisOwnerClaim,
  VeilBrowserProtectionPort,
} from "@scry/contracts";
import { PraxisBrowserEngine } from "../src/browser-engine.js";
import { BrowserReplayRenderer } from "../src/replay-browser.js";
import { PraxisOwnerLease } from "../src/owner-lease.js";

const browserFixture = vi.hoisted(() => {
  const page = { on: vi.fn(), setContent: vi.fn(), goto: vi.fn(async () => undefined) };
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

const ownerClaim = (): PraxisOwnerClaim => ({
  generation: 1,
  leaseToken: "token",
  fencingToken: 1,
  leaseRemainingMs: 60000,
  sampleStartedAt: performance.now(),
});
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
    claimOwner: vi.fn(async () => ownerClaim()),
    heartbeatOwner: vi.fn(async () => ({
      leaseRemainingMs: 60000,
      sampleStartedAt: performance.now(),
    })),
    retireOwner: vi.fn(async (_receipt: unknown): Promise<void> => undefined),
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
    () => 120000,
  );
  return { engine, commands, effects, session, protection };
}

beforeEach(() => {
  vi.clearAllMocks();
  browserFixture.custody.terminate.mockReset().mockImplementation(async () => {
    await browserFixture.browser.close();
    return { forced: true, exitConfirmed: true as const };
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("browser owner lifecycle", () => {
  it("waits for durable retirement admission before making the stopped incarnation vacant", async () => {
    const { engine, effects } = fixture();
    await engine.open("session");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    effects.retireOwner.mockImplementationOnce(() => gate);
    effects.heartbeatOwner.mockRejectedValueOnce(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(20000);
    const replacement = engine.open("session");
    try {
      await Promise.resolve();
      expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
      expect(effects.retireOwner).toHaveBeenCalledTimes(1);
      expect(effects.claimOwner).toHaveBeenCalledTimes(1);
      finish();
      await replacement;
      expect(effects.claimOwner).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      await replacement.catch(() => undefined);
      await engine.closeAll();
    }
  });
  it("retains failed durable retirement after physical stop and requires host recovery", async () => {
    const { engine, effects } = fixture();
    await engine.open("session");
    effects.retireOwner.mockRejectedValueOnce(new Error("private_database_failure"));
    effects.heartbeatOwner.mockRejectedValueOnce(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(20000);
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    await expect(engine.open("session")).rejects.toThrow("OWNER_RETIREMENT_UNCONFIRMED");
    await expect(engine.closeAll()).rejects.toThrow("OWNER_RETIREMENT_UNCONFIRMED");
    expect(effects.claimOwner).toHaveBeenCalledTimes(1);
    expect(effects.retireOwner).toHaveBeenCalledTimes(1);
  });
  async function clocked(work: () => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    const origin = Date.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin);
    try {
      await work();
    } finally {
      clock.mockRestore();
    }
  }
  it("physically retires on local owner expiry even while the heartbeat never returns", async () =>
    clocked(async () => {
      const { engine, effects, session } = fixture();
      await engine.open("session");
      let finish!: (value: { leaseRemainingMs: number; sampleStartedAt: number }) => void;
      effects.heartbeatOwner.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      try {
        await vi.advanceTimersByTimeAsync(60000);
        expect(effects.heartbeatOwner).toHaveBeenCalledTimes(1);
        expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
        expect(browserFixture.recorder.abort).toHaveBeenCalledTimes(1);
        expect(session.seal).not.toHaveBeenCalled();
        expect(effects.completeEvidence).not.toHaveBeenCalled();
        finish({ leaseRemainingMs: 60000, sampleStartedAt: performance.now() });
        await vi.advanceTimersByTimeAsync(0);
        expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
      } finally {
        finish?.({ leaseRemainingMs: 60000, sampleStartedAt: performance.now() });
        await engine.closeAll();
      }
    }));
  it("does not let an old late heartbeat terminate a replacement incarnation", async () =>
    clocked(async () => {
      const { engine, effects } = fixture();
      await engine.open("session");
      let finish!: (value: { leaseRemainingMs: number; sampleStartedAt: number }) => void;
      effects.heartbeatOwner.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      try {
        await vi.advanceTimersByTimeAsync(60000);
        effects.claimOwner.mockResolvedValueOnce({
          ...ownerClaim(),
          generation: 2,
          fencingToken: 2,
          leaseToken: "next",
        });
        expect(await engine.open("session")).toMatchObject({ ownerGeneration: 2 });
        finish({ leaseRemainingMs: 60000, sampleStartedAt: performance.now() });
        await vi.advanceTimersByTimeAsync(0);
        expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
        expect(await engine.open("session")).toMatchObject({ ownerGeneration: 2 });
      } finally {
        finish?.({ leaseRemainingMs: 60000, sampleStartedAt: performance.now() });
        await engine.closeAll();
      }
    }));
  it("refuses startup whose owner acknowledgement already consumed its lease", async () =>
    clocked(async () => {
      const { engine, effects } = fixture();
      effects.claimOwner.mockResolvedValueOnce({ ...ownerClaim(), leaseRemainingMs: 0 });
      try {
        await expect(engine.open("session")).rejects.toThrow("OWNER_FENCED");
        expect(browserFixture.ownedLaunch).not.toHaveBeenCalled();
      } finally {
        await engine.closeAll();
      }
    }));
  it("checks current command authority after startup and before native dispatch", async () => {
    const { engine } = fixture();
    await engine.open("session");
    const assertCurrent = vi.fn(async () => {
      throw new Error("SCRY_BROWSER_COMMAND_CLAIM_FENCED");
    });
    await expect(
      engine.execute(
        "session",
        { kind: "navigate", url: "https://fixture.example" },
        { remainingMs: 1000, assertCurrent },
      ),
    ).rejects.toThrow("COMMAND_CLAIM_FENCED");
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(browserFixture.page.goto).not.toHaveBeenCalled();
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    await engine.closeAll();
  });
  it("does not revive an older background startup when its command incarnation was cancelled", async () => {
    const { engine, effects } = fixture(),
      cancel = new AbortController();
    let releaseSchema!: () => void,
      schemaEntered!: () => void,
      releaseClaim!: (value: PraxisOwnerClaim) => void,
      claimEntered!: () => void;
    const schema = new Promise<void>((resolve) => {
        releaseSchema = resolve;
      }),
      seenSchema = new Promise<void>((resolve) => {
        schemaEntered = resolve;
      }),
      seenClaim = new Promise<void>((resolve) => {
        claimEntered = resolve;
      });
    effects.assertCompatibleBaseline.mockImplementationOnce(async () => {
      schemaEntered();
      await schema;
    });
    const background = engine.open("session");
    const backgroundResult = background.catch((error: unknown) => error);
    await seenSchema;
    effects.claimOwner.mockImplementationOnce(async () => {
      claimEntered();
      return new Promise((resolve) => {
        releaseClaim = resolve;
      });
    });
    const running = engine.execute(
      "session",
      { kind: "observe" },
      { remainingMs: 1000, signal: cancel.signal },
    );
    const result = running.catch((error: unknown) => error);
    try {
      await seenClaim;
      cancel.abort();
      releaseClaim(ownerClaim());
      expect(await result).toMatchObject({ message: "SCRY_BROWSER_COMMAND_CANCELLED" });
      releaseSchema();
      expect(await backgroundResult).toMatchObject({ message: "SCRY_BROWSER_OWNER_FENCED" });
      expect(browserFixture.ownedLaunch).not.toHaveBeenCalled();
    } finally {
      releaseSchema();
      await backgroundResult;
      await engine.closeAll();
    }
  });
  it("drains context creation after command cancellation without starting a page or recorder", async () => {
    const { engine } = fixture(),
      cancel = new AbortController();
    let finish!: (value: typeof browserFixture.context) => void, enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    browserFixture.browser.newContext.mockImplementationOnce(async () => {
      enter();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const running = engine.execute(
      "session",
      { kind: "observe" },
      { remainingMs: 1000, signal: cancel.signal },
    );
    let returned = false;
    const result = running.catch((error: unknown) => {
      returned = true;
      return error;
    });
    try {
      await entered;
      cancel.abort();
      await vi.waitFor(() => expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1), {
        timeout: 500,
      });
      expect(returned).toBe(false);
      finish(browserFixture.context);
      expect(await result).toMatchObject({ message: "SCRY_BROWSER_COMMAND_CANCELLED" });
      expect(browserFixture.context.newPage).not.toHaveBeenCalled();
      expect(browserFixture.recorder.start).not.toHaveBeenCalled();
    } finally {
      finish(browserFixture.context);
      await result;
      await engine.closeAll();
    }
  });
  it("keeps an unconfirmed cancelled engine lane fenced rather than claiming a replacement", async () => {
    const { engine, effects } = fixture();
    await engine.open("session");
    const cancel = new AbortController();
    browserFixture.page.goto.mockImplementationOnce(async () => {
      cancel.abort();
      throw new Error("fixture_stopped");
    });
    browserFixture.custody.terminate.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED"),
    );
    await expect(
      engine.execute(
        "session",
        { kind: "navigate", url: "https://fixture.example" },
        { remainingMs: 1000, signal: cancel.signal },
      ),
    ).rejects.toThrow("COMMAND_DRAIN_UNCONFIRMED");
    await expect(engine.execute("session", { kind: "observe" })).rejects.toThrow(
      "COMMAND_DRAIN_UNCONFIRMED",
    );
    expect(effects.claimOwner).toHaveBeenCalledTimes(1);
    await expect(engine.closeAll()).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
  });
  it("physically retires a browser on driver timeout rather than trusting that its action stopped", async () => {
    const { engine } = fixture();
    await engine.open("session");
    const timeout = new Error("fixture-only-driver-description");
    timeout.name = "TimeoutError";
    browserFixture.page.goto.mockRejectedValueOnce(timeout);
    await expect(
      engine.execute("session", { kind: "navigate", url: "https://fixture.example" }),
    ).rejects.toThrow("SCRY_BROWSER_ACTION_TIMEOUT");
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    await engine.closeAll();
  });
  it("rejects an overlapping engine command before it can use shared browser state", async () => {
    const { engine, session } = fixture();
    await engine.open("session");
    let finish!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
    session.seal.mockImplementationOnce(async () => {
      enter();
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
    const closing = engine.execute("session", { kind: "close" });
    try {
      await entered;
      await expect(engine.execute("session", { kind: "observe" })).rejects.toThrow(
        "COMMAND_CONCURRENT",
      );
    } finally {
      finish();
      await closing;
      await engine.closeAll();
    }
  });
  it("physically retires the exact browser when an active command is cancelled", async () => {
    const { engine } = fixture();
    await engine.open("session");
    const cancel = new AbortController();
    let fail!: () => void, enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    browserFixture.page.goto.mockImplementationOnce(async () => {
      enter();
      await new Promise<void>((_resolve, reject) => {
        fail = () => reject(new Error("fixture_navigation_stopped"));
      });
    });
    const running = engine.execute(
      "session",
      { kind: "navigate", url: "https://fixture.example" },
      { remainingMs: 1000, signal: cancel.signal },
    );
    const observed = running.catch((error: unknown) => error);
    try {
      await entered;
      cancel.abort();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.waitFor(() => expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1), {
        timeout: 500,
      });
    } finally {
      fail();
      await observed;
      await engine.closeAll();
    }
  });
  it("does not launch a browser after cancellation while its owner claim was pending", async () => {
    const { engine, effects } = fixture();
    const cancel = new AbortController();
    let finish!: (value: PraxisOwnerClaim) => void, enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    effects.claimOwner.mockImplementationOnce(async () => {
      enter();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const running = engine.execute(
      "session",
      { kind: "observe" },
      { remainingMs: 1000, signal: cancel.signal },
    );
    const observed = running.catch((error: unknown) => error);
    await entered;
    cancel.abort();
    finish(ownerClaim());
    try {
      await observed;
      expect(browserFixture.ownedLaunch).not.toHaveBeenCalled();
    } finally {
      await engine.closeAll();
    }
  });
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
    expect(effects.retireOwner).not.toHaveBeenCalled();
  });
  it("does not release a startup owner when failed acquisition reports an unconfirmed child", async () => {
    const { engine, effects } = fixture();
    browserFixture.ownedLaunch.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED"),
    );
    await expect(engine.open("session")).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
    await expect(engine.open("session")).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
    expect(effects.claimOwner).toHaveBeenCalledTimes(1);
    expect(effects.retireOwner).not.toHaveBeenCalled();
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
    let entered!: () => void, release!: (value: PraxisOwnerClaim) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<PraxisOwnerClaim>((resolve) => {
      release = resolve;
    });
    effects.claimOwner.mockImplementationOnce(async () => {
      entered();
      return gate;
    });
    const opening = engine.open("session");
    await started;
    await engine.closeAll();
    release(ownerClaim());
    await expect(opening).rejects.toThrow("SESSION_CLOSING");
    expect(browserFixture.ownedLaunch).not.toHaveBeenCalled();
    expect(effects.retireOwner).toHaveBeenCalledTimes(1);
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
    const { engine, effects } = fixture();
    await engine.open("session");
    browserFixture.recorder.abort.mockImplementationOnce(() => new Promise(() => {}));
    const stopping = engine.closeAll();
    const refused = expect(stopping).rejects.toThrow("PROCESS_TERMINATION_UNCONFIRMED");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(browserFixture.custody.terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    await refused;
    expect(effects.retireOwner).not.toHaveBeenCalled();
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
      ownerClaim(),
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
      ownerClaim(),
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
    expect(effects.retireOwner).toHaveBeenCalledWith({
      owner: { sessionId: "session", generation: 1, leaseToken: "token" },
      browserStopped: true,
      recordingDrained: true,
    });
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
