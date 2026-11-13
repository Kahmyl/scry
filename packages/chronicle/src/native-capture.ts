import { createHash, randomUUID } from "node:crypto";
import type {
  NativeCaptureEpoch as CaptureEpoch,
  NativeCaptureSample as CaptureSample,
  NativeCaptureAssessment as CaptureAssessment,
  NativeCaptureWithholdReason as CaptureWithholdReason,
  NativeCapturePort,
  NativePhysicalStopped,
  RecordingAssessment,
  NativeImageEvidence,
} from "@scry/contracts";

export const nativeCaptureWarning = "automatic_redaction_best_effort" as const;
export { nativeImageReasons as imageRecovery } from "@scry/contracts";
import { nativeImageReasons as imageRecovery } from "@scry/contracts";
export const captureHash = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9-]{36}$/u.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
export function captureReason(v: unknown): CaptureWithholdReason {
  return typeof v === "string" &&
    (Object.hasOwn(imageRecovery, v) ||
      [
        "native_capture_final_assessment_missing",
        "native_capture_identity_mismatch",
        "native_capture_policy_gap",
        "native_capture_bytes_mismatch",
        "native_capture_physical_receipt_missing",
        "native_capture_admission_unavailable",
      ].includes(v))
    ? (v as CaptureWithholdReason)
    : "native_capture_identity_mismatch";
}
export type CapturePhysical = NativePhysicalStopped & { bytes: number; bytesDigest: string };
type Event = Record<string, unknown>;
export type CaptureReservation = {
  type: "native_capture_reserved_v2";
  epoch: CaptureEpoch;
  directory: string;
  kind: "display" | "screencast";
  filename: "recording.mp4" | "recording.webm";
  initialPolicyGeneration: number;
  requiredProducers: readonly ["graph", "physical"];
};
export type EvaluatedCapture = {
  reservation: CaptureReservation;
  assessment: CaptureAssessment;
  physical?: CapturePhysical;
  sealDigest?: string;
  admitted: boolean;
};
/** Rebuild the finite boundary at receipt, before asynchronous owner work. */
export function finiteCaptureSample(v: CaptureSample): CaptureSample {
  const invalid = (): CaptureSample => ({
    version: 1,
    readId: 0,
    policyGeneration: 0,
    text: "withheld",
    knownRequirement: "unknown",
    image: {
      state: "withheld",
      reason: "native_protection_attestation_invalid",
      recovery: "preserve_gap",
    },
  });
  if (
    !v ||
    v.version !== 1 ||
    !positive(v.readId) ||
    !positive(v.policyGeneration) ||
    !["complete", "withheld"].includes(v.text) ||
    !["present", "absent_in_supported_snapshot", "unknown"].includes(v.knownRequirement) ||
    !v.image ||
    (v.image.state === "available"
      ? v.image.assessment !== "best_effort_known_candidates"
      : v.image.state !== "withheld" || !Object.hasOwn(imageRecovery, v.image.reason))
  )
    return invalid();
  return {
    version: 1,
    readId: v.readId,
    policyGeneration: v.policyGeneration,
    text: v.text,
    knownRequirement: v.knownRequirement,
    image:
      v.image.state === "available"
        ? { state: "available", assessment: "best_effort_known_candidates" }
        : ({
            state: "withheld",
            reason: v.image.reason,
            recovery: imageRecovery[v.image.reason],
          } as NativeImageEvidence),
    ...(v.observedRequiredGap === undefined
      ? {}
      : {
          observedRequiredGap: Object.hasOwn(imageRecovery, v.observedRequiredGap)
            ? v.observedRequiredGap
            : "native_protection_attestation_invalid",
        }),
    ...(uuid(v.finalReadChallenge) ? { finalReadChallenge: v.finalReadChallenge } : {}),
  };
}

/** The sole prospective native capture owner. Persistence uses the existing
 * recording queue; callers never receive a raw event append capability. */
