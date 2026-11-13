import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  PraxisCommandsPort,
  PraxisEffectsPort,
  ChronicleEvidencePort,
  VeilBrowserProtectionPort,
} from "@scry/contracts";
import { PraxisMcpBrowserEngine } from "../src/mcp-browser-engine.js";
import { PraxisOwnerLease } from "../src/owner-lease.js";

export function scopeFixture(
  protection: Partial<VeilBrowserProtectionPort> = {
    nativeDiagnostics: () => ({ sanitize: (value) => value }),
  },
) {
  const effects = { assertOwner: vi.fn(async () => {}) } as unknown as PraxisEffectsPort;
  const commands = {
    protectedValuesForSession: vi.fn(async () => ({})),
  } as unknown as PraxisCommandsPort;
  const engine = new PraxisMcpBrowserEngine(
    commands,
    effects,
    {} as ChronicleEvidencePort,
    protection as VeilBrowserProtectionPort,
    "unused",
  );
  const c = (engine as unknown as { cell(id: string): any }).cell("scope-fixture");
  c.scope = { baseOrigin: "http://app.test" };
  c.opening = Promise.resolve();
  c.lease = new PraxisOwnerLease(
    { sessionId: c.id, generation: 1, leaseToken: "private" },
    effects,
    { sampleStartedAt: performance.now(), leaseRemainingMs: 60000 },
  );
  c.policyDigest = createHash("sha256").update("{}").digest("hex");
  c.custody = { synchronize: vi.fn(async () => {}), terminate: vi.fn(async () => {}) };
  c.worker = {
    call: vi.fn(async () => ({ isError: false, diagnosticDetailAllowed: true, content: [] })),
    stop: vi.fn(async () => {}),
  };
  c.proxy = { close: vi.fn(async () => {}) };
  const persisted: Array<Record<string, any>> = [];
  const options = {
    remainingMs: 5000,
    persistAction: async (result: Record<string, unknown>) => {
      persisted.push(structuredClone(result));
    },
  };
  const record = (origin = "https://background.example") =>
    c.denials.record({ origin, reason: "origin_not_allowed" });
  return { engine, c, commands, options, persisted, record };
}

