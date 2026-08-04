import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** Veil is the sole owner of capability decisions and leases. */

import {
  VEIL_CONTRACT_VERSION,
  veilLeaseRequestSchema,
  veilPolicySnapshotSchema,
  type VeilCapabilityLease,
  type VeilDecision,
  type VeilDisposition,
  type VeilEvidenceChannel,
  type VeilLeaseRequest,
  type VeilPolicySnapshot,
  type VeilContext,
} from "@scry/contracts";

type StoredLease = { request: VeilLeaseRequest; lease: VeilCapabilityLease };

export class VeilAuthorityError extends Error {
  override name = "VeilAuthorityError";
  constructor(
    readonly code:
      | "VEIL_ORIGIN_FORBIDDEN"
      | "VEIL_CAPABILITY_REFUSED"
      | "VEIL_LEASE_INVALID"
      | "VEIL_LEASE_EXPIRED"
      | "VEIL_LEASE_CONTEXT_MISMATCH"
      | "VEIL_POLICY_STALE",
    message: string,
  ) {
    super(message);
  }
}

export class VeilAuthority {
  private policy: VeilPolicySnapshot;
  private readonly leases = new Map<string, StoredLease>();
  private readonly decisions = new Map<
    string,
    Readonly<{ disposition: VeilDisposition; reasonCode: string }>
  >();
  private decisionCacheHits = 0;
  private decisionCacheMisses = 0;

  constructor(
    snapshot: VeilPolicySnapshot,
    private readonly now: () => number = Date.now,
  ) {
    this.policy = veilPolicySnapshotSchema.parse(snapshot);
  }

  snapshot(): VeilPolicySnapshot {
    return this.policy;
  }

  updatePolicy(snapshot: VeilPolicySnapshot): void {
    const next = veilPolicySnapshotSchema.parse(snapshot);
    if (next.digest !== this.policy.digest) {
      this.leases.clear();
      this.decisions.clear();
    }
    this.policy = next;
  }

  decide(raw: VeilLeaseRequest): VeilDecision {
    const request = veilLeaseRequestSchema.parse(raw);
    if (!this.policy.allowedOrigins.includes(request.context.origin)) {
      throw new VeilAuthorityError(
        "VEIL_ORIGIN_FORBIDDEN",
        "Origin is not allowed by the active Veil policy",
      );
    }
    const cacheKey = `${this.policy.digest}:${JSON.stringify(request)}`;
    let cached = this.decisions.get(cacheKey);
    if (cached) this.decisionCacheHits += 1;
    else {
      const disposition = dispositionFor(request, this.policy);
      cached = Object.freeze({ disposition, reasonCode: reasonFor(request, disposition) });
      this.decisions.set(cacheKey, cached);
      this.decisionCacheMisses += 1;
    }
    return {
      schemaVersion: VEIL_CONTRACT_VERSION,
      decisionId: randomUUID(),
      policyDigest: this.policy.digest,
      disposition: cached.disposition,
      reasonCode: cached.reasonCode,
      decidedAt: new Date(this.now()).toISOString(),
    };
  }

  issueLease(raw: VeilLeaseRequest): { decision: VeilDecision; lease: VeilCapabilityLease } {
    const request = veilLeaseRequestSchema.parse(raw);
    const decision = this.decide(request);
    if (decision.disposition === "suppress" || decision.disposition === "quarantine") {
      throw new VeilAuthorityError(
        "VEIL_CAPABILITY_REFUSED",
        `Capability refused: ${decision.reasonCode}`,
      );
    }
    const token = `veil_${randomBytes(32).toString("base64url")}`;
    const lease = {
      schemaVersion: VEIL_CONTRACT_VERSION,
      token,
      policyDigest: this.policy.digest,
      expiresAt: new Date(this.now() + this.policy.leaseTtlMs).toISOString(),
    } satisfies VeilCapabilityLease;
    this.leases.set(token, { request: clone(request), lease });
    return { decision, lease };
  }

