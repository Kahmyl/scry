import type { Page } from "playwright";
import { markVeilProtectedClipboardTouched } from "./veil-clipboard-collector.js";

export type AdapterCapability = "clipboard_extraction" | "network_extraction" | "safe_exit" | "credential_revocation";
export type AdapterResult<T = unknown> = { value?: T; code: "ADAPTER_COMPLETED"; durationMs: number };
export type AdapterContext = {
  page: Page; allowedOrigins: string[]; protectedInterval: boolean;
  registerSecret(value: string): void;
  networkResponses?: Array<{ origin: string; method: string; path: string; body: unknown }>;
  revoke?: (input: { endpoint: string; credentialId: string; signal: AbortSignal }) => Promise<boolean>;
};
export type BuiltInAdapter<T = unknown> = {
  id: string; capability: AdapterCapability; validate(configuration: unknown): T; suppressedChannels: string[]; timeoutMs: number;
  execute(context: AdapterContext, configuration: T): Promise<AdapterResult>;
};

export class AdapterRegistry {
  private readonly adapters = new Map<string, BuiltInAdapter>();
  register(adapter: BuiltInAdapter) { if (this.adapters.has(adapter.id)) throw new Error("ADAPTER_ALREADY_REGISTERED"); this.adapters.set(adapter.id, adapter); return this; }
  describe() { return [...this.adapters.values()].map(({ id, capability, suppressedChannels, timeoutMs }) => ({ id, capability, suppressedChannels, timeoutMs })); }
  async execute(id: string, context: AdapterContext, configuration: unknown) {
    const adapter = this.adapters.get(id); if (!adapter) throw new AdapterError("ADAPTER_NOT_REGISTERED", id);
    const parsed = adapter.validate(configuration);
    const started = Date.now();
    try { return await bounded(adapter.execute(context, parsed), adapter.timeoutMs, id); }
    catch (error) { if (error instanceof AdapterError) throw error; throw new AdapterError("ADAPTER_FAILED", id, Date.now() - started); }
  }
}

