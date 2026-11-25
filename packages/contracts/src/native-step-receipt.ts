import { z } from "zod";

/** Private parent/worker proof, never accepted from a browser page or MCP input.
 * The challenge binds the acknowledgement to one live IPC dispatch reservation.
 */
export const nativeStepRefusalSchema = z.strictObject({
  version: z.literal(1),
  challenge: z.string().uuid(),
  planId: z.string().min(1).max(256),
  actionId: z.string().min(1).max(256),
  index: z.number().int().min(0).max(7),
  ownerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** Unknown anywhere dominates an aggregate, including malformed old receipts. */
export function nativeSequenceExecution(
  receipts: readonly Record<string, unknown>[],
): "completed" | "partial" | "not_dispatched" | "unknown" {
  if (
    !receipts.length ||
    receipts.some((r) => !["completed", "not_dispatched"].includes(String(r.execution)))
  )
    return "unknown";
  if (receipts.every((r) => r.execution === "completed")) return "completed";
  if (receipts.every((r) => r.execution === "not_dispatched")) return "not_dispatched";
  return "partial";
}

export function isKnownRefusedSequence(value: Record<string, unknown>): boolean {
  const receipts = value.receipts;
  if (
    value.contractVersion !== 2 ||
    value.complete !== false ||
    typeof value.planId !== "string" ||
    value.planId.length < 1 ||
    value.planId.length > 256 ||
    value.reason !== "guard_refused_before_dispatch" ||
    !Array.isArray(receipts) ||
    receipts.length < 1 ||
    receipts.length > 8
  )
    return false;
  if (
    value.businessOutcome !==
    (value.execution === "not_dispatched" ? "not_dispatched" : "unverified")
  )
    return false;
  return (
    receipts.every((r, index) => {
      if (
        !r ||
        typeof r !== "object" ||
        r.index !== index ||
        typeof r.actionId !== "string" ||
        r.actionId.length < 8 ||
        r.actionId.length > 256 ||
        receipts.some((other, i) => i !== index && other?.actionId === r.actionId)
      )
        return false;
      if (index < receipts.length - 1) return r.execution === "completed";
      const d = r.dispatch;
      return (
        r.execution === "not_dispatched" &&
        r.businessOutcome === "not_dispatched" &&
        d?.version === 1 &&
        d.state === "not_dispatched" &&
        d.source === "worker_guard" &&
        Number.isSafeInteger(d.ownerGeneration) &&
        d.ownerGeneration > 0
      );
    }) && nativeSequenceExecution(receipts) === value.execution
  );
}

/** Persistence owner derives this classification; tool callers cannot attest it.
 * A partial aggregate needs the complete v2 refused-suffix contract. Legacy or
 * malformed partials remain quarantined even if their aggregate sounds safe.
 */
export function nativeActionIsUncertain(value: Record<string, unknown>): boolean {
  if (Object.hasOwn(value, "execution") && typeof value.execution !== "string") return true;
  if (value.execution === "unknown") return true;
  if (
    typeof value.execution === "string" &&
    !["completed", "partial", "tool_error", "not_dispatched"].includes(value.execution)
  )
    return true;
  if (value.execution === "not_dispatched" && value.businessOutcome !== "not_dispatched")
    return true;
  if (value.execution === "not_dispatched" && value.reason === "dispatch_started") return true;
  if (value.receipts !== undefined) {
    if (typeof value.execution !== "string") return true;
    if (!Array.isArray(value.receipts)) return true;
    if (!value.receipts.length && value.execution !== "not_dispatched") return true;
    if (
      value.receipts.some(
        (r) =>
          !r ||
          typeof r !== "object" ||
          !["completed", "tool_error", "not_dispatched"].includes(r.execution),
      )
    )
      return true;
    if (value.execution === "completed" && value.receipts.some((r) => r.execution !== "completed"))
      return true;
    if (
      (value.execution === "not_dispatched" && value.receipts.length > 0) ||
      value.execution === "partial"
    )
      return !isKnownRefusedSequence(value);
  }
  return value.execution === "partial";
}

export function persistedNativeActionResult(
  value: Record<string, unknown>,
): Record<string, unknown> {
  // Never accept a caller-provided classification, including legacy payloads.
  const { nativeActionFence: _ignored, ...result } = value;
  return Object.hasOwn(result, "execution") || result.receipts !== undefined
    ? {
        ...result,
        nativeActionFence: {
          version: 1,
          state: nativeActionIsUncertain(result) ? "uncertain" : "known",
        },
      }
    : result;
}
