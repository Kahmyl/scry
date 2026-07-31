import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { Action, ExecutionPolicyV1, TestPlan } from "@scry/contracts";

export { SecretRedactor } from "./redactor.js";

export type RuntimePolicyViolationCode =
  | "SCHEME_NOT_ALLOWED"
  | "ORIGIN_NOT_ALLOWED"
  | "PRIVATE_NETWORK_NOT_ALLOWED"
  | "POPUP_NOT_ALLOWED"
  | "DOWNLOAD_NOT_ALLOWED";

export class RuntimePolicyError extends Error {
  constructor(
    readonly code: RuntimePolicyViolationCode,
    message: string,
    readonly target?: string,
  ) {
    super(message);
    this.name = "RuntimePolicyError";
  }
}

export type ActionCapability =
  | "navigation"
  | "interaction"
  | "secret_input"
  | "observation"
  | "evidence";

export function classifyAction(action: Action): ActionCapability {
  if (action.type === "navigate") return "navigation";
  if (action.type === "fill" && (action.secretRef || action.capturedSecretRef)) return "secret_input";
  if (action.type === "captureSecret") return "secret_input";
  if (action.type === "waitFor" || action.type === "scroll") return "observation";
  if (action.type === "screenshot") return "evidence";
  return "interaction";
}

export class RuntimeRequestPolicy {
  private readonly origins: Set<string>;
  private readonly addressCache = new Map<string, Promise<string[]>>();

  constructor(
    _plan: TestPlan,
    private readonly policy: ExecutionPolicyV1,
  ) {
    this.origins = new Set(
      policy.allowedOrigins.map((value) => new URL(value).origin),
    );
  }

  async assertAllowed(rawUrl: string) {
    const url = new URL(rawUrl);
    this.assertHttpScheme(url);
    if (!this.origins.has(url.origin)) {
      throw new RuntimePolicyError(
        "ORIGIN_NOT_ALLOWED",
        `Request origin is not allowed: ${url.origin}`,
        redactUrlCredentials(url),
      );
    }
    await this.assertPublicNetwork(url);
  }

  async assertSafeSubresource(rawUrl: string) {
    const url = new URL(rawUrl);
    this.assertHttpScheme(url);
    await this.assertPublicNetwork(url);
  }

  isAllowedOrigin(rawUrl: string) {
    return this.origins.has(new URL(rawUrl).origin);
  }

  private assertHttpScheme(url: URL) {
    if (url.protocol === "http:" || url.protocol === "https:") return;
    throw new RuntimePolicyError(
      "SCHEME_NOT_ALLOWED",
      `URL scheme is not allowed: ${url.protocol}`,
      redactUrlCredentials(url),
    );
  }

  private async assertPublicNetwork(url: URL) {
    if (this.policy.allowPrivateNetwork) return;
    const addresses = await this.resolveAddresses(url.hostname);
    if (isLocalHostname(url.hostname) || addresses.some(isPrivateAddress)) {
      throw new RuntimePolicyError(
        "PRIVATE_NETWORK_NOT_ALLOWED",
        `Private or local network destination is not allowed: ${url.hostname}`,
        redactUrlCredentials(url),
      );
    }
  }

  private resolveAddresses(hostname: string) {
    const cached = this.addressCache.get(hostname);
    if (cached) return cached;
    const result = isIP(hostname)
      ? Promise.resolve([hostname])
      : lookup(hostname, { all: true }).then((records) =>
          records.map((record) => record.address),
        );
    this.addressCache.set(hostname, result);
    return result;
  }
}

export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
}

function redactUrlCredentials(url: URL) {
  const safe = new URL(url);
  if (safe.username) safe.username = "[REDACTED]";
  if (safe.password) safe.password = "[REDACTED]";
  return safe.href;
}
