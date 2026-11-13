import {
  nativeImageReasons,
  type NativeImageEvidence,
  type NativeImageReason,
  type NativeCaptureSample,
} from "@scry/contracts";

export type { NativeImageEvidence, NativeImageReason, NativeCaptureSample };
export function nativeImageEvidence(reason?: NativeImageReason): NativeImageEvidence {
  return reason
    ? ({ state: "withheld", reason, recovery: nativeImageReasons[reason] } as NativeImageEvidence)
    : { state: "available", assessment: "best_effort_known_candidates" };
}

export type NativeGraphReference = ({ boundIndex: number } | { learnedIndex: number }) & {
  sourceOwner: number;
  axRoles: string[];
  coversWholeOwner?: boolean;
};

/** PRIVATE worker/Veil receipt. Never serialize this as a capture or tool result. */
export type NativeGraphReceipt = {
  version: 1;
  readId: number;
  policyGeneration: number;
  finalReadChallenge?: string;
  text: "complete" | "withheld";
  image: NativeImageEvidence;
  knownRequirement: "present" | "absent_in_supported_snapshot" | "unknown";
  values: string[];
  coveredBoundIndices: number[];
  coveredValues?: string[];
  textCandidateScope: { readId: number; policyGeneration: number };
  textCandidateRefs: NativeGraphReference[];
  imageCandidateRefs: NativeGraphReference[];
  observedRequiredGap?: NativeImageReason;
  count: {
    roots: number;
    nodes: number;
    textNodes: number;
    controls: number;
    presentations: number;
    pseudoReads: number;
    rectangles: number;
  };
};