  validateLease(lease: VeilCapabilityLease, rawExpected: VeilLeaseRequest): VeilDecision {
    const expected = veilLeaseRequestSchema.parse(rawExpected);
    const stored = this.findLease(lease.token);
    if (!stored || !safeTokenEqual(stored.lease.token, lease.token))
      throw new VeilAuthorityError("VEIL_LEASE_INVALID", "Capability lease is invalid");
    if (
      stored.lease.policyDigest !== this.policy.digest ||
      lease.policyDigest !== this.policy.digest
    )
      throw new VeilAuthorityError("VEIL_POLICY_STALE", "Capability lease policy is stale");
    if (
      this.now() >= Date.parse(stored.lease.expiresAt) ||
      lease.expiresAt !== stored.lease.expiresAt
    ) {
      this.leases.delete(lease.token);
      throw new VeilAuthorityError("VEIL_LEASE_EXPIRED", "Capability lease has expired");
    }
    if (!sameRequest(stored.request, expected))
      throw new VeilAuthorityError(
        "VEIL_LEASE_CONTEXT_MISMATCH",
        "Capability lease does not match the requested context and scope",
      );
    return this.decide(expected);
  }

  invalidateContext(match: Partial<VeilLeaseRequest["context"]>): number {
    let invalidated = 0;
    for (const [token, stored] of this.leases) {
      if (
        Object.entries(match).every(
          ([key, value]) =>
            stored.request.context[key as keyof VeilLeaseRequest["context"]] === value,
        )
      ) {
        this.leases.delete(token);
        invalidated += 1;
      }
    }
    return invalidated;
  }

  revoke(lease: VeilCapabilityLease): boolean {
    return this.leases.delete(lease.token);
  }

  cacheStats(): Readonly<{ hits: number; misses: number; entries: number; policyDigest: string }> {
    return Object.freeze({
      hits: this.decisionCacheHits,
      misses: this.decisionCacheMisses,
      entries: this.decisions.size,
      policyDigest: this.policy.digest,
    });
  }

  private findLease(token: string): StoredLease | undefined {
    return this.leases.get(token);
  }
}

export function createDefaultVeilContext(input: {
  transactionId: string;
  origin: string;
  browserContextId: string;
  pageId: string;
  frameId: string;
  documentEpoch: number;
  userId?: string;
  environmentId?: string;
}): VeilContext {
  return {
    userId: input.userId ?? "local-user",
    environmentId: input.environmentId ?? "local-environment",
    transactionId: input.transactionId,
    origin: input.origin,
    browserContextId: input.browserContextId,
    pageId: input.pageId,
    frameId: input.frameId,
    documentEpoch: input.documentEpoch,
  };
}

function dispositionFor(request: VeilLeaseRequest, policy: VeilPolicySnapshot): VeilDisposition {
  if (request.classification === "unknown") return "quarantine";
  if (request.classification === "secret") return "suppress";
  const enabled = channelEnabled(request.channel, policy);
  if (!enabled) return "suppress";
  if (request.classification === "sensitive")
    return request.channel === "screenshot" || request.channel === "video"
      ? "sanitize"
      : "suppress";
  return structured(request.channel) ? "sanitize" : "allow";
}

function channelEnabled(channel: VeilEvidenceChannel, policy: VeilPolicySnapshot): boolean {
  const mapping: Record<VeilEvidenceChannel, keyof VeilPolicySnapshot["controls"] | undefined> = {
    screenshot: "screenshots",
    video: "video",
    dom: "dom",
    accessibility: "accessibility",
    console: "diagnostics",
    page_error: "diagnostics",
    network: "network",
    event: undefined,
    report: undefined,
    metadata: undefined,
    trace: "trace",
    clipboard: "clipboard",
    download: "downloads",
  };
  const control = mapping[channel];
  return control === undefined || policy.controls[control];
}

function structured(channel: VeilEvidenceChannel): boolean {
  return [
    "dom",
    "accessibility",
    "console",
    "page_error",
    "network",
    "event",
    "report",
    "metadata",
    "trace",
  ].includes(channel);
}

function reasonFor(request: VeilLeaseRequest, disposition: VeilDisposition): string {
  if (request.classification === "unknown") return "VEIL_UNKNOWN_QUARANTINED";
  if (request.classification === "secret") return "VEIL_SECRET_SUPPRESSED";
  if (disposition === "suppress") return "VEIL_CHANNEL_DISABLED";
  if (disposition === "sanitize") return "VEIL_SANITIZATION_REQUIRED";
  return "VEIL_ALLOWED";
}

function sameRequest(left: VeilLeaseRequest, right: VeilLeaseRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
