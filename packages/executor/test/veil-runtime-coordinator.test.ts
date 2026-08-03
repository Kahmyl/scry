import { describe, expect, it, vi } from "vitest";

import { VeilRuntimeCoordinator, PrivacyTransitionError, type PrivacyCollector } from "../src/veil-runtime-coordinator.js";

function collector(name: string, overrides: Partial<PrivacyCollector> = {}): PrivacyCollector {
  let status: ReturnType<PrivacyCollector["state"]>["status"]="active";
  return { name, arm: vi.fn(async () => {status="prepared";}), suspend:vi.fn(async()=>{status="suspended";}),isolate:vi.fn(async()=>{status="isolated";}), resume: vi.fn(async () => {status="active";}), seal: vi.fn(async () => {status="sealed";}), finalize: vi.fn(async () => {status="finalized";}),state:()=>({status}), ...overrides };
}

const boundary = { kind: "protected_surface_closed" as const, verifier: { concept:"Credential dialog closed",requiredCapabilities:["readable_value" as const],preferredEvidence:{roles:["dialog" as const],names:["Credential dialog"],labels:[],descriptions:[],placeholders:[],inputTypes:[]},scope:{kind:"page" as const},relations:[],prohibited:[],risk:"protected" as const,confidence:{requiredFamilies:[],minimumFamilyCount:1} } };

describe("VeilRuntimeCoordinator", () => {
  it("requires every collector before reveal and resumes only after a safe boundary", async () => {
    const recording = collector("recording");
    const trace = collector("trace");
    const states: string[] = [];
    const gate = new VeilRuntimeCoordinator([recording, trace], async ({ state }) => { states.push(state); });
    await gate.prepare("synthetic");
    expect(gate.state()).toBe("ready_to_reveal");
    expect(recording.suspend).toHaveBeenCalledOnce();
    expect(recording.isolate).toHaveBeenCalledOnce();
    expect(trace.suspend).toHaveBeenCalledOnce();
    expect(trace.isolate).toHaveBeenCalledOnce();
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
    const gate = new VeilRuntimeCoordinator([collector("recording")]);
    await expect(gate.beginProtected()).rejects.toBeInstanceOf(PrivacyTransitionError);
  });

  it("seals when a collector cannot arm and never reaches reveal", async () => {
    const failing = collector("trace", { arm: vi.fn(async () => { throw new Error("trace failed"); }) });
    const gate = new VeilRuntimeCoordinator([collector("recording"), failing]);
    await expect(gate.prepare("synthetic")).rejects.toBeInstanceOf(PrivacyTransitionError);
    expect(gate.state()).toBe("sealed");
    expect(gate.getDecision("video")).toBe("quarantine");
  });

  it("refuses a false suspend acknowledgement and seals all collectors", async()=>{
    const liar=collector("liar",{suspend:vi.fn(async()=>undefined)});
    const peer=collector("peer");
    const gate=new VeilRuntimeCoordinator([liar,peer]);
    await expect(gate.prepare("synthetic")).rejects.toThrow("COLLECTOR_ARM_FAILED:Collectors failed suspend: liar:TRANSITION_FAILED");
    expect(gate.state()).toBe("sealed");
    expect(peer.seal).toHaveBeenCalled();
  });

  it("cannot resume directly from protected or reopen after sealing", async () => {
    const gate = new VeilRuntimeCoordinator([collector("recording")]);
    await gate.prepare("synthetic");
    await gate.beginProtected();
    await expect(gate.confirmSafeBoundary(boundary)).rejects.toBeInstanceOf(PrivacyTransitionError);
    await gate.seal({ code: "SYNTHETIC_FAILURE" });
    await expect(gate.prepare("next")).rejects.toBeInstanceOf(PrivacyTransitionError);
  });

  it("serializes concurrent prepare requests", async () => {
    const gate = new VeilRuntimeCoordinator([collector("recording")]);
    const results = await Promise.allSettled([gate.prepare("first"), gate.prepare("second")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("seals incomplete transitions during idempotent finalization", async () => {
    const target = collector("recording");
    const gate = new VeilRuntimeCoordinator([target]);
    await gate.prepare("synthetic");
    await gate.finalize();
    await gate.finalize();
    expect(gate.state()).toBe("sealed");
    expect(target.finalize).toHaveBeenCalledTimes(1);
  });
});