export async function createNativeCapture(input: {
  reservation: CaptureReservation;
  directory: string;
  append(event: Event): Promise<void>;
  assertActive(): void;
  readPhysical(receipt: NativePhysicalStopped): Promise<CapturePhysical>;
  registerBarrier?(join: () => Promise<void>): void;
}): Promise<NativeCapturePort> {
  const reservation = structuredClone(input.reservation),
    epoch = Object.freeze({ ...reservation.epoch });
  await input.append(reservation as unknown as Event);
  let serial: Promise<unknown> = Promise.resolve(),
    sequence = 0,
    graphClosed = false,
    physicalClosed = false;
  let policy = reservation.initialPolicyGeneration,
    transitions = 0,
    latest: CaptureSample | undefined;
  let physical: CapturePhysical | undefined,
    challenge: string | undefined,
    stoppedRead = 0;
  let graphRevoked = false,
    physicalRevoked = false;
  let graphClosing: Promise<void> | undefined, graphCloseWatermark: number | undefined;
  let physicalClosing: Promise<import("@scry/contracts").NativeFinalReadChallenge> | undefined;
  let physicalRequest: NativePhysicalStopped | undefined;
  let sealing: Promise<Exclude<CaptureAssessment, { state: "pending" }>> | undefined;
  let veto: CaptureWithholdReason | undefined,
    observed = false,
    final: Exclude<CaptureAssessment, { state: "pending" }> | undefined;
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = serial.then(() => {
      input.assertActive();
      return fn();
    });
    serial = next.catch(() => {});
    return next;
  };
  const assertOpen = () => {
    if (final) throw new Error("native_capture_producer_closed");
  };
  const gap = async (reason: CaptureWithholdReason, observedGap = false) => {
    veto ??= reason;
    observed ||= observedGap;
    await input.append({
      type: "native_capture_gap_v2",
      epoch,
      reason,
      observedRequiredGap: observedGap,
    });
  };
  const advance = async (
    n: number,
    reportedGap?: CaptureWithholdReason,
    observedGap = false,
  ): Promise<boolean> => {
    assertOpen();
    if (graphClosed) {
      await gap(reportedGap ?? "native_capture_policy_gap", observedGap);
      throw new Error("native_capture_producer_closed");
    }
    if (n !== sequence + 1 || !positive(n)) {
      await gap(reportedGap ?? "native_capture_policy_gap", observedGap);
      return false;
    }
    sequence = n;
    return true;
  };
  input.registerBarrier?.(() => serial.then(() => undefined));
  return {
    epoch,
    directory: input.directory,
    filename: reservation.filename,
    graphSample(value) {
      if (graphRevoked) return Promise.reject(new Error("native_capture_producer_closed"));
      const sample = finiteCaptureSample(value.sample),
        n = value.sequence;
      return enqueue(async () => {
        const reportedGap =
          sample.observedRequiredGap ??
          (sample.knownRequirement === "present" && sample.image.state === "withheld"
            ? sample.image.reason
            : undefined);
        if (!(await advance(n, reportedGap, reportedGap !== undefined))) return;
        if (
          sample.policyGeneration !== policy ||
          !positive(sample.readId) ||
          (latest && sample.readId <= latest.readId)
        )
          await gap("native_capture_policy_gap");
        if (sample.observedRequiredGap) await gap(sample.observedRequiredGap, true);
        if (sample.knownRequirement === "present" && sample.image.state === "withheld")
          await gap(sample.image.reason, true);
        else if (sample.image.state === "withheld" && sample.image.recovery === "preserve_gap")
          await gap(sample.image.reason);
        latest = sample;
        await input.append({
          type: "native_capture_producer_sample_v2",
          epoch,
          producer: "graph",
          sequence: n,
          sample,
        });
      });
    },
    graphGap(value) {
      if (graphRevoked) return Promise.reject(new Error("native_capture_producer_closed"));
      const n = value.sequence,
        reason = captureReason(value.reason);
      return enqueue(async () => {
        if (!(await advance(n, reason, true))) return;
        await gap(reason, true);
        await input.append({
          type: "native_capture_producer_sample_v2",
          epoch,
          producer: "graph",
          sequence: n,
          gap: reason,
        });
      });
    },
    physicalStopped(value) {
      const receipt = {
        epoch: { ...value.epoch },
        started: value.started,
        ended: value.ended,
        physicalCoverage: value.physicalCoverage,
      };
      if (physicalClosing && same(receipt, physicalRequest)) return physicalClosing;
      if (physicalRevoked) return Promise.reject(new Error("native_capture_producer_closed"));
      physicalRevoked = true;
      physicalRequest = receipt;
      physicalClosing = enqueue(async () => {
        assertOpen();
        if (physicalClosed) {
          if (
            physical &&
            same(receipt, {
              epoch: physical.epoch,
              started: physical.started,
              ended: physical.ended,
              physicalCoverage: physical.physicalCoverage,
            }) &&
            challenge
          )
            return { epoch, challenge };
          await gap("native_capture_identity_mismatch");
          throw new Error("native_capture_producer_closed");
        }
        if (
          !same(receipt.epoch, epoch) ||
          !Number.isSafeInteger(receipt.started) ||
          !Number.isSafeInteger(receipt.ended) ||
          receipt.ended < receipt.started ||
          !["complete", "partial"].includes(receipt.physicalCoverage)
        ) {
          await gap("native_capture_identity_mismatch");
          throw new Error("native_capture_physical_receipt_missing");
        }
        try {
          physical = await input.readPhysical(receipt);
        } catch (error) {
          await gap("native_capture_physical_receipt_missing");
          throw error;
        }
        input.assertActive();
        stoppedRead = latest?.readId ?? 0;
        challenge = randomUUID();
        physicalClosed = true;
        await input.append({
          type: "native_capture_producer_closed_v2",
          epoch,
          producer: "physical",
          lastSequence: 1,
          physical,
          finalReadChallenge: challenge,
        });
        return { epoch, challenge };
      });
      return physicalClosing;
    },
    graphClosed(value) {
      const n = value.lastSequence;
      if (graphClosing && n === graphCloseWatermark) return graphClosing;
      if (graphRevoked) return Promise.reject(new Error("native_capture_producer_closed"));
      // Revoke at invocation: every accepted callback is already registered in
      // serial, and drains durably before this close acknowledgement is written.
      graphRevoked = true;
      graphCloseWatermark = n;
      graphClosing = enqueue(async () => {
        assertOpen();
        if (graphClosed) {
          if (n === sequence) return;
          await gap("native_capture_policy_gap");
          throw new Error("native_capture_producer_closed");
        }
        if (
          n !== sequence ||
          !positive(n) ||
          !physicalClosed ||
          !latest ||
          latest.readId <= stoppedRead ||
          latest.finalReadChallenge !== challenge
        ) {
          await gap("native_capture_final_assessment_missing");
          return;
        }
        graphClosed = true;
        await input.append({
          type: "native_capture_producer_closed_v2",
          epoch,
          producer: "graph",
          lastSequence: n,
        });
      });
      return graphClosing;
    },
    policyTransition(value) {
      if (graphRevoked) return Promise.reject(new Error("native_capture_producer_closed"));
      const { from, to, acknowledged } = value;
      return enqueue(async () => {
        assertOpen();
        if (graphClosed || from !== policy || to !== policy + 1 || acknowledged !== true) {
          await gap("native_capture_policy_gap");
          return;
        }
        await input.append({ type: "native_capture_policy_v2", epoch, from, to, acknowledged });
        policy = to;
        transitions++;
      });
    },
    seal() {
      if (sealing) return sealing;
      graphRevoked = true;
      physicalRevoked = true;
      // A failed issued capability stays failed. Exact retry never converts an
      // unacknowledged final/seal write into a successful caller assessment.
      sealing = enqueue(async () => {
        if (final) return structuredClone(final);
        if (!physicalClosed || !graphClosed || !latest)
          veto ??= "native_capture_final_assessment_missing";
        if (latest?.image.state === "withheld") veto ??= latest.image.reason;
        const span = { first: reservation.initialPolicyGeneration, last: policy, transitions };
        final = veto
          ? { state: "withheld", epoch, policy: span, observedRequiredGap: observed, reason: veto }
          : {
              state: "best_effort_assessed",
              epoch,
              policy: span,
              observedRequiredGap: false,
              latestSampledAssessment: latest!.image,
              warning: nativeCaptureWarning,
            };
        const event = {
          type: "native_capture_assessed_v2",
          epoch,
          assessment: final,
          ...(physical ? { physical } : {}),
          ...(challenge && latest ? { finalRead: { readId: latest.readId, challenge } } : {}),
        };
        await input.append(event);
        if (graphClosed && physicalClosed)
          await input.append({
            type: "native_capture_sealed_v2",
            epoch,
            finalDigest: captureHash(JSON.stringify(event)),
            watermarks: { graph: sequence, physical: 1 },
          });
        return structuredClone(final);
      });
      return sealing;
    },
  };
}

