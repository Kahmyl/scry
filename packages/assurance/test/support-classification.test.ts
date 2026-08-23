import {
  assessCapabilitySupport,
  buildCapabilitySupportReport,
  evidenceFromCampaign,
  evidenceFromJourney,
  evidenceFromVerification,
  runtimeObservationEvidence,
  type CapabilityEvidenceRecord,
} from "../src/index.js";
import type { AssuranceEvidenceRef } from "../src/core/types.js";
import type { CampaignResult } from "../src/campaigns/primitives.js";
import type { LiveJourneyResult } from "../src/journeys/primitives.js";
import type { VerificationExecution } from "../src/verification/primitives.js";
import { describe, expect, it } from "vitest";

const fixtureEvidence: AssuranceEvidenceRef = {
  source: "fixture",
  kind: "dispatch-truth",
  ref: "fixture:dispatch:1",
};

const chronicleEvidence: AssuranceEvidenceRef = {
  source: "chronicle",
  kind: "run-observation",
  ref: "run:1",
};

function verification(
  status: VerificationExecution["status"],
  evidence: readonly AssuranceEvidenceRef[] = [fixtureEvidence],
): VerificationExecution {
  return {
    id: "verification",
    title: "Verification",
    claim: "Capability behaves correctly",
    status,
    evidence,
    attempts: [],
  };
}

function record(
  input: Partial<CapabilityEvidenceRecord> & {
    level: CapabilityEvidenceRecord["level"];
    status: CapabilityEvidenceRecord["status"];
  },
): CapabilityEvidenceRecord {
  return {
    id: input.id ?? `${input.level}-${input.status}`,
    capability: input.capability ?? "native-activation",
    kind: input.kind ?? "verification",
    level: input.level,
    status: input.status,
    evidence: input.evidence ?? [fixtureEvidence],
  };
}

describe("capability support classification", () => {
  it("keeps a capability unproven without evidence-backed success", () => {
    expect(assessCapabilitySupport("native-activation", [])).toMatchObject({
      status: "unproven",
      observedInRealApplications: false,
      blockers: ["NO_EVIDENCE_BACKED_PASS"],
    });
  });

  it("does not accept a pass that carries no evidence", () => {
    const assessment = assessCapabilitySupport("native-activation", [
      record({
        level: "tested",
        status: "pass",
        evidence: [],
      }),
    ]);

    expect(assessment.status).toBe("unproven");

    expect(assessment.blockers).toEqual(
      expect.arrayContaining(["EVIDENCELESS_PASS_IGNORED", "NO_EVIDENCE_BACKED_PASS"]),
    );
  });

  it("classifies evidence-backed tested behavior as experimental", () => {
    expect(
      assessCapabilitySupport("native-activation", [
        record({
          level: "tested",
          status: "pass",
        }),
      ]).status,
    ).toBe("experimental");
  });

  it("requires unanimous qualification evidence before claiming qualified", () => {
    const assessment = assessCapabilitySupport("native-activation", [
      record({
        id: "qualification-pass",
        level: "qualified",
        status: "pass",
      }),
      record({
        id: "qualification-fail",
        level: "qualified",
        status: "fail",
      }),
    ]);

    expect(assessment.status).toBe("experimental");

    expect(assessment.blockers).toContain("QUALIFICATION_EVIDENCE_NOT_UNANIMOUS");
  });

  it("derives qualified and certified only from clean evidence tiers", () => {
    const qualified = assessCapabilitySupport("native-activation", [
      record({
        level: "qualified",
        status: "pass",
      }),
    ]);

    const certified = assessCapabilitySupport("native-activation", [
      record({
        level: "qualified",
        status: "pass",
      }),
      record({
        level: "certified",
        status: "pass",
      }),
    ]);

    expect(qualified.status).toBe("qualified");

    expect(certified.status).toBe("certified");
  });

  it("tracks real-application observation without manufacturing certification", () => {
    const assessment = assessCapabilitySupport("native-activation", [
      runtimeObservationEvidence({
        id: "runtime-observation",
        capability: "native-activation",
        status: "pass",
        evidence: [chronicleEvidence],
      }),
    ]);

    expect(assessment).toMatchObject({
      status: "experimental",
      observedInRealApplications: true,
    });
  });

  it("normalizes evidence from verification, campaign, and journey results", () => {
    const verificationRecord = evidenceFromVerification({
      capability: "native-activation",
      level: "tested",
      verification: verification("pass"),
    });

    const campaign: CampaignResult = {
      id: "campaign",
      title: "Campaign",
      status: "pass",
      cases: [
        {
          required: true,
          verification: verification("pass"),
        },
      ],
    };

    const campaignRecord = evidenceFromCampaign({
      capability: "native-activation",
      level: "qualified",
      campaign,
    });

    const journey: LiveJourneyResult = {
      id: "journey",
      title: "Journey",
      surface: "fixture",
      status: "pass",
      steps: [
        {
          required: true,
          intent: "Activate",
          verification: verification("pass"),
        },
      ],
      completion: verification("pass"),
    };

    const journeyRecord = evidenceFromJourney({
      capability: "native-activation",
      level: "certified",
      journey,
    });

    expect(verificationRecord.evidence).toHaveLength(1);

    expect(campaignRecord.evidence).toHaveLength(1);

    expect(journeyRecord.evidence).toHaveLength(1);
  });

  it("builds deterministic structured support reports", () => {
    const report = buildCapabilitySupportReport([
      assessCapabilitySupport("z-capability", [
        record({
          capability: "z-capability",
          level: "certified",
          status: "pass",
        }),
      ]),
      assessCapabilitySupport("a-capability", []),
      assessCapabilitySupport("m-capability", [
        runtimeObservationEvidence({
          id: "observed",
          capability: "m-capability",
          status: "pass",
          evidence: [chronicleEvidence],
        }),
      ]),
    ]);

    expect(report.capabilities.map(({ capability }) => capability)).toEqual([
      "a-capability",
      "m-capability",
      "z-capability",
    ]);

    expect(report.counts).toEqual({
      unproven: 1,
      experimental: 1,
      qualified: 0,
      certified: 1,
    });

    expect(report.observedInRealApplications).toBe(1);
  });
});
