import { performance } from "node:perf_hooks";
import { describe, it, expect, vi } from "vitest";
import { PraxisMcpBrowserEngine } from "../src/mcp-browser-engine.js";
import { PraxisOwnerLease } from "../src/owner-lease.js";
import { SupervisionAuthority } from "../src/supervision-authority.js";
import { ExecutionSupervision } from "../src/execution-supervision.js";
import { CommandAttempt } from "../src/command-lane.js";
import type {
  PraxisCommandsPort,
  PraxisEffectsPort,
  ChronicleEvidencePort,
  VeilBrowserProtectionPort,
} from "@scry/contracts";

describe("official adapter command handoff", () => {
  it("uses the same bounded native observation allowance after an action as for an explicit snapshot", async () => {
    const effects = { assertOwner: vi.fn(async () => {}) } as unknown as PraxisEffectsPort;
    const commands = {
      protectedValuesForSession: vi.fn(async () => ({})),
    } as unknown as PraxisCommandsPort;
    const engine = new PraxisMcpBrowserEngine(
      commands,
      effects,
      {} as ChronicleEvidencePort,
      {} as VeilBrowserProtectionPort,
      "unused",
    );
    const c = (engine as unknown as { cell(id: string): any }).cell("slow-independent-observation");
    c.scope = { baseOrigin: "http://app.test" };
    c.lease = new PraxisOwnerLease(
      { sessionId: c.id, generation: 1, leaseToken: "private" },
      effects,
      { sampleStartedAt: performance.now(), leaseRemainingMs: 60000 },
    );
    c.opening = Promise.resolve();
    c.policyDigest = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    c.custody = {
      synchronize: vi.fn(async () => {}),
      terminate: vi.fn(async () => ({ exitConfirmed: true })),
    };
    const persisted: Array<Record<string, unknown>> = [];
    c.worker = {
      stop: vi.fn(async () => {}),
      call: vi.fn(async (message: any, timeout: number) => {
        if (message.tool !== "browser_snapshot")
          return { content: [{ type: "text", text: "Action completed" }] };
        expect(persisted.at(-1)).toMatchObject({
          execution: "completed",
          businessOutcome: "unverified",
        });
        return new Promise((resolve, reject) => {
          const completed = setTimeout(() => {
            clearTimeout(expired);
            resolve({ content: [{ type: "text", text: "Settled document" }] });
          }, 6500);
          const expired = setTimeout(() => {
            clearTimeout(completed);
            reject(Error("SCRY_BROWSER_ADAPTER_TIMEOUT"));
          }, timeout);
        });
      }),
    };
    try {
      const result = await engine.execute(
        c.id,
        { kind: "browser_tool", tool: "browser_click", args: { target: "#save" } },
        {
          remainingMs: 60000,
          persistAction: async (result) => {
            persisted.push(structuredClone(result));
          },
        },
      );
      expect(result).toMatchObject({
        execution: "completed",
        observation: "available",
        businessOutcome: "unverified",
      });
      expect(c.retired).toBe(false);
      expect(c.custody.terminate).not.toHaveBeenCalled();
      expect(c.worker.call).toHaveBeenCalledTimes(2);
    } finally {
      c.lease.revoke();
    }
  }, 12000);
  it.each(["observed", "unknown", "not_dispatched"])(
    "persists %s input truth before independent observation without claiming saved business success",
    async (status) => {
      const effects = { assertOwner: vi.fn(async () => {}) } as unknown as PraxisEffectsPort;
      const commands = {
        protectedValuesForSession: vi.fn(async () => ({})),
      } as unknown as PraxisCommandsPort;
      const engine = new PraxisMcpBrowserEngine(
        commands,
        effects,
        {} as ChronicleEvidencePort,
        {} as VeilBrowserProtectionPort,
        "unused",
      );
      const c = (engine as unknown as { cell(id: string): any }).cell("input-truth");
      c.scope = { baseOrigin: "http://app.test" };
      c.lease = new PraxisOwnerLease(
        { sessionId: c.id, generation: 1, leaseToken: "private" },
        effects,
        { sampleStartedAt: performance.now(), leaseRemainingMs: 60000 },
      );
      c.opening = Promise.resolve();
      c.policyDigest = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
      c.custody = { synchronize: vi.fn(async () => {}) };
      const persisted: Array<Record<string, unknown>> = [];
      c.worker = {
        call: vi.fn(async (message: any) => {
          if (message.tool === "browser_snapshot") {
            expect(persisted.at(-1)).toMatchObject({
              execution: "completed",
              businessOutcome: "unverified",
              inputObservation: { status: "observed" },
            });
            throw Error("SCRY_BROWSER_ADAPTER_SNAPSHOT_CAPACITY");
          }
          return {
            content: [{ type: "text", text: "Input observation" }],
            isError: status !== "observed",
            interaction: {
              status,
              inputState: status === "not_dispatched" ? "not_started" : "text_started",
            },
          };
        }),
      };
      try {
        const result = await engine.execute(
          c.id,
          {
            kind: "browser_tool",
            tool: "browser_edit_text",
            args: { target: "e4", text: "New note", intent: "replace", method: "keyboard" },
          },
          {
            remainingMs: 60000,
            persistAction: async (result) => {
              persisted.push(structuredClone(result));
            },
          },
        );
        expect(result).toMatchObject({
          execution:
            status === "unknown" ? "unknown" : status === "observed" ? "completed" : "tool_error",
          businessOutcome:
            status === "unknown"
              ? "unknown"
              : status === "observed"
                ? "unverified"
                : "not_dispatched",
          inputObservation: { status },
        });
        expect(persisted[0]).toMatchObject({ execution: "unknown", reason: "dispatch_started" });
        expect(c.retired).toBe(false);
        if (status === "observed")
          expect(result).toMatchObject({
            observation: "unavailable",
            observationIssue: "SCRY_BROWSER_ADAPTER_SNAPSHOT_CAPACITY",
          });
        expect(c.worker.call).toHaveBeenCalledTimes(status === "observed" ? 2 : 1);
      } finally {
        c.lease.revoke();
      }
    },
  );
  it("does not reset a retired supervisor without confirmed physical stop", async () => {
    const evidence = { openSession: vi.fn() } as unknown as ChronicleEvidencePort;
    const engine = new PraxisMcpBrowserEngine(
      {} as PraxisCommandsPort,
      {} as PraxisEffectsPort,
      evidence,
      {} as VeilBrowserProtectionPort,
      "unused",
    );
    const c = (engine as unknown as { cell(id: string): any }).cell("unconfirmed");
    c.retired = true;
    c.stopping = Promise.reject(new Error("STOP_UNCONFIRMED"));
    const supervisor = c.supervision;
    await expect(engine.execute(c.id, { kind: "close" })).rejects.toThrow("STOP_UNCONFIRMED");
    expect(c.supervision).toBe(supervisor);
    expect(evidence.openSession).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "releases completed resource graphs after confirmed stop (expired phase: %s)",
    async (expired) => {
      let stopped = false;
      const effects = {
        assertOwner: vi.fn(async () => {}),
        completeEvidence: vi.fn(async () => {}),
        retireOwner: vi.fn(async () => {
          expect(stopped).toBe(true);
        }),
      } as unknown as PraxisEffectsPort;
      const commands = {
        evidenceStatus: vi.fn(async () => ({ captureStopped: true })),
      } as unknown as PraxisCommandsPort;
      const evidence = {
        openSession: vi.fn(async () => ({ seal: vi.fn(async () => ({ state: "complete" })) })),
      } as unknown as ChronicleEvidencePort;
      const engine = new PraxisMcpBrowserEngine(
        commands,
        effects,
        evidence,
        { readEvidence: () => ({}) } as unknown as VeilBrowserProtectionPort,
        "unused",
      );
      const c = (engine as unknown as { cell(id: string): any }).cell("closed-session");
      c.lease = new PraxisOwnerLease(
        { sessionId: c.id, generation: 1, leaseToken: "private" },
        effects,
        { sampleStartedAt: performance.now(), leaseRemainingMs: 60000 },
      );
      c.scope = { runId: "run", sessionId: c.id };
      c.opening = Promise.resolve();
      c.custody = {
        synchronize: async () => {},
        close: async () => {
          stopped = true;
        },
      };
      c.launch = Promise.resolve(c.custody);
      c.worker = { stop: async () => {} };
      c.native = { directory: "private" };
      c.evidence = {};
      if (expired) {
        let clock = 0;
        c.supervision = new ExecutionSupervision(() => clock);
        await new CommandAttempt({ remainingMs: 1000 }).run(async (attempt) => {
          c.supervision.begin(attempt);
          const phase = c.supervision.enterPhase(100);
          clock = 101;
          expect(() => c.supervision.leavePhase(phase)).toThrow("COMMAND_PHASE_EXPIRED");
          c.supervision.finish(true);
        });
        c.retired = true;
        c.stopping = Promise.resolve().then(() => {
          stopped = true;
        });
      }
      const closed = await engine.execute(c.id, { kind: "close" });
      expect(closed).toMatchObject({ closed: true, ownerGeneration: 1, evidenceState: "complete" });
      for (const key of [
        "worker",
        "custody",
        "launch",
        "native",
        "evidence",
        "lease",
        "opening",
        "policyDigest",
      ])
        expect(c[key]).toBeUndefined();
      expect(await engine.execute(c.id, { kind: "close" })).toEqual(closed);
      await expect(engine.open(c.id)).rejects.toThrow("SESSION_CLOSING");
      expect(effects.completeEvidence).toHaveBeenCalledTimes(1);
    },
  );
  it("acknowledges idle before another command can enter the custodian", async () => {
    const effects = { assertOwner: vi.fn(async () => {}) } as unknown as PraxisEffectsPort;
    const commands = {
      protectedValuesForSession: vi.fn(async () => ({})),
    } as unknown as PraxisCommandsPort;
    const engine = new PraxisMcpBrowserEngine(
      commands,
      effects,
      {} as ChronicleEvidencePort,
      {} as VeilBrowserProtectionPort,
      "unused",
    );
    // Characterize the command boundary after successful acquisition; no real
    // child, browser or database is needed to enforce the actual protocol.
    const c = (engine as unknown as { cell(id: string): any }).cell("session");
    const lease = new PraxisOwnerLease(
      { sessionId: "session", generation: 1, leaseToken: "private" },
      effects,
      { sampleStartedAt: performance.now(), leaseRemainingMs: 60000 },
    );
    const authority = new SupervisionAuthority(() => performance.now());
    const observed: string[] = [];
    c.scope = { baseOrigin: "http://app.test", allowedOrigins: ["http://app.test"] };
    c.lease = lease;
    c.opening = Promise.resolve();
    c.policyDigest = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    c.worker = {
      call: vi.fn(async () => ({ content: [{ type: "text", text: "Current application" }] })),
    };
    c.custody = {
      synchronize: vi.fn(async () => {
        const command = c.supervision.sample();
        observed.push(command.state + ":" + command.sequence);
        authority.accept({
          kind: "authority",
          challenge: authority.issueChallenge(),
          owner: lease.authoritySample(),
          command,
        });
      }),
    };
    try {
      for (let i = 0; i < 3; i++)
        await expect(
          engine.execute("session", { kind: "browser_tool", tool: "browser_snapshot", args: {} }),
        ).resolves.toMatchObject({ execution: "completed" });
      expect(observed).toContain("idle:2");
      expect(observed).toContain("idle:4");
      expect(observed.at(-1)).toBe("idle:6");
      expect(c.worker.call).toHaveBeenCalledTimes(3);
      await expect(
        engine.execute("session", {
          kind: "browser_tool",
          tool: "browser_navigate",
          args: { url: "http://outside.invalid/" },
        }),
      ).rejects.toThrow("ORIGIN_DENIED");
      await expect(
        engine.execute("session", {
          kind: "browser_tool",
          tool: "browser_snapshot",
          args: {},
        }),
      ).resolves.toMatchObject({ execution: "completed" });
      expect(c.worker.call).toHaveBeenCalledTimes(4);
      expect(authority.state).toBe("active");
    } finally {
      lease.revoke();
    }
  });
});
