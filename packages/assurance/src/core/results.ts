import type {
  AssuranceEvidenceRef,
  AssuranceStatus,
} from "./types.js";

export interface VerificationObservation {
  status: Exclude<AssuranceStatus, "not_run">;
  evidence?: readonly AssuranceEvidenceRef[];
  summary?: string;
  reasonCode?: string;
}

export interface VerificationResult {
  status: AssuranceStatus;
  evidence: readonly AssuranceEvidenceRef[];
  summary?: string;
  reasonCode?: string;
}

export function normalizeVerificationResult(
  observation: VerificationObservation,
): VerificationResult {
  const evidence = [...(observation.evidence ?? [])];

  if (
    (observation.status === "pass" ||
      observation.status === "fail") &&
    evidence.length === 0
  ) {
    return {
      status: "inconclusive",
      evidence,
      reasonCode:
        observation.status === "pass"
          ? "PASS_WITHOUT_EVIDENCE"
          : "FAIL_WITHOUT_EVIDENCE",
      ...(observation.summary
        ? { summary: observation.summary }
        : {}),
    };
  }

  return {
    status: observation.status,
    evidence,
    ...(observation.summary
      ? { summary: observation.summary }
      : {}),
    ...(observation.reasonCode
      ? { reasonCode: observation.reasonCode }
      : {}),
  };
}

export function notRunResult(
  reasonCode = "NOT_RUN",
): VerificationResult {
  return {
    status: "not_run",
    evidence: [],
    reasonCode,
  };
}

export function aggregateRequiredStatuses(
  statuses: readonly AssuranceStatus[],
): "pass" | "fail" | "inconclusive" {
  if (statuses.length === 0) {
    return "inconclusive";
  }

  if (statuses.includes("fail")) {
    return "fail";
  }

  if (statuses.every(status => status === "pass")) {
    return "pass";
  }

  return "inconclusive";
}
