import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { PraxisMcpBrowserEngine } from "../src/mcp-browser-engine.js";
import { PraxisOwnerLease } from "../src/owner-lease.js";
import type {
  PraxisCommandsPort,
  PraxisEffectsPort,
  ChronicleEvidencePort,
  VeilBrowserProtectionPort,
} from "@scry/contracts";

function fixture(response: unknown = { isError: false, content: [] }) {
  const effects = { assertOwner: vi.fn(async () => {}) } as unknown as PraxisEffectsPort;
  const commands = {
    protectedValuesForSession: vi.fn(async () => ({})),
    protectedValueForBrowser: vi.fn(async () => "fictional-secret"),
  } as unknown as PraxisCommandsPort;
  const engine = new PraxisMcpBrowserEngine(
    commands,
    effects,
    {} as ChronicleEvidencePort,
    {} as VeilBrowserProtectionPort,
    "unused",
  );
  const c = (engine as unknown as { cell(id: string): any }).cell("sequence-fixture");
  c.scope = { baseOrigin: "http://fixture.test" };
  c.opening = Promise.resolve();
  c.lease = new PraxisOwnerLease(
    { sessionId: c.id, generation: 1, leaseToken: "fixture" },
    effects,
    { sampleStartedAt: performance.now(), leaseRemainingMs: 60000 },
  );
  c.policyDigest = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
  c.custody = { synchronize: vi.fn(async () => {}) };
  c.worker = {
    call: vi.fn(async (message: any) =>
      message.type === "plan_step"
        ? response
        : { isError: false, content: [{ type: "text", text: "Final observation" }] },
    ),
  };
  const command = {
    kind: "browser_tool" as const,
    tool: "browser_sequence",
    args: {
      planId: "fixture-plan",
      observationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      steps: [0, 1, 2].map((i) => ({
        tool: "browser_type",
        actionId: "fixture-step-" + i,
        args: { target: "e" + (i + 1), text: "value" + i },
      })),
    },
  };
  return { engine, c, command };
}
it.each([0, 1, 2])(
  "retains a completed prefix and proves step %i was refused before dispatch",
  async (refusedIndex) => {
    const { engine, c, command } = fixture();
    c.worker.call.mockImplementation(async (m: any) =>
      m.type === "plan_step" && m.index === refusedIndex
        ? { contractVersion: 2, isError: true, content: [], dispatchRefusal: m.refusalIdentity }
        : { isError: false, content: [] },
    );
    const saved: any[] = [];
    try {
      const r = await engine.execute(c.id, command, {
        remainingMs: 5000,
        persistAction: async (r) => {
          saved.push(structuredClone(r));
        },
      });
      expect(r).toMatchObject({
        contractVersion: 2,
        complete: false,
        execution: refusedIndex === 0 ? "not_dispatched" : "partial",
        reason: "guard_refused_before_dispatch",
        observation: "available",
      });
      expect((r.receipts as any[]).map((x) => x.execution)).toEqual([
        ...Array(refusedIndex).fill("completed"),
        "not_dispatched",
      ]);
      expect(
        saved
          .filter((x) => x.reason === "dispatch_started")
          .at(-1)
          .receipts.at(-1).execution,
      ).toBe("unknown");
      expect(c.worker.call.mock.calls.filter(([m]: any) => m.type === "plan_step")).toHaveLength(
        refusedIndex + 1,
      );
    } finally {
      c.lease.revoke();
    }
  },
);
it.each(["challenge", "ownerGeneration", "index", "actionId", "planId"])(
  "rejects a mismatched %s in a negative acknowledgement",
  async (field) => {
    const { engine, c, command } = fixture();
    const saved: any[] = [];
    c.worker.call.mockImplementation(async (m: any) =>
      m.type === "plan_step"
        ? {
            contractVersion: 2,
            isError: true,
            content: [],
            dispatchRefusal: {
              ...m.refusalIdentity,
              [field]: field === "index" ? 7 : field === "ownerGeneration" ? 2 : "wrong",
            },
          }
        : { isError: false, content: [] },
    );
    try {
      await expect(
        engine.execute(c.id, command, {
          remainingMs: 5000,
          persistAction: async (r) => {
            saved.push(structuredClone(r));
          },
        }),
      ).rejects.toThrow("SCRY_BROWSER_ADAPTER_INVALID_PLAN_STATE");
      expect(saved.at(-1).receipts.at(-1).execution).toBe("unknown");
    } finally {
      c.lease.revoke();
    }
  },
);
it("does not admit a refusal proof after the current command has been fenced", async () => {
  const { engine, c, command } = fixture();
  let fenced = false;
  const saved: any[] = [];
  c.worker.call.mockImplementation(async (m: any) => {
    if (m.type === "plan_step") {
      fenced = true;
      return { contractVersion: 2, isError: true, content: [], dispatchRefusal: m.refusalIdentity };
    }
    return { isError: false, content: [] };
  });
  try {
    await expect(
      engine.execute(c.id, command, {
        remainingMs: 5000,
        assertCurrent: async () => {
          if (fenced) throw Error("command fenced");
        },
        persistAction: async (r) => {
          saved.push(structuredClone(r));
        },
      }),
    ).rejects.toThrow("command fenced");
    expect(saved.at(-1).receipts.at(-1).execution).toBe("unknown");
  } finally {
    c.lease.revoke();
  }
});
it.each([undefined, 1, 3])(
  "keeps a refusal with incompatible response version %s uncertain",
  async (contractVersion) => {
    const { engine, c, command } = fixture();
    const saved: any[] = [];
    c.worker.call.mockImplementation(async (m: any) =>
      m.type === "plan_step"
        ? { contractVersion, isError: true, content: [], dispatchRefusal: m.refusalIdentity }
        : { isError: false, content: [] },
    );
    try {
      await expect(
        engine.execute(c.id, command, {
          remainingMs: 5000,
          persistAction: async (r) => {
            saved.push(structuredClone(r));
          },
        }),
      ).rejects.toThrow("SCRY_BROWSER_ADAPTER_INVALID_PLAN_STATE");
      expect(saved.at(-1).execution).toBe("unknown");
    } finally {
      c.lease.revoke();
    }
  },
);
it("persists dispatch/receipt prefixes before later steps and takes one final snapshot", async () => {
  const { engine, c, command } = fixture(),
    receipts: any[] = [];
  try {
    const r = await engine.execute(c.id, command, {
      remainingMs: 5000,
      persistAction: async (r) => {
        receipts.push(structuredClone(r));
      },
    });
    expect(r).toMatchObject({
      execution: "completed",
      complete: true,
      observation: "available",
      businessOutcome: "unverified",
    });
    expect(
      receipts
        .filter((x) => x.reason === "dispatch_started")
        .map((x) => x.receipts.at(-1).execution),
    ).toEqual(["unknown", "unknown", "unknown"]);
    expect(receipts[2].receipts[0].execution).toBe("completed");
    expect(
      c.worker.call.mock.calls.filter(([m]: any) => m.tool === "browser_snapshot"),
    ).toHaveLength(1);
    expect(c.worker.call.mock.calls.filter(([m]: any) => m.type === "plan_step")).toHaveLength(3);
  } finally {
    c.lease.revoke();
  }
});
it.each([{}, { isError: true, content: [] }, { execution: "pending" }])(
  "does not continue after an ambiguous or error-shaped response %j",
  async (response) => {
    const { engine, c, command } = fixture(response);
    try {
      const r = await engine.execute(c.id, command, {
        remainingMs: 5000,
        persistAction: async () => {},
      });
      expect(r.complete).toBe(false);
      expect(c.worker.call.mock.calls.filter(([m]: any) => m.type === "plan_step")).toHaveLength(1);
    } finally {
      c.lease.revoke();
    }
  },
);
it("a dispatch-admission failure prevents all application calls and disposes the guard", async () => {
  const { engine, c, command } = fixture();
  try {
    await expect(
      engine.execute(c.id, command, {
        remainingMs: 5000,
        persistAction: async () => {
          throw Error("stop requested");
        },
      }),
    ).rejects.toThrow("stop requested");
    expect(c.worker.call.mock.calls.some(([m]: any) => m.type === "plan_step")).toBe(false);
    expect(c.worker.call.mock.calls.some(([m]: any) => m.type === "dispose_plan")).toBe(true);
  } finally {
    c.lease.revoke();
  }
});
it("withholds idle diagnostic detail in a new dispatch prefix until that step has fresh child admission", async () => {
  const { engine, c, command } = fixture(),
    persisted: any[] = [];
  (engine as any).protection.nativeDiagnostics = () => ({ sanitize: (value: string) => value });
  let step = 0,
    injected = false;
  c.worker.call.mockImplementation(async (message: any) => ({
    isError: false,
    content: [],
    diagnosticDetailAllowed: message.type === "plan_step" ? step++ === 0 : true,
  }));
  try {
    const result = await engine.execute(c.id, command, {
      remainingMs: 5000,
      persistAction: async (r) => {
        persisted.push(structuredClone(r));
        if (r.reason === "step_receipt" && (r.receipts as any[]).length === 1 && !injected) {
          injected = true;
          c.denials.record({
            reason: "origin_not_allowed",
            origin: "http://fictional-newly-generated-secret.example",
          });
        }
      },
    });
    const secondDispatch = persisted.find(
      (r) => r.reason === "dispatch_started" && r.receipts.length === 2,
    );
    expect(secondDispatch.receipts.map((r: any) => r.execution)).toEqual(["completed", "unknown"]);
    expect(secondDispatch.scopeDiagnostics.current).toMatchObject({
      denialCount: 1,
      endpoints: [],
    });
    expect(JSON.stringify(persisted)).not.toContain("fictional-newly-generated-secret");
    expect(result).toMatchObject({ execution: "completed", complete: true });
    expect(c.diagnosticDetailSuppressed).toBe(true);
  } finally {
    c.lease.revoke();
  }
});
