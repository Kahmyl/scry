import { nativeImageReasons } from "@scry/contracts";

const FINAL_READ_BUDGET_MS = 600;
const LIVE_READ_BUDGET_MS = 200;
const failure = () => new Error("NATIVE_CAPTURE_FINAL_READ_UNCONFIRMED");
const sameEpoch = (a, b) =>
  a?.captureId === b?.captureId &&
  a?.originalWriterGeneration === b?.originalWriterGeneration &&
  a?.assessmentPolicyVersion === 2 &&
  b?.assessmentPolicyVersion === 2;

/**
 * Used only with Chronicle's challenge issued after physical recording stop.
 * This does not retry a live action, extend live maintenance or clear a gap.
 * The producer remains the authority that binds the final sample to its epoch.
 */
export async function readFinalCaptureProtection({
  finalRead,
  epoch,
  read,
  sample,
  pending,
  assertActive,
  signal,
}) {
  if (
    !sameEpoch(finalRead?.epoch, epoch) ||
    typeof epoch?.captureId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(epoch.captureId) ||
    !Number.isSafeInteger(epoch.originalWriterGeneration) ||
    epoch.originalWriterGeneration < 1 ||
    typeof finalRead?.challenge !== "string" ||
    !/^[a-f0-9-]{36}$/.test(finalRead.challenge)
  )
    throw failure();
  const challenge = finalRead.challenge;
  const deadline = Date.now() + FINAL_READ_BUDGET_MS;
  const active = () => {
    if (signal?.aborted || Date.now() >= deadline) throw failure();
    assertActive();
  };
  // Every local waiter is bounded and observes abort. Timing out does not make
  // its operation complete; a pending read is never replaced concurrently.
  const bounded = async (operation, ms) => {
    active();
    let timer, abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          active();
          return operation();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure()), Math.max(0, ms));
          abort = () => reject(failure());
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  };
  active();
  // Keep our fences as value snapshots even if a private caller later reuses
  // a mutable sample object. Its late reply cannot rewrite the earlier fence.
  const snapshot = () => ({ ...sample() });
  const initial = snapshot();
  const inspect = (after, previousRead) => {
    if (
      after.version !== 1 ||
      after.finalReadChallenge !== challenge ||
      after.policyGeneration !== initial.policyGeneration ||
      !Number.isSafeInteger(after.readId) ||
      after.readId <= previousRead ||
      (initial.observedRequiredGap !== undefined &&
        after.observedRequiredGap !== initial.observedRequiredGap)
    )
      throw failure();
    return after;
  };
  await bounded(() => read(challenge), deadline - Date.now());
  active();
  const first = inspect(snapshot(), initial.readId);
  if (
    initial.observedRequiredGap !== undefined ||
    first.observedRequiredGap !== undefined ||
    first.image?.state !== "withheld" ||
    nativeImageReasons[first.image.reason] !== "read_only_once" ||
    first.image.recovery !== "read_only_once"
  )
    return { retried: false };

  const remaining = deadline - Date.now();
  if (remaining <= LIVE_READ_BUDGET_MS) return { retried: false };
  const outstanding = [...pending()];
  if (outstanding.length) {
    try {
      await bounded(
        () => Promise.allSettled(outstanding),
        Math.min(LIVE_READ_BUDGET_MS, remaining - LIVE_READ_BUDGET_MS),
      );
    } catch (error) {
      // An aborted/fenced owner must fail, not silently resume finalization.
      active();
      if (pending().length) return { retried: false };
      throw error;
    }
  }
  active();
  const drained = snapshot();
  if (
    drained.readId !== first.readId ||
    drained.policyGeneration !== first.policyGeneration ||
    drained.finalReadChallenge !== challenge ||
    (first.observedRequiredGap !== undefined &&
      drained.observedRequiredGap !== first.observedRequiredGap)
  )
    throw failure();
  if (
    pending().length ||
    drained.observedRequiredGap !== undefined ||
    drained.image?.state !== "withheld" ||
    nativeImageReasons[drained.image.reason] !== "read_only_once" ||
    drained.image.recovery !== "read_only_once" ||
    deadline - Date.now() <= LIVE_READ_BUDGET_MS
  )
    return { retried: false };

  // One new read, with the same physical epoch/challenge and a new generation.
  // Older in-flight paint replies cannot certify it through the read fence.
  active();
  await bounded(() => read(challenge), deadline - Date.now());
  active();
  inspect(snapshot(), first.readId);
  return { retried: true };
}