/** Evaluate an already authenticated ledger. Missing/corrupt proof is a finite
 * capture decision; arbitrary filesystem manifests never enter this function. */
export function evaluateNativeCaptures(
  events: readonly Event[],
  options: {
    ownerGenerations?: readonly number[];
    captureStopped?: boolean;
    terminal?: boolean;
    interrupted?: boolean;
    writerGeneration?: number | null;
  } = {},
): EvaluatedCapture[] {
  const reservations = events.filter(
    (e) => e.type === "native_capture_reserved_v2",
  ) as unknown as CaptureReservation[];
  return reservations.map((reservation) => {
    const epoch = reservation.epoch,
      id = epoch?.captureId;
    let reason: CaptureWithholdReason | undefined,
      observed = false;
    const fail = (r: CaptureWithholdReason) => {
      reason ??= r;
    };
    if (
      !epoch ||
      !uuid(id) ||
      epoch.assessmentPolicyVersion !== 2 ||
      !positive(epoch.originalWriterGeneration) ||
      !positive(reservation.initialPolicyGeneration) ||
      !["display", "screencast"].includes(reservation.kind) ||
      reservation.filename !==
        (reservation.kind === "display" ? "recording.mp4" : "recording.webm") ||
      typeof reservation.directory !== "string" ||
      !new RegExp(
        `^native/${epoch?.originalWriterGeneration}/[a-f0-9-]{36}/capture-v2/${id}$`,
      ).test(reservation.directory) ||
      !same(reservation.requiredProducers, ["graph", "physical"])
    )
      fail("native_capture_identity_mismatch");
    if (
      reservations.filter((r) => r.epoch?.captureId === id || r.directory === reservation.directory)
        .length !== 1 ||
      events.some(
        (e) => e.type === "native_capture_started" && e.directory === reservation.directory,
      )
    )
      fail("native_capture_identity_mismatch");
    const related = events.filter((e) => (e.epoch as CaptureEpoch | undefined)?.captureId === id);
    if (related[0] !== reservation) fail("native_capture_identity_mismatch");
    let policy = reservation.initialPolicyGeneration,
      transitions = 0,
      seq = 0,
      read = 0,
      physical: CapturePhysical | undefined,
      challenge: string | undefined,
      stoppedRead = 0;
    let latest: CaptureSample | undefined,
      graphClose: Event | undefined,
      physicalClose: Event | undefined,
      finalEvent: Event | undefined,
      seal: Event | undefined,
      admitted = false;
    for (const e of related) {
      const owner = options.ownerGenerations?.[events.indexOf(e)];
      if (!same(e.epoch, epoch)) fail("native_capture_identity_mismatch");
      if (
        e.type !== "native_capture_admission_failed_v2" &&
        owner !== undefined &&
        owner !== epoch?.originalWriterGeneration
      )
        fail("native_capture_identity_mismatch");
      if (seal && e.type !== "native_capture_admission_failed_v2")
        fail("native_capture_policy_gap");
      if (e.type === "native_capture_reserved_v2") continue;
      if (e.type === "native_capture_gap_v2") {
        fail(captureReason(e.reason));
        observed ||= e.observedRequiredGap === true;
        continue;
      }
      if (e.type === "native_capture_policy_v2") {
        if (
          graphClose ||
          finalEvent ||
          e.from !== policy ||
          e.to !== policy + 1 ||
          e.acknowledged !== true
        )
          fail("native_capture_policy_gap");
        policy = Number(e.to);
        transitions++;
        continue;
      }
      if (e.type === "native_capture_producer_sample_v2") {
        if (graphClose || finalEvent || e.producer !== "graph" || e.sequence !== seq + 1)
          fail("native_capture_policy_gap");
        seq++;
        if (e.gap !== undefined) {
          fail(captureReason(e.gap));
          observed = true;
          continue;
        }
        const sample = finiteCaptureSample(e.sample as CaptureSample);
        if (!same(sample, e.sample) || sample.readId <= read || sample.policyGeneration !== policy)
          fail("native_capture_policy_gap");
        read = sample.readId;
        latest = sample;
        if (sample.observedRequiredGap) {
          fail(sample.observedRequiredGap);
          observed = true;
        }
        if (sample.image.state === "withheld") {
          if (sample.knownRequirement === "present") {
            fail(sample.image.reason);
            observed = true;
          } else if (sample.image.recovery === "preserve_gap") fail(sample.image.reason);
        }
        continue;
      }
      if (e.type === "native_capture_producer_closed_v2") {
        if (finalEvent) fail("native_capture_policy_gap");
        if (e.producer === "physical") {
          if (physicalClose || e.lastSequence !== 1 || !uuid(e.finalReadChallenge))
            fail("native_capture_policy_gap");
          if (
            events.filter(
              (other) =>
                other.type === "native_capture_producer_closed_v2" &&
                other.producer === "physical" &&
                other.finalReadChallenge === e.finalReadChallenge,
            ).length !== 1
          )
            fail("native_capture_identity_mismatch");
          physicalClose = e;
          physical = e.physical as CapturePhysical;
          challenge = e.finalReadChallenge as string;
          stoppedRead = read;
          if (
            !physical ||
            !same(physical.epoch, epoch) ||
            !Number.isSafeInteger(physical.started) ||
            !Number.isSafeInteger(physical.ended) ||
            physical.ended < physical.started ||
            !["complete", "partial"].includes(physical.physicalCoverage) ||
            !positive(physical.bytes) ||
            !/^[a-f0-9]{64}$/u.test(physical.bytesDigest)
          )
            fail("native_capture_physical_receipt_missing");
        } else if (e.producer === "graph") {
          if (
            graphClose ||
            !physicalClose ||
            e.lastSequence !== seq ||
            !positive(seq) ||
            !latest ||
            latest.readId <= stoppedRead ||
            latest.finalReadChallenge !== challenge
          )
            fail("native_capture_final_assessment_missing");
          graphClose = e;
        } else fail("native_capture_identity_mismatch");
        continue;
      }
      if (e.type === "native_capture_assessed_v2") {
        if (finalEvent) fail("native_capture_identity_mismatch");
        finalEvent = e;
        const assessment = e.assessment as Exclude<CaptureAssessment, { state: "pending" }>;
        if (
          !assessment ||
          !same(assessment.epoch, epoch) ||
          !same(assessment.policy, {
            first: reservation.initialPolicyGeneration,
            last: policy,
            transitions,
          }) ||
          !same(e.physical, physical)
        )
          fail("native_capture_identity_mismatch");
        if (
          !physicalClose ||
          !graphClose ||
          !latest ||
          !same(e.finalRead, { readId: latest?.readId, challenge })
        )
          fail("native_capture_final_assessment_missing");
        if (assessment?.state === "withheld") fail(captureReason(assessment.reason));
        else if (
          assessment?.state !== "best_effort_assessed" ||
          assessment.observedRequiredGap !== false ||
          assessment.warning !== nativeCaptureWarning ||
          latest?.image.state !== "available" ||
          !same(assessment.latestSampledAssessment, latest?.image)
        )
          fail("native_capture_final_assessment_missing");
        if (assessment?.observedRequiredGap !== observed) fail("native_capture_policy_gap");
        continue;
      }
      if (e.type === "native_capture_sealed_v2") {
        if (
          !finalEvent ||
          seal ||
          !physicalClose ||
          !graphClose ||
          e.finalDigest !== captureHash(JSON.stringify(finalEvent)) ||
          !same(e.watermarks, { graph: seq, physical: 1 })
        )
          fail("native_capture_final_assessment_missing");
        seal = e;
        continue;
      }
      if (e.type === "native_capture_admission_failed_v2") {
        fail(captureReason(e.reason));
        continue;
      }
      fail("native_capture_identity_mismatch");
    }
    if (!finalEvent || !seal) {
      if (
        finalEvent ||
        options.captureStopped ||
        options.terminal ||
        (options.interrupted &&
          (options.writerGeneration === undefined ||
            options.writerGeneration !== epoch?.originalWriterGeneration))
      )
        fail("native_capture_final_assessment_missing");
      if (!reason)
        return {
          reservation,
          assessment: {
            state: "pending",
            epoch,
            policy: { first: reservation.initialPolicyGeneration, last: policy, transitions },
          },
          admitted: false,
        };
    }
    for (const e of events.filter(
      (e) =>
        e.type === "native_media" &&
        ((e.captureEpoch as CaptureEpoch | undefined)?.captureId === id ||
          (typeof (e.media as Record<string, unknown> | undefined)?.objectKey === "string" &&
            new RegExp(`/${id}\\.(?:mp4|webm)$`).test(
              String((e.media as Record<string, unknown>).objectKey),
            ))),
    )) {
      const media = e.media as Record<string, unknown>,
        owner = options.ownerGenerations?.[events.indexOf(e)];
      if (
        !seal ||
        events.indexOf(e) <= events.indexOf(seal) ||
        !same(e.captureEpoch, epoch) ||
        e.captureSealDigest !== seal.finalDigest ||
        !positive(e.admittingGeneration) ||
        (owner !== undefined && e.admittingGeneration !== owner) ||
        media?.digest !== physical?.bytesDigest ||
        media?.bytes !== physical?.bytes ||
        media?.kind !== "video" ||
        typeof media.objectKey !== "string" ||
        !new RegExp(
          `^native/${e.admittingGeneration}/[a-f0-9-]{36}/${id}\\.${reservation.kind === "display" ? "mp4" : "webm"}$`,
        ).test(media.objectKey) ||
        media.timestamp !== physical?.started ||
        media.durationMs !== (physical ? physical.ended - physical.started : undefined) ||
        media.coverage !== physical?.physicalCoverage
      )
        fail("native_capture_identity_mismatch");
      else admitted = true;
    }
    const assessment: CaptureAssessment = reason
      ? {
          state: "withheld",
          epoch,
          policy: { first: reservation.initialPolicyGeneration, last: policy, transitions },
          observedRequiredGap: observed,
          reason,
        }
      : (finalEvent!.assessment as CaptureAssessment);
    return {
      reservation,
      assessment,
      ...(physical ? { physical } : {}),
      ...(seal ? { sealDigest: seal.finalDigest as string } : {}),
      admitted,
    };
  });
}

