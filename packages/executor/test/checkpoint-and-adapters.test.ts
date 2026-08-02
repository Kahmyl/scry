import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { AdapterRegistry, builtInAdapterRegistry, CheckpointCoordinator, structureFingerprint } from "../src/index.js";

const checkpoint = { id: "safe", beforeStepId: "protected", restorationUrl: "https://example.test/safe", verificationAssertions: [{ type: "url" as const, expected: "/safe", match: "path" as const }], continueAtStepId: "continue", maxRestorations: 1 as const, state: { cookies: true as const, localStorage: true as const, indexedDb: true } };

describe("deterministic checkpoint recovery", () => {
  it("destroys uncertainty before creating and verifying the restored context", async () => {
    const order: string[] = []; let persisted: unknown;
    const store = { establish: vi.fn(async (input) => { persisted = input; }), claim: vi.fn(async () => ({ payload: (persisted as { payload: unknown }).payload, bindingFingerprint: (persisted as { bindingFingerprint: string }).bindingFingerprint })), complete: vi.fn(async () => undefined) };
    const coordinator = new CheckpointCoordinator({ runId: "run", flowRevisionId: "revision", environmentId: "environment", allowedOrigins: ["https://example.test"], store: store as never });
    const original = { storageState: vi.fn(async () => ({ cookies: [], origins: [] })), close: vi.fn(async () => { order.push("old-context-destroyed"); }) } as unknown as BrowserContext;
    await coordinator.establish(original, checkpoint);
    const page = { goto: vi.fn(async () => { order.push("restored-navigation"); }), url: vi.fn(() => "https://example.test/safe") } as unknown as Page;
    await coordinator.restore(checkpoint, original, async () => { order.push("new-context-created"); return { context: { close: vi.fn() } as unknown as BrowserContext, page }; }, async () => { order.push("boundary-verified"); });
    expect(order).toEqual(["old-context-destroyed", "new-context-created", "restored-navigation", "boundary-verified"]);
    expect(store.complete).toHaveBeenCalledWith("safe", "verified");
  });

  it("destroys a claimed checkpoint and aborts when binding verification fails", async () => {
    const store = { establish: vi.fn(), claim: vi.fn(async () => ({ payload: { cookies: [], origins: [] }, bindingFingerprint: "tampered" })), complete: vi.fn(async () => undefined) };
    const coordinator = new CheckpointCoordinator({ runId: "run", flowRevisionId: "revision", environmentId: "environment", allowedOrigins: ["https://example.test"], store: store as never });
    const original = { close: vi.fn(async () => undefined) } as unknown as BrowserContext;
    await expect(coordinator.restore(checkpoint, original, vi.fn(), vi.fn())).rejects.toMatchObject({ code: "CHECKPOINT_BINDING_MISMATCH" });
    expect(store.complete).toHaveBeenCalledWith("safe", "failed", "CHECKPOINT_BINDING_MISMATCH");
  });
});

describe("calibration and built-in adapters", () => {
  it("produces stable fingerprints for reordered structural sets and changes on drift", () => {
    const base = { origin: "https://example.test", pathTemplate: "/credentials", frames: ["main"], containers: ["dialog","main"], roles: ["button"], accessibleNames: [], testIds: ["secret"], approvedAttributes: {}, anchors: [] };
    expect(structureFingerprint(base)).toBe(structureFingerprint({ ...base, containers: ["main","dialog"] }));
    expect(structureFingerprint(base)).not.toBe(structureFingerprint({ ...base, testIds: ["changed"] }));
    expect(structureFingerprint(base)).not.toBe(structureFingerprint({ ...base, anchors: [{ intentDigest: "a".repeat(64), semanticFingerprint: "b".repeat(64), matchCount: "one", visible: true, tag: "button", role: "button", ancestors: ["dialog"] }] }));
  });
  it("extracts an exact configured network value only inside protection", async () => {
    const secrets: string[] = [];
    const context = { page: {} as Page, allowedOrigins: ["https://example.test"], protectedInterval: true, registerSecret: (value: string) => secrets.push(value), networkResponses: [{ origin: "https://example.test", method: "POST", path: "/issue", body: { token: "canary" } }] };
    await builtInAdapterRegistry.execute("gauntlet.network", context, { origin: "https://example.test", method: "POST", path: "/issue", jsonPointer: "/token" });
    expect(secrets).toEqual(["canary"]);
    await expect(builtInAdapterRegistry.execute("gauntlet.network", { ...context, protectedInterval: false }, { origin: "https://example.test", method: "POST", path: "/issue", jsonPointer: "/token" })).rejects.toMatchObject({ code: "ADAPTER_REQUIRES_PROTECTED_INTERVAL" });
  });
  it("does not permit arbitrary adapter registration collisions", () => {
    const registry = new AdapterRegistry(); const adapter = { id: "fixed", capability: "safe_exit" as const, validate: () => ({}), suppressedChannels: [], timeoutMs: 100, execute: async () => ({ code: "ADAPTER_COMPLETED" as const, durationMs: 0 }) };
    registry.register(adapter); expect(() => registry.register(adapter)).toThrow("ADAPTER_ALREADY_REGISTERED");
  });
});