const clipboard: BuiltInAdapter<Record<string, never>> = {
  id: "gauntlet.clipboard", capability: "clipboard_extraction", validate: (value) => object(value, []) as Record<string, never>,
  suppressedChannels: ["video","trace","screenshot","dom","accessibility","console","page_error","network","report","event"], timeoutMs: 2_000,
  async execute(context) {
    requireProtected(context); const started = Date.now();
    const lifecycleOwned = markVeilProtectedClipboardTouched(context.page);
    const value = await context.page.evaluate(() => navigator.clipboard.readText());
    if (!value) throw new AdapterError("ADAPTER_VALUE_EMPTY", "gauntlet.clipboard");
    context.registerSecret(value);
    if (!lifecycleOwned) await context.page.evaluate(() => navigator.clipboard.writeText(""));
    return { value, code: "ADAPTER_COMPLETED", durationMs: Date.now() - started };
  },
};
type NetworkConfiguration = { origin: string; method: string; path: string; jsonPointer: string };
const network: BuiltInAdapter<NetworkConfiguration> = {
  id: "gauntlet.network", capability: "network_extraction", validate: (value) => { const item = object(value, ["origin","method","path","jsonPointer"]); new URL(text(item.origin)); const method = text(item.method); const path = text(item.path); const jsonPointer = text(item.jsonPointer); if (!/^[A-Z]+$/.test(method) || !path.startsWith("/") || !jsonPointer.startsWith("/")) throw new AdapterError("ADAPTER_CONFIGURATION_INVALID", "gauntlet.network"); return { origin: text(item.origin), method, path, jsonPointer }; },
  suppressedChannels: ["network","report","event","metadata"], timeoutMs: 2_000,
  async execute(context, config) {
    requireProtected(context); if (!context.allowedOrigins.includes(new URL(config.origin).origin)) throw new AdapterError("ADAPTER_ORIGIN_DENIED", "gauntlet.network");
    const started = Date.now(); const response = context.networkResponses?.find((item) => item.origin === new URL(config.origin).origin && item.method === config.method && item.path === config.path);
    const value = pointer(response?.body, config.jsonPointer); if (typeof value !== "string" || !value) throw new AdapterError("ADAPTER_VALUE_UNAVAILABLE", "gauntlet.network");
    context.registerSecret(value); return { value, code: "ADAPTER_COMPLETED", durationMs: Date.now() - started };
  },
};
type SafeExitConfiguration = { kind: "close_page" | "navigate"; url?: string };
const safeExit: BuiltInAdapter<SafeExitConfiguration> = {
  id: "gauntlet.safe-exit", capability: "safe_exit", validate: (value) => { const item = object(value, ["kind","url"]); const kind = text(item.kind); if (kind !== "close_page" && kind !== "navigate") throw new AdapterError("ADAPTER_CONFIGURATION_INVALID", "gauntlet.safe-exit"); return { kind, ...(item.url ? { url: text(item.url) } : {}) }; }, suppressedChannels: ["trace","screenshot","dom","accessibility","console","page_error","network"], timeoutMs: 5_000,
  async execute(context, config) { const started = Date.now(); if (config.kind === "close_page") await context.page.close(); else { if (!config.url || !context.allowedOrigins.includes(new URL(config.url).origin)) throw new AdapterError("ADAPTER_ORIGIN_DENIED", "gauntlet.safe-exit"); await context.page.goto(config.url); } return { code: "ADAPTER_COMPLETED", durationMs: Date.now() - started }; },
};
type RevocationConfiguration = { endpoint: string; credentialId: string };
const revocation: BuiltInAdapter<RevocationConfiguration> = {
  id: "gauntlet.revocation", capability: "credential_revocation", validate: (value) => { const item = object(value, ["endpoint","credentialId"]); const endpoint = text(item.endpoint); new URL(endpoint); const credentialId = text(item.credentialId); if (!/^[0-9a-f-]{36}$/i.test(credentialId)) throw new AdapterError("ADAPTER_CONFIGURATION_INVALID", "gauntlet.revocation"); return { endpoint, credentialId }; }, suppressedChannels: ["network","report","event","metadata"], timeoutMs: 5_000,
  async execute(context, config) { const started = Date.now(); if (!context.revoke || !context.allowedOrigins.includes(new URL(config.endpoint).origin)) throw new AdapterError("ADAPTER_ORIGIN_DENIED", "gauntlet.revocation"); const controller = new AbortController(); const ok = await context.revoke({ ...config, signal: controller.signal }); if (!ok) throw new AdapterError("ADAPTER_REVOCATION_FAILED", "gauntlet.revocation"); return { code: "ADAPTER_COMPLETED", durationMs: Date.now() - started }; },
};

export const builtInAdapterRegistry = new AdapterRegistry().register(clipboard).register(network).register(safeExit).register(revocation);
export class AdapterError extends Error { constructor(readonly code: string, readonly adapterId: string, readonly durationMs = 0) { super(code); } }
function requireProtected(context: AdapterContext) { if (!context.protectedInterval) throw new AdapterError("ADAPTER_REQUIRES_PROTECTED_INTERVAL", "unknown"); }
function pointer(input: unknown, value: string): unknown { return value.split("/").slice(1).reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined, input); }
function object(value: unknown, allowed: string[]) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdapterError("ADAPTER_CONFIGURATION_INVALID", "unknown"); const item = value as Record<string, unknown>; if (Object.keys(item).some((key) => !allowed.includes(key))) throw new AdapterError("ADAPTER_CONFIGURATION_INVALID", "unknown"); return item; }
function text(value: unknown) { if (typeof value !== "string" || !value) throw new AdapterError("ADAPTER_CONFIGURATION_INVALID", "unknown"); return value; }
async function bounded<T>(work: Promise<T>, timeoutMs: number, adapterId: string) { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AdapterError("ADAPTER_TIMED_OUT", adapterId, timeoutMs)), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
