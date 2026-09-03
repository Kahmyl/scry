import type { AssuranceEvidenceRef, AssuranceStatus } from "../core/types.js";
import type { CampaignResult } from "../campaigns/primitives.js";
import type { LiveJourneyResult } from "../journeys/primitives.js";
import type { VerificationExecution } from "../verification/primitives.js";

export type CapabilityEvidenceLevel = "tested" | "qualified" | "certified" | "observed";

export type CapabilityEvidenceKind =
  "verification" | "campaign" | "journey" | "runtime_observation";

export type CapabilitySupportStatus = "unproven" | "experimental" | "qualified" | "certified";

export interface CapabilityEvidenceRecord {
  id: string;
  capability: string;
  level: CapabilityEvidenceLevel;
  kind: CapabilityEvidenceKind;
  status: AssuranceStatus;
  evidence: readonly AssuranceEvidenceRef[];
  summary?: string;
}

export interface CapabilitySupportAssessment {
  capability: string;
  status: CapabilitySupportStatus;
  observedInRealApplications: boolean;
  evidence: readonly AssuranceEvidenceRef[];
  records: readonly CapabilityEvidenceRecord[];
  blockers: readonly string[];
}

export function evidenceFromVerification(input: {
  capability: string;
  level: CapabilityEvidenceLevel;
  verification: VerificationExecution;
}): CapabilityEvidenceRecord {
  return {
    id: input.verification.id,
    capability: input.capability,
    level: input.level,
    kind: "verification",
    status: input.verification.status,
    evidence: input.verification.evidence,
    ...(input.verification.summary ? { summary: input.verification.summary } : {}),
  };
}

export function evidenceFromCampaign(input: {
  capability: string;
  level: CapabilityEvidenceLevel;
  campaign: CampaignResult;
}): CapabilityEvidenceRecord {
  return {
    id: input.campaign.id,
    capability: input.capability,
    level: input.level,
    kind: "campaign",
    status: input.campaign.status,
    evidence: dedupeEvidence(
      input.campaign.cases.flatMap(({ verification }) => verification.evidence),
    ),
  };
}

export function evidenceFromJourney(input: {
  capability: string;
  level: CapabilityEvidenceLevel;
  journey: LiveJourneyResult;
}): CapabilityEvidenceRecord {
  return {
    id: input.journey.id,
    capability: input.capability,
    level: input.level,
    kind: "journey",
    status: input.journey.status,
    evidence: dedupeEvidence([
      ...input.journey.steps.flatMap(({ verification }) => verification.evidence),
      ...input.journey.completion.evidence,
    ]),
  };
}

export function runtimeObservationEvidence(input: {
  id: string;
  capability: string;
  status: Exclude<AssuranceStatus, "not_run">;
  evidence: readonly AssuranceEvidenceRef[];
  summary?: string;
}): CapabilityEvidenceRecord {
  return {
    id: input.id,
    capability: input.capability,
    level: "observed",
    kind: "runtime_observation",
    status: input.status,
    evidence: dedupeEvidence(input.evidence),
    ...(input.summary ? { summary: input.summary } : {}),
  };
}

export function assessCapabilitySupport(
  capability: string,
  input: readonly CapabilityEvidenceRecord[],
): CapabilitySupportAssessment {
  const records = input.filter((record) => record.capability === capability);

  const certified = cleanPassingTier(records, "certified");

  const qualified = cleanPassingTier(records, "qualified");

  const anyEvidenceBackedPass = records.some(isEvidenceBackedPass);

  let status: CapabilitySupportStatus;

  if (certified) {
    status = "certified";
  } else if (qualified) {
    status = "qualified";
  } else if (anyEvidenceBackedPass) {
    status = "experimental";
  } else {
    status = "unproven";
  }

  const observedInRealApplications = records.some(
    (record) =>
      record.level === "observed" &&
      isEvidenceBackedPass(record) &&
      record.evidence.some(({ source }) => source === "chronicle" || source === "external"),
  );

  const blockers: string[] = [];

  if (records.some((record) => record.status === "pass" && record.evidence.length === 0)) {
    blockers.push("EVIDENCELESS_PASS_IGNORED");
  }

  if (records.some(({ level }) => level === "qualified") && !qualified) {
    blockers.push("QUALIFICATION_EVIDENCE_NOT_UNANIMOUS");
  }

  if (records.some(({ level }) => level === "certified") && !certified) {
    blockers.push("CERTIFICATION_EVIDENCE_NOT_UNANIMOUS");
  }

  if (!anyEvidenceBackedPass) {
    blockers.push("NO_EVIDENCE_BACKED_PASS");
  }

  return {
    capability,
    status,
    observedInRealApplications,
    evidence: dedupeEvidence(records.flatMap(({ evidence }) => evidence)),
    records,
    blockers,
  };
}

function cleanPassingTier(
  records: readonly CapabilityEvidenceRecord[],
  level: CapabilityEvidenceLevel,
): boolean {
  const tier = records.filter((record) => record.level === level);

  return tier.length > 0 && tier.every(isEvidenceBackedPass);
}

function isEvidenceBackedPass(record: CapabilityEvidenceRecord): boolean {
  return record.status === "pass" && record.evidence.length > 0;
}

function dedupeEvidence(input: readonly AssuranceEvidenceRef[]): readonly AssuranceEvidenceRef[] {
  const seen = new Set<string>();
  const result: AssuranceEvidenceRef[] = [];

  for (const evidence of input) {
    const key = [evidence.source, evidence.kind, evidence.ref].join("\u0000");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(evidence);
  }

  return result;
}
