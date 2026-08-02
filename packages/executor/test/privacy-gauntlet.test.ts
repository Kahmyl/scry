import { describe, expect, it, vi } from "vitest";
import type { EvidenceChannel } from "@scry/contracts";

import { PrivacyGate, type PrivacyCollector } from "../src/privacy-gate.js";

const unsafeChannels: EvidenceChannel[] = ["trace", "screenshot", "dom", "accessibility", "console", "page_error", "network", "clipboard", "download"];
const sanitizedChannels: EvidenceChannel[] = ["event", "report", "metadata"];

function collector(name: string, overrides: Partial<PrivacyCollector> = {}): PrivacyCollector {
  return { name, arm: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), seal: vi.fn(async () => undefined), finalize: vi.fn(async () => undefined), ...overrides };
}

describe("Scry Privacy Gauntlet", () => {
  it("admits no evidence-bearing channel during a recording-gap operation", async () => {
    const gate = new PrivacyGate([
      collector("recording"), collector("trace"), collector("dom"), collector("diagnostics"), collector("network"), collector("reports"),
    ]);
    await gate.prepare("gauntlet", { mode: "protected_recording_gap", videoMaskEstablished: false });
    await gate.beginProtected();
    expect(gate.getDecision("video")).toBe("suppress");
    for (const channel of unsafeChannels) expect(gate.getDecision(channel), channel).toBe("suppress");
    for (const channel of sanitizedChannels) expect(gate.getDecision(channel), channel).toBe("sanitize");
  });

  it.each(["recording", "trace", "dom", "diagnostics", "network", "reports"])(
    "seals before reveal when %s cannot arm",
    async (failed) => {
      const names = ["recording", "trace", "dom", "diagnostics", "network", "reports"];
      const gate = new PrivacyGate(names.map((name) => collector(name, name === failed ? { arm: vi.fn(async () => { throw new Error("INJECTED_FAILURE"); }) } : {})));
      await expect(gate.prepare("gauntlet-failure")).rejects.toThrow("COLLECTOR_ARM_FAILED");
      expect(gate.state()).toBe("sealed");
      for (const channel of [...unsafeChannels, ...sanitizedChannels, "video"] as EvidenceChannel[]) {
        expect(gate.getDecision(channel), channel).toBe("quarantine");
      }
    },
  );

  it("cannot reopen evidence after cancellation in a protected interval", async () => {
    const recording = collector("recording");
    const gate = new PrivacyGate([recording, collector("trace")]);
    await gate.prepare("cancelled-operation");
    await gate.beginProtected();
    await gate.seal({ code: "RUN_CANCELLED" });
    await gate.terminate("continuing_unrecorded");
    await expect(gate.prepare("unsafe-retry")).rejects.toThrow();
    expect(recording.resume).not.toHaveBeenCalled();
    expect(gate.getDecision("video")).toBe("quarantine");
  });
});
