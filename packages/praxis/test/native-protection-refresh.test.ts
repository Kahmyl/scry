import { afterEach, expect, it, vi } from "vitest";
import { createNativeAdapterProtector } from "../../veil/src/native-adapter-protection.js";
// @ts-expect-error Private shipped JavaScript transport.
import { refreshNativeProtection } from "../src/mcp-native/protection-refresh.mjs";
// @ts-expect-error Private shipped JavaScript deadline owner.
import { BestEffortTasks } from "../src/mcp-native/best-effort-tasks.mjs";

afterEach(() => vi.useRealTimers());
function fixture({
  frames = 1,
  delay = 0,
  complete = true,
  pixelReady = true,
  paintDelay = 0,
  blocked = false,
  missing = false,
} = {}) {
  const protection = createNativeAdapterProtector({});
  const page = { isClosed: () => false };
  const values = ["fictional-generated-credential-value"];
  const calls: string[] = [],
    events: unknown[] = [];
  const session = {
    send: vi.fn(async (name: string, params?: { expression?: string }) => {
      calls.push(name);
      if (name === "Page.getFrameTree")
        return {
          frameTree: {
            frame: { id: "main" },
            childFrames: Array.from({ length: frames - 1 }, (_, i) => ({
              frame: { id: `child-${i}` },
            })),
          },
        };
      if (name === "Page.createIsolatedWorld") {
        if (missing) throw Error("frame disappeared");
        return { executionContextId: 1 };
      }
      const paint = params?.expression === protection.pixelExpression;
      const wait = paint ? paintDelay : delay;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const match = /\.(?:read|paint)\((\d+)/.exec(params?.expression ?? "");
      const read = Number(match?.[1]);
      return {
        result: {
          value: {
            version: 1,
            readId: read,
            policyGeneration: protection.policyGeneration,
            text: complete ? "complete" : "withheld",
            image:
              paint && pixelReady
                ? { state: "available", assessment: "best_effort_known_candidates" }
                : {
                    state: "withheld",
                    reason: "native_protection_refresh_incomplete",
                    recovery: "read_only_once",
                  },
            knownRequirement: "present",
            values,
            coveredValues: values,
            coveredBoundIndices: [],
            textCandidateScope: { readId: read, policyGeneration: protection.policyGeneration },
            textCandidateRefs: [],
            imageCandidateRefs: [],
            count: {
              roots: 1,
              nodes: 2,
              textNodes: 0,
              controls: 1,
              presentations: 0,
              pseudoReads: 0,
              rectangles: 1,
            },
          },
        },
      };
    }),
  };
  const warn = vi.fn((...args: unknown[]) => events.push(args));
  const args = {
    protection,
    pages: [page],
    sessions: new Map([[page, session]]),
    dialogs: new Map(blocked ? [[{}, page]] : []),
    maskTasks: new BestEffortTasks(warn, 200),
    pixelTasks: new BestEffortTasks(warn, 200),
    recovered: vi.fn(),
    degrade: warn,
    phase: (phase: string) => events.push(phase),
  };
  return { protection, args, calls, events, values };
}
it("learns from every admitted descendant frame without adding an application/browser-tool call", async () => {
  const f = fixture({ frames: 3 });
  await refreshNativeProtection(f.args);
  expect(f.calls).toEqual([
    "Page.getFrameTree",
    ...Array(3).fill(["Page.createIsolatedWorld", "Runtime.evaluate"]).flat(),
    ...Array(3).fill("Runtime.evaluate"),
  ]);
  expect(f.protection.observationAvailable()).toBe(true);
  expect(f.protection.clean(f.values[0])).not.toContain(f.values[0]);
  expect(f.protection.diagnosticDetailAllowed()).toBe(false);
  expect(JSON.stringify(f.events)).not.toContain(f.values[0]);
});
it.each([{ blocked: true }, { missing: true }, { frames: 17 }, { complete: false }])(
  "withholds text for incomplete native harvest %j",
  async (options) => {
    const f = fixture(options);
    await refreshNativeProtection(f.args);
    expect(f.protection.observationAvailable()).toBe(false);
    expect(f.protection.clean(f.values[0])).toContain("[UNAVAILABLE:");
    expect(JSON.stringify(f.events)).not.toContain(f.values[0]);
  },
);
it("never treats the 200ms deadline or a late CDP reply as completed text admission", async () => {
  vi.useFakeTimers();
  const f = fixture({ delay: 350 });
  const read = refreshNativeProtection(f.args);
  await vi.advanceTimersByTimeAsync(201);
  await read;
  expect(f.protection.observationAvailable()).toBe(false);
  expect(f.protection.clean(f.values[0])).toContain("[UNAVAILABLE:");
  await vi.advanceTimersByTimeAsync(200);
  expect(f.protection.observationAvailable()).toBe(false);
  f.protection.dispose();
  expect(f.protection.readExpression).not.toContain(f.values[0]);
});
it("separates synchronous fact completion from a missed animation-frame pixel refresh", async () => {
  const f = fixture({ pixelReady: false });
  await refreshNativeProtection(f.args);
  expect(f.protection.observationAvailable()).toBe(true);
  expect(f.protection.clean(f.values[0])).not.toContain(f.values[0]);
  expect(JSON.stringify(f.events)).toContain("maintenance_failed");
});
it("does not certify a live page whose private session installation is still pending", async () => {
  const f = fixture();
  f.args.sessions.clear();
  await refreshNativeProtection(f.args);
  expect(f.protection.observationAvailable()).toBe(false);
  expect(f.protection.clean(f.values[0])).toContain("[UNAVAILABLE:");
  expect(f.calls).toEqual([]);
});
it("admits facts then paints sibling frames concurrently within the unchanged 200ms budget", async () => {
  vi.useFakeTimers();
  const f = fixture({ frames: 3, paintDelay: 100 });
  const read = refreshNativeProtection(f.args);
  await vi.advanceTimersByTimeAsync(201);
  await read;
  expect(f.protection.observationAvailable()).toBe(true);
  expect(f.protection.clean(f.values[0])).not.toContain(f.values[0]);
  expect(f.args.recovered).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.events)).not.toContain("maintenance_timeout");
  expect(f.protection.imageEvidence().state).toBe("available");
  expect(f.calls.slice(0, 7)).toEqual([
    "Page.getFrameTree",
    ...Array(3).fill(["Page.createIsolatedWorld", "Runtime.evaluate"]).flat(),
  ]);
});
it("an older pending paint cannot block fresh facts or recover a disposed/new read", async () => {
  vi.useFakeTimers();
  const f = fixture({ paintDelay: 500 });
  const first = refreshNativeProtection(f.args);
  await vi.advanceTimersByTimeAsync(201);
  await first;
  const second = refreshNativeProtection(f.args);
  await vi.advanceTimersByTimeAsync(201);
  await second;
  expect(f.calls.filter((name) => name === "Page.getFrameTree")).toHaveLength(2);
  expect(f.protection.observationAvailable()).toBe(true);
  f.protection.dispose();
  await vi.advanceTimersByTimeAsync(500);
  expect(f.args.recovered).not.toHaveBeenCalled();
  expect(f.protection.observationAvailable()).toBe(false);
});
