import { nativeImageReasons } from "@scry/contracts";
const failure = () => new Error("NATIVE_CAPTURE_PRODUCER_UNCONFIRMED");
const validEpoch = (epoch) =>
  epoch &&
  typeof epoch.captureId === "string" &&
  /^[a-f0-9-]{36}$/u.test(epoch.captureId) &&
  Number.isSafeInteger(epoch.originalWriterGeneration) &&
  epoch.originalWriterGeneration > 0 &&
  epoch.assessmentPolicyVersion === 2;
const sameEpoch = (a, b) =>
  a?.captureId === b?.captureId &&
  a?.originalWriterGeneration === b?.originalWriterGeneration &&
  a?.assessmentPolicyVersion === b?.assessmentPolicyVersion;
function finiteSample(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.readId) ||
    value.readId < 1 ||
    !Number.isSafeInteger(value.policyGeneration) ||
    value.policyGeneration < 1 ||
    !["complete", "withheld"].includes(value.text) ||
    !["present", "absent_in_supported_snapshot", "unknown"].includes(value.knownRequirement)
  )
    throw failure();
  let image;
  if (
    value.image?.state === "available" &&
    value.image.assessment === "best_effort_known_candidates"
  )
    image = { state: "available", assessment: "best_effort_known_candidates" };
  else if (
    value.image?.state === "withheld" &&
    Object.hasOwn(nativeImageReasons, value.image.reason) &&
    value.image.recovery === nativeImageReasons[value.image.reason]
  )
    image = {
      state: "withheld",
      reason: value.image.reason,
      recovery: nativeImageReasons[value.image.reason],
    };
  else throw failure();
  if (
    value.observedRequiredGap !== undefined &&
    !Object.hasOwn(nativeImageReasons, value.observedRequiredGap)
  )
    throw failure();
  if (
    value.finalReadChallenge !== undefined &&
    (typeof value.finalReadChallenge !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(value.finalReadChallenge))
  )
    throw failure();
  return {
    version: 1,
    readId: value.readId,
    policyGeneration: value.policyGeneration,
    text: value.text,
    image,
    knownRequirement: value.knownRequirement,
    ...(value.finalReadChallenge ? { finalReadChallenge: value.finalReadChallenge } : {}),
    ...(value.observedRequiredGap ? { observedRequiredGap: value.observedRequiredGap } : {}),
  };
}
/** One registered producer. Accepted sends register synchronously before any await. */
export function createCaptureProducer({ epoch: inputEpoch, send, sample }) {
  if (!validEpoch(inputEpoch)) throw failure();
  const epoch = {
    captureId: inputEpoch.captureId,
    originalWriterGeneration: inputEpoch.originalWriterGeneration,
    assessmentPolicyVersion: 2,
  };
  const pending = new Set();
  let state = "open",
    sequence = 0,
    lastRead = 0,
    failed = false,
    paused = false,
    generation = 0,
    closing;
  function emit(type, payload) {
    if (state !== "open") return false;
    const event = { type, epoch, sequence: ++sequence, ...payload };
    let resolve, reject;
    const completion = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending.add(completion);
    void completion.then(
      () => pending.delete(completion),
      () => {
        failed = true;
        pending.delete(completion);
      },
    );
    try {
      Promise.resolve(send(event)).then(resolve, () => reject(failure()));
    } catch {
      reject(failure());
    }
    return true;
  }
  return {
    sample() {
      if (state !== "open" || paused) return false;
      let value;
      try {
        value = finiteSample(sample());
      } catch {
        failed = true;
        return false;
      }
      if (value.readId <= lastRead) return false;
      lastRead = value.readId;
      return emit("capture_sample", { sample: value });
    },
    gap(reason) {
      if (!Object.hasOwn(nativeImageReasons, reason)) {
        failed = true;
        return false;
      }
      return emit("capture_gap", { reason });
    },
    pauseSamples() {
      paused = true;
    },
    resumeSamples() {
      if (state === "open") paused = false;
    },
    close(request, measure) {
      if (closing) return closing;
      if (
        state !== "open" ||
        !sameEpoch(request.epoch, epoch) ||
        typeof request.challenge !== "string" ||
        !/^[a-f0-9-]{36}$/u.test(request.challenge)
      )
        return Promise.reject(failure());
      state = "closing";
      const accepted = [...pending],
        current = ++generation;
      closing = (async () => {
        await Promise.allSettled(accepted);
        if (failed || generation !== current || state !== "closing") throw failure();
        await measure(request.challenge);
        if (failed || generation !== current || state !== "closing") throw failure();
        const finalSample = finiteSample(sample());
        if (finalSample.finalReadChallenge !== request.challenge || finalSample.readId <= lastRead)
          throw failure();
        lastRead = finalSample.readId;
        state = "closed";
        return { epoch, lastSequence: ++sequence, finalSample };
      })();
      return closing;
    },
    abandon() {
      state = "closed";
      ++generation;
    },
  };
}
