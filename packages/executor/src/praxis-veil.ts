import { createHash } from "node:crypto";
import type { PraxisRequest, VeilCapabilityLease, VeilEvidenceChannel, VeilLeaseRequest, VeilOperation } from "@scry/contracts";
import type { Page } from "playwright";
import { VeilAuthority, VeilAuthorityError } from "./veil-authority.js";

type Registration = { authority: VeilAuthority; userId: string; environmentId: string; browserContextId: string };
type Grant = { request: VeilLeaseRequest; lease: VeilCapabilityLease };
export type PraxisVeilBoundary = "schedule" | "observe" | "interact" | "protected_transaction" | "produce_evidence" | "admit_result";
type Authorization = { registration: Registration; grants: Map<string, Grant>; released: boolean; binding?: string };

const registrations = new WeakMap<Page, Registration>();
// Capability ownership is bound to the exact authorized request object. Transaction
// identifiers are audit correlation values and are not capability handles.
const authorizations = new WeakMap<PraxisRequest, Authorization>();

export class PraxisVeilAuthorizationError extends Error {
  override name = "PraxisVeilAuthorizationError";
  readonly code: string;
  constructor(readonly boundary: PraxisVeilBoundary, cause: unknown) {
    const reason = cause instanceof VeilAuthorityError ? cause.code : "VEIL_CAPABILITY_REFUSED";
    super(`PRAXIS_VEIL_${boundary.toUpperCase()}_REFUSED`);
    this.code = `PRAXIS_VEIL_${boundary.toUpperCase()}_REFUSED`;
    // Do not retain the authority message: it is not part of Praxis-safe diagnostics.
    Object.defineProperty(this, "cause", { value: reason, enumerable: false });
  }
}

export function registerPraxisVeilAuthority(page: Page, registration: Registration): () => void {
  registrations.set(page, registration);
  return () => { if (registrations.get(page) === registration) registrations.delete(page); };
}

export function authorizePraxisRequest(page: Page, request: PraxisRequest): PraxisRequest {
  const registration = registrations.get(page);
  if (!registration) throw new PraxisVeilAuthorizationError("schedule", new Error("VEIL_PRAXIS_AUTHORITY_REQUIRED"));
  const allowed: string[] = [];
  const suppressed = new Set(request.privacy.suppressedChannels);
  const authorized = { ...request, privacy: { ...request.privacy, allowedChannels: allowed, suppressedChannels: [...suppressed] } };
  const state: Authorization = { registration, grants: new Map(), released: false };
  authorizations.set(authorized, state);

  // Scheduling is mandatory. Evidence channels are optional and explicitly
  // degrade when Veil refuses them.
  requireGrant(authorized, "schedule", "metadata", "public", "operation");
  for (const praxisChannel of request.privacy.allowedChannels) {
    const channel = veilChannel(praxisChannel);
    if (!channel) { suppressed.add(praxisChannel); continue; }
    try {
      requireGrant(authorized, "observe", channel, praxisChannel === "protected" ? "sensitive" : "public", "channel");
      allowed.push(praxisChannel);
    } catch { suppressed.add(praxisChannel); }
  }
  authorized.privacy.suppressedChannels = [...suppressed];
  state.binding = digestRequest(authorized);
  return authorized;
}

export function validatePraxisVeilBoundary(request: PraxisRequest, boundary: PraxisVeilBoundary): void {
  if (boundary === "observe") { validateObservationGrants(request); return; }
  const operation = operationFor(boundary);
  const channel = channelFor(boundary);
  const classification = "public" as const; // control-plane permission; protected values are never carried in the request
  const grant = requireGrant(request, operation, channel, classification, "operation", boundary);
  const state = authorization(request, boundary);
  try { state.registration.authority.validateLease(grant.lease, grant.request); }
  catch (error) { throw new PraxisVeilAuthorizationError(boundary, error); }
}

/** Compatibility validator now proves both mandatory pre-observation boundaries. */
export function validatePraxisVeilGrants(request: PraxisRequest): void {
  validatePraxisVeilBoundary(request, "schedule");
  validateObservationGrants(request);
}

function validateObservationGrants(request: PraxisRequest): void {
  const state = authorization(request, "observe");
  for (const [key, grant] of state.grants) {
    if (!key.startsWith("observe:")) continue;
    try { state.registration.authority.validateLease(grant.lease, grant.request); }
    catch (error) { throw new PraxisVeilAuthorizationError("observe", error); }
  }
}

export function releasePraxisVeilGrants(request: PraxisRequest): void {
  const state = authorizations.get(request);
  if (!state || state.released) return;
  state.released = true;
  for (const grant of state.grants.values()) state.registration.authority.revoke(grant.lease);
  state.grants.clear();
  authorizations.delete(request);
}

function requireGrant(request: PraxisRequest, operation: VeilOperation, channel: VeilEvidenceChannel, classification: VeilLeaseRequest["classification"], scope: VeilLeaseRequest["scope"], boundary: PraxisVeilBoundary = operation === "observe" ? "observe" : "schedule"): Grant {
  const state = authorization(request, boundary);
  const key = `${operation}:${channel}:${classification}:${scope}`;
  const existing = state.grants.get(key);
  if (existing) return existing;
  const leaseRequest: VeilLeaseRequest = {
    context: {
      userId: state.registration.userId, environmentId: state.registration.environmentId,
      transactionId: request.transactionId, origin: request.context.origin,
      browserContextId: state.registration.browserContextId, pageId: request.context.pageId,
      frameId: "main-frame", documentEpoch: request.context.documentEpoch,
    },
    operation, channel, classification, scope,
  };
  try {
    const { lease } = state.registration.authority.issueLease(leaseRequest);
    const grant = { request: leaseRequest, lease };
    state.grants.set(key, grant);
    return grant;
  } catch (error) { throw new PraxisVeilAuthorizationError(boundary, error); }
}

function authorization(request: PraxisRequest, boundary: PraxisVeilBoundary): Authorization {
  const state = authorizations.get(request);
  if (!state || state.released) throw new PraxisVeilAuthorizationError(boundary, new Error("VEIL_PRAXIS_GRANT_REQUIRED"));
  if (state.binding && state.binding !== digestRequest(request)) throw new PraxisVeilAuthorizationError(boundary, new Error("VEIL_PRAXIS_REQUEST_CHANGED"));
  return state;
}

function operationFor(boundary: PraxisVeilBoundary): VeilOperation {
  if (boundary === "produce_evidence") return "capture";
  if (boundary === "admit_result") return "admit_evidence";
  return boundary;
}
function channelFor(boundary: PraxisVeilBoundary): VeilEvidenceChannel {
  if (boundary === "schedule") return "metadata";
  if (boundary === "interact" || boundary === "protected_transaction") return "event";
  return "report";
}
function veilChannel(channel: string): VeilEvidenceChannel | undefined {
  if (channel === "public_dom") return "dom";
  if (channel === "accessibility") return "accessibility";
  if (channel === "visual" || channel === "ocr") return "screenshot";
  if (channel === "protected") return "dom";
  return undefined;
}
function digestRequest(request: PraxisRequest): string { return createHash("sha256").update(stable(request)).digest("hex"); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