describe("durable native scope observations", () => {
  it.each(
    [false, true].flatMap((idle) =>
      ["ORIGIN_DENIED", "INVALID_TOOL_ARGUMENTS"].map((code) => ({ idle, code })),
    ),
  )("fail-fast $code preserves successor dispatch (idle denial: $idle)", async ({ idle, code }) => {
    const f = scopeFixture();
    if (idle) f.record();
    try {
      await expect(
        f.engine.execute(
          f.c.id,
          {
            kind: "browser_tool",
            tool: code === "ORIGIN_DENIED" ? "browser_navigate" : "browser_type_secret",
            args:
              code === "ORIGIN_DENIED"
                ? { url: "https://outside.example/" }
                : { target: 123, protectedValueId: "opaque" },
          },
          f.options,
        ),
      ).rejects.toThrow(code);
      expect(f.c.worker.call).not.toHaveBeenCalled();
      if (idle)
        expect(f.persisted.at(-1)).toMatchObject({
          execution: "not_dispatched",
          businessOutcome: "not_dispatched",
          scopeDiagnostics: { prior: { denialCount: 1 } },
        });
      else expect(f.persisted).toEqual([]);
      const successor = await f.engine.execute(
        f.c.id,
        { kind: "browser_tool", tool: "browser_click", args: { target: "#save" } },
        f.options,
      );
      expect(successor).toMatchObject({ execution: "completed", businessOutcome: "unverified" });
      expect(f.c.worker.call).toHaveBeenCalledTimes(2);
      expect(f.persisted.at(-1)).toEqual(successor);
    } finally {
      f.c.lease.revoke();
    }
  });
  it("omits diagnostic fields when no proxy denial was observed, without additional calls", async () => {
    const f = scopeFixture();
    try {
      const result = await f.engine.execute(
        f.c.id,
        { kind: "browser_tool", tool: "browser_snapshot", args: {} },
        f.options,
      );
      expect(result).not.toHaveProperty("scopeDiagnostics");
      expect(result).not.toHaveProperty("scopeRestrictionObserved");
      expect(f.c.worker.call).toHaveBeenCalledTimes(1);
      expect(f.commands.protectedValuesForSession).toHaveBeenCalledTimes(1);
      expect(f.persisted).toHaveLength(3);
    } finally {
      f.c.lease.revoke();
    }
  });

  it("preserves successful dispatch, masking and input receipts despite incidental denials", async () => {
    const f = scopeFixture();
    f.c.maskingPartial = true;
    f.c.worker.call.mockImplementation(async (message: any) => {
      if (message.tool !== "browser_snapshot") f.record();
      return {
        isError: false,
        diagnosticDetailAllowed: true,
        content: [],
        interaction: { status: "observed", inputState: "text_started" },
      };
    });
    try {
      const result = await f.engine.execute(
        f.c.id,
        { kind: "browser_tool", tool: "browser_click", args: { target: "#save" } },
        f.options,
      );
      expect(result).toMatchObject({
        execution: "completed",
        businessOutcome: "unverified",
        observation: "available",
        masking: "best_effort_partial",
        inputObservation: { status: "observed" },
        scopeRestrictionObserved: true,
      });
      expect(result).not.toHaveProperty("scopeRestrictionImpact");
      expect(result.scopeDiagnostics).toMatchObject({
        current: {
          denialCount: 1,
          causalAssociation: "not_established",
          actionDispatch: "not_determined",
          applicationConclusion: "not_determined",
        },
      });
      expect(result).toEqual(f.persisted.at(-1));
      expect(f.c.worker.call).toHaveBeenCalledTimes(2);
      expect(f.commands.protectedValuesForSession).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result.scopeDiagnostics)).not.toContain('"cursor":');
    } finally {
      f.c.lease.revoke();
    }
  });

  it("publishes each idle/current window once and leaves exact returned receipts immutable", async () => {
    const f = scopeFixture();
    const command = { kind: "browser_tool" as const, tool: "browser_snapshot", args: {} };
    try {
      f.c.worker.call.mockImplementationOnce(async () => {
        f.record("https://first.example");
        return { isError: false, diagnosticDetailAllowed: true, content: [] };
      });
      const first = await f.engine.execute(f.c.id, command, f.options);
      const immutable = JSON.stringify(first);
      const second = await f.engine.execute(f.c.id, command, f.options);
      expect(second).not.toHaveProperty("scopeDiagnostics");
      f.record("https://idle.example");
      f.c.worker.call.mockImplementationOnce(async () => {
        f.record("https://current.example");
        return { isError: false, diagnosticDetailAllowed: true, content: [] };
      });
      const third = await f.engine.execute(f.c.id, command, f.options);
      expect(third.scopeDiagnostics).toMatchObject({
        prior: { denialCount: 1, endpoints: [{ endpoint: "https://idle.example" }] },
        current: { denialCount: 1, endpoints: [{ endpoint: "https://current.example" }] },
      });
      expect(JSON.stringify(first)).toBe(immutable);
      expect(await f.engine.execute(f.c.id, command, f.options)).not.toHaveProperty(
        "scopeDiagnostics",
      );
    } finally {
      f.c.lease.revoke();
    }
  });

  it("does not absorb future activity arriving during a final durable write into the returned receipt", async () => {
    const f = scopeFixture();
    let writes = 0;
    const persistAction = async (result: Record<string, unknown>) => {
      await f.options.persistAction(result);
      if (++writes === 3) f.record("https://late.example");
    };
    try {
      const first = await f.engine.execute(
        f.c.id,
        { kind: "browser_tool", tool: "browser_snapshot", args: {} },
        { ...f.options, persistAction },
      );
      expect(first).not.toHaveProperty("scopeDiagnostics");
      const second = await f.engine.execute(
        f.c.id,
        { kind: "browser_tool", tool: "browser_snapshot", args: {} },
        f.options,
      );
      expect(second.scopeDiagnostics).toMatchObject({
        prior: { denialCount: 1, endpoints: [{ endpoint: "https://late.example" }] },
      });
      expect(second.scopeDiagnostics).not.toHaveProperty("current");
    } finally {
      f.c.lease.revoke();
    }
  });

  it("durably preserves ambiguous action truth and safe facts before retirement disposes raw buffers", async () => {
    const f = scopeFixture();
    f.c.worker.call.mockImplementation(async () => {
      f.record();
      throw Error("SCRY_BROWSER_ADAPTER_LOST");
    });
    f.c.worker.stop.mockImplementation(async () => {
      // Real worker exit can independently request stop a second time.
      void (f.engine as unknown as { stop(c: unknown, force: boolean): Promise<void> }).stop(
        f.c,
        true,
      );
    });
    try {
      await expect(
        f.engine.execute(
          f.c.id,
          { kind: "browser_tool", tool: "browser_click", args: { target: "#save" } },
          f.options,
        ),
      ).rejects.toThrow("ADAPTER_LOST");
      expect(f.persisted.at(-1)).toMatchObject({
        execution: "unknown",
        businessOutcome: "unknown",
        scopeDiagnostics: { current: { denialCount: 1 } },
      });
      expect(f.c.retired).toBe(true);
      expect(f.c.denials.snapshot()).toMatchObject({
        lifecycle: "disposed",
        denialCount: 0,
        endpoints: [],
      });
      expect(f.c.custody.terminate).toHaveBeenCalledTimes(1);
      expect(f.c.proxy.close).toHaveBeenCalledTimes(1);
      expect(f.c.captureDenials).toBeUndefined();
    } finally {
      f.c.lease.revoke();
    }
  });

  it("preserves completed action truth when the subsequent observation fails and retires", async () => {
    const f = scopeFixture();
    f.c.worker.call.mockImplementation(async (message: any) => {
      if (message.tool === "browser_snapshot") {
        f.record();
        throw Error("SCRY_BROWSER_ADAPTER_LOST");
      }
      return { isError: false, diagnosticDetailAllowed: true, content: [] };
    });
    try {
      const result = await f.engine.execute(
        f.c.id,
        { kind: "browser_tool", tool: "browser_click", args: { target: "#save" } },
        f.options,
      );
      expect(result).toMatchObject({
        execution: "completed",
        businessOutcome: "unverified",
        observation: "unavailable",
        scopeDiagnostics: { current: { denialCount: 1 } },
      });
      expect(result).toEqual(f.persisted.at(-1));
      expect(f.c.denials.snapshot().endpoints).toEqual([]);
    } finally {
      f.c.lease.revoke();
    }
  });

  it("does not disclose with an old policy when validation fails before the existing policy read", async () => {
    const f = scopeFixture();
    f.c.denials.setCleaner((value: string) => value);
    f.record("https://newly-protected-host.example");
    try {
      await expect(
        f.engine.execute(
          f.c.id,
          {
            kind: "browser_tool",
            tool: "browser_navigate",
            args: { url: "https://outside.example/" },
          },
          f.options,
        ),
      ).rejects.toThrow("ORIGIN_DENIED");
      expect(f.persisted.at(-1)).toMatchObject({
        scopeDiagnostics: {
          prior: {
            denialCount: 1,
            detailUnavailableCount: 1,
            unavailableReasons: ["cleaner_missing"],
            endpoints: [],
          },
        },
      });
      expect(JSON.stringify(f.persisted)).not.toContain("newly-protected");
      expect(f.commands.protectedValuesForSession).not.toHaveBeenCalled();
      expect(f.c.worker.call).not.toHaveBeenCalled();
    } finally {
      f.c.lease.revoke();
    }
  });

  it("preserves completed sequence prefixes and an unknown in-flight step on failure", async () => {
    const f = scopeFixture();
    f.c.worker.call.mockImplementation(async (message: any) => {
      if (message.type === "plan_step") {
        if (message.index === 1) throw Error("SCRY_BROWSER_ADAPTER_CALL_FAILED");
        f.record();
      }
      return { isError: false, diagnosticDetailAllowed: true, content: [] };
    });
    try {
      await expect(
        f.engine.execute(
          f.c.id,
          {
            kind: "browser_tool",
            tool: "browser_sequence",
            args: {
              planId: "scope-plan",
              observationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              steps: [0, 1].map((index) => ({
                tool: "browser_type",
                actionId: `scope-step-${index}`,
                args: { target: `e${index + 1}`, text: `value-${index}` },
              })),
            },
          },
          f.options,
        ),
      ).rejects.toThrow("ADAPTER_CALL_FAILED");
      expect(f.persisted.at(-1)).toMatchObject({
        execution: "unknown",
        businessOutcome: "unknown",
        receipts: [
          { execution: "completed", actionId: "scope-step-0" },
          { execution: "unknown", actionId: "scope-step-1" },
        ],
        scopeDiagnostics: { current: { denialCount: 1 } },
      });
      expect(f.c.worker.call.mock.calls.map(([message]: any) => message.type)).toEqual([
        "prepare_plan",
        "plan_step",
        "plan_step",
        "dispose_plan",
      ]);
    } finally {
      f.c.lease.revoke();
    }
  });

  it.each([
    {},
    {
      nativeDiagnostics: () => {
        throw Error("private factory details");
      },
    },
    {
      nativeDiagnostics: () => ({
        sanitize: () => {
          throw Error("private sanitizer details");
        },
      }),
    },
  ])("degrades to bounded count-only context for unavailable protection %j", async (protection) => {
    const f = scopeFixture(protection);
    f.c.worker.call.mockImplementation(async () => {
      f.record("https://private-host.example");
      return { isError: false, diagnosticDetailAllowed: true, content: [] };
    });
    try {
      const result = await f.engine.execute(
        f.c.id,
        { kind: "browser_tool", tool: "browser_snapshot", args: {} },
        f.options,
      );
      expect(result).toMatchObject({
        execution: "completed",
        scopeDiagnostics: { current: { denialCount: 1, detailUnavailableCount: 1, endpoints: [] } },
      });
      expect(JSON.stringify(result)).not.toContain("private");
    } finally {
      f.c.lease.revoke();
    }
  });

  it("bounds returned diagnostic bytes and endpoints after 25,000 events across prior/current windows", async () => {
    const f = scopeFixture();
    const endpoint = (i: number) =>
      `https://${String(i).padStart(8, "0")}.${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(60)}.${"g".repeat(60)}.example`;
    try {
      for (let i = 0; i < 12_500; i++) f.record(endpoint(i));
      f.c.worker.call.mockImplementation(async () => {
        for (let i = 12_500; i < 25_000; i++) f.record(endpoint(i));
        return { isError: false, diagnosticDetailAllowed: true, content: [] };
      });
      const result = await f.engine.execute(
        f.c.id,
        { kind: "browser_tool", tool: "browser_snapshot", args: {} },
        f.options,
      );
      const windows = result.scopeDiagnostics as Record<string, any>;
      expect(windows.prior.denialCount).toBe(12_500);
      expect(windows.current.denialCount).toBe(12_500);
      expect(windows.prior.droppedDenialCount).toBe(12_500);
      expect(windows.current.droppedDenialCount).toBe(12_492);
      expect(Object.values(windows).reduce((sum, value) => sum + value.endpoints.length, 0)).toBe(
        8,
      );
      expect(Buffer.byteLength(JSON.stringify(windows))).toBeLessThan(8192);
      f.c.worker.call.mockImplementation(async () => ({
        isError: false,
        diagnosticDetailAllowed: true,
        content: [],
      }));
      expect(
        await f.engine.execute(
          f.c.id,
          { kind: "browser_tool", tool: "browser_snapshot", args: {} },
          f.options,
        ),
      ).not.toHaveProperty("scopeDiagnostics");
    } finally {
      f.c.lease.revoke();
    }
  });
});
