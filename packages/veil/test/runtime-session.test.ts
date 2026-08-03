import { describe, expect, it, vi } from "vitest";
import type { VeilCollectorAcknowledgement, VeilCollectorPhase } from "@scry/contracts";

import {
  VeilRuntimeError,
  VeilRuntimeSession,
  type VeilRuntimeCollector,
} from "../src/runtime-session.js";

function collector(
  id: string,
  alter?: (ack: VeilCollectorAcknowledgement) => VeilCollectorAcknowledgement,
): VeilRuntimeCollector {
  return {
    id,
    transition: vi.fn(
      async (phase: VeilCollectorPhase, context): Promise<VeilCollectorAcknowledgement> => {
        const acknowledgement: VeilCollectorAcknowledgement = {
          schemaVersion: 1,
          collectorId: id,
          phase,
          operationId: context.operationId,
          stateVersion: context.stateVersion,
          acknowledgedAt: new Date().toISOString(),
        };
        return alter?.(acknowledgement) ?? acknowledgement;
      },
    ),
  };
}

describe("VeilRuntimeSession", () => {
  it("requires acknowledged prepare, suspend, and isolate phases before protected state", async () => {
    const target = collector("recording");
    const states: string[] = [];
    const session = new VeilRuntimeSession([target], "a".repeat(64), "ctx", async ({ to }) => {
      states.push(to);
    });
    await session.prepare("op");
    await session.beginProtected();
    await session.resume();
    expect(states).toEqual([
      "preparing",
      "suspended",
      "isolated",
      "protected",
      "resuming",
      "normal",
    ]);
    expect(vi.mocked(target.transition).mock.calls.map(([phase]) => phase)).toEqual([
      "prepare",
      "suspend",
      "isolate",
      "resume",
    ]);
  });

  it("serializes conflicting transitions", async () => {
    const session = new VeilRuntimeSession([collector("recording")], "a".repeat(64), "ctx");
    const results = await Promise.allSettled([session.prepare("first"), session.prepare("second")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("seals on false acknowledgement and cancellation is idempotent", async () => {
    const liar = collector("recording", (ack) => ({ ...ack, stateVersion: ack.stateVersion + 1 }));
    const session = new VeilRuntimeSession([liar], "a".repeat(64), "ctx");
    await expect(session.prepare("op")).rejects.toBeInstanceOf(VeilRuntimeError);
    expect(session.state()).toBe("sealed");
    await session.cancel();
    await session.cancel();
    expect(session.state()).toBe("sealed");
  });

  it("restores only matching safe checkpoints and finalizes once", async () => {
    const target = collector("recording");
    const session = new VeilRuntimeSession([target], "a".repeat(64), "ctx");
    const checkpoint = session.checkpoint();
    await session.seal({
      schemaVersion: 1,
      code: "VEIL_TEST",
      provenance: "runtime",
      retry: "safe",
    });
    await expect(session.restore({ ...checkpoint, contextIdentity: "other" })).rejects.toThrowError(
      expect.objectContaining({ code: "VEIL_CHECKPOINT_STALE" }),
    );
    await session.restore(checkpoint);
    await session.finalize();
    await session.finalize();
    expect(session.state()).toBe("finalized");
    expect(
      vi.mocked(target.transition).mock.calls.filter(([phase]) => phase === "finalize"),
    ).toHaveLength(1);
  });

  it("stays sealed and reports a collector that cannot acknowledge sealing", async () => {
    const target: VeilRuntimeCollector = {
      id: "recording",
      transition: vi.fn(async (phase, context) => {
        if (phase === "seal") throw new Error("recorder unavailable");
        return {
          schemaVersion: 1 as const,
          collectorId: "recording",
          phase,
          operationId: context.operationId,
          stateVersion: context.stateVersion,
          acknowledgedAt: new Date().toISOString(),
        };
      }),
    };
    const session = new VeilRuntimeSession([target], "a".repeat(64), "ctx");
    await expect(
      session.seal({ schemaVersion: 1, code: "VEIL_TEST", provenance: "runtime", retry: "unsafe" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "VEIL_COLLECTOR_SEAL_FAILED" }));
    expect(session.state()).toBe("sealed");
  });

  it("does not claim finalization when a collector fails to finalize", async () => {
    const target: VeilRuntimeCollector = {
      id: "trace",
      transition: vi.fn(async (phase, context) => {
        if (phase === "finalize") throw new Error("trace unavailable");
        return {
          schemaVersion: 1 as const,
          collectorId: "trace",
          phase,
          operationId: context.operationId,
          stateVersion: context.stateVersion,
          acknowledgedAt: new Date().toISOString(),
        };
      }),
    };
    const session = new VeilRuntimeSession([target], "a".repeat(64), "ctx");
    await expect(session.finalize()).rejects.toThrowError(
      expect.objectContaining({
        code: "VEIL_COLLECTOR_FINALIZE_FAILED",
        message: expect.stringContaining("trace"),
      }),
    );
    expect(session.state()).not.toBe("finalized");
  });

  it("finalizes collectors from the initial normal state with a valid positive state version", async () => {
    const target: VeilRuntimeCollector = {
      id: "trace",
      transition: vi.fn(async (phase, context) => {
        return {
          schemaVersion: 1 as const,
          collectorId: "trace",
          phase,
          operationId: context.operationId,
          stateVersion: context.stateVersion,
          acknowledgedAt: new Date().toISOString(),
        };
      }),
    };
    const session = new VeilRuntimeSession([target], "a".repeat(64), "ctx");
    await session.finalize();
    expect(session.state()).toBe("finalized");
    expect(vi.mocked(target.transition).mock.calls[0]?.[1].stateVersion).toBeGreaterThan(0);
  });
});
