import { describe, expect, it, vi } from "vitest";

import { PrivacyGate, PrivacyTransitionError, type PrivacyCollector } from "../src/privacy-gate.js";

function collector(name: string, overrides: Partial<PrivacyCollector> = {}): PrivacyCollector {
  return { name, arm: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), seal: vi.fn(async () => undefined), finalize: vi.fn(async () => undefined), ...overrides };
}

const boundary = { kind: "protected_surface_closed" as const, verifier: { concept:"Credential dialog closed",requiredCapabilities:["readable_value" as const],preferredEvidence:{roles:["dialog" as const],names:["Credential dialog"],labels:[],descriptions:[],placeholders:[],inputTypes:[]},scope:{kind:"page" as const},relations:[],prohibited:[],risk:"protected" as const,confidence:{requiredFamilies:[],minimumFamilyCount:1} } };

describe("PrivacyGate", () => {
  it("requires every collector before reveal and resumes only after a safe boundary", async () => {
    const recording = collector("recording");
    const trace = collector("trace");
    const states: string[] = [];
    const gate = new PrivacyGate([recording, trace], async ({ state }) => { states.push(state); });
    await gate.prepare("synthetic");
    expect(gate.state()).toBe("ready_to_reveal");
    await gate.beginProtected();
    expect(gate.getDecision("screenshot")).toBe("suppress");
    expect(gate.getDecision("event")).toBe("sanitize");
    await gate.markCaptured();
    await gate.beginSafeBoundary();
    await gate.confirmSafeBoundary(boundary);
    expect(gate.state()).toBe("normal");
    expect(recording.resume).toHaveBeenCalledWith(boundary);
    expect(states).toEqual(["arming", "armed", "ready_to_reveal", "protected", "captured", "establishing_safe_boundary", "safe_to_resume", "normal"]);
  });

  it("rejects reveal before acknowledgements", async () => {
    const gate = new PrivacyGate([collector("recording")]);
    await expect(gate.beginProtected()).rejects.toBeInstanceOf(PrivacyTransitionError);
  });

  it("seals when a collector cannot arm and never reaches reveal", async () => {
    const failing = collector("trace", { arm: vi.fn(async () => { throw new Error("trace failed"); }) });
    const gate = new PrivacyGate([collector("recording"), failing]);
    await expect(gate.prepare("synthetic")).rejects.toBeInstanceOf(PrivacyTransitionError);
    expect(gate.state()).toBe("sealed");
    expect(gate.getDecision("video")).toBe("quarantine");
  });

  it("cannot resume directly from protected or reopen after sealing", async () => {
    const gate = new PrivacyGate([collector("recording")]);
    await gate.prepare("synthetic");
    await gate.beginProtected();
    await expect(gate.confirmSafeBoundary(boundary)).rejects.toBeInstanceOf(PrivacyTransitionError);
    await gate.seal({ code: "SYNTHETIC_FAILURE" });
    await expect(gate.prepare("next")).rejects.toBeInstanceOf(PrivacyTransitionError);
  });

  it("serializes concurrent prepare requests", async () => {
    const gate = new PrivacyGate([collector("recording")]);
    const results = await Promise.allSettled([gate.prepare("first"), gate.prepare("second")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("seals incomplete transitions during idempotent finalization", async () => {
    const target = collector("recording");
    const gate = new PrivacyGate([target]);
    await gate.prepare("synthetic");
    await gate.finalize();
    await gate.finalize();
    expect(gate.state()).toBe("sealed");
    expect(target.finalize).toHaveBeenCalledTimes(1);
  });
});