export function hasNativeCaptureFacts(events: readonly Event[]): boolean {
  return events.some(
    (e) =>
      (typeof e.type === "string" &&
        e.type.startsWith("native_capture_") &&
        e.type.endsWith("_v2")) ||
      (e.type === "native_media" && e.captureEpoch !== undefined),
  );
}

export function recordingAssessment(
  events: readonly Event[],
  options: Parameters<typeof evaluateNativeCaptures>[1] = {},
): RecordingAssessment | undefined {
  const captures = evaluateNativeCaptures(events, options);
  const orphan = events.some(
    (e) =>
      ((typeof e.type === "string" &&
        e.type.startsWith("native_capture_") &&
        e.type.endsWith("_v2")) ||
        (e.type === "native_media" && e.captureEpoch !== undefined)) &&
      !captures.some(
        (c) =>
          c.reservation.epoch?.captureId !== undefined &&
          c.reservation.epoch.captureId ===
            ((e.epoch ?? e.captureEpoch) as CaptureEpoch | undefined)?.captureId,
      ),
  );
  if (orphan)
    return {
      state: "withheld",
      reason: "native_capture_identity_mismatch",
      warning: nativeCaptureWarning,
    };
  if (!captures.length) return undefined;
  const withheld = captures.find((c) => c.assessment.state === "withheld");
  if (withheld?.assessment.state === "withheld")
    return { state: "withheld", reason: withheld.assessment.reason, warning: nativeCaptureWarning };
  if (captures.some((c) => c.assessment.state === "pending")) return { state: "pending" };
  // Assessment alone is never a claim that bytes were admitted/published.
  if (captures.some((c) => !c.admitted) && (options.captureStopped || options.terminal))
    return {
      state: "withheld",
      reason: "native_capture_admission_unavailable",
      warning: nativeCaptureWarning,
    };
  return { state: "best_effort_assessed", warning: nativeCaptureWarning };
}
