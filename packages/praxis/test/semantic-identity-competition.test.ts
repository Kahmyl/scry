import type { InteractionTargetIntent } from "@scry/contracts";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";

import {
  GroundingError,
  registerGroundingObserver,
  resolveTarget,
  type GroundingDiagnostic,
  type GroundingScore,
} from "../src/grounding.js";

const emailIntent: InteractionTargetIntent = {
  concept: "login email",
  requiredCapabilities: ["focusable", "accepts_text", "editable"],
  preferredEvidence: {
    roles: ["textbox"],
    names: [],
    labels: [],
    descriptions: [],
    placeholders: ["Enter your email"],
    inputTypes: [],
  },
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "authentication",
  confidence: { requiredFamilies: [] },
};

type ObservedDiagnostic = GroundingDiagnostic & {
  outcome: "resolved" | "rejected";
  code?: string;
};

type Characterization = {
  code: string;
  candidateCount: number;
  eligibleCount: number;
  confidence: number;
  confidenceMargin: number;
  candidateDistinctions: GroundingDiagnostic["candidateDistinctions"];
  rejectedConstraints: GroundingDiagnostic["rejectedConstraints"];
  evidenceFamilies: GroundingDiagnostic["evidenceFamilies"];
  score: GroundingDiagnostic["score"];
  rankedScores: GroundingScore[];
};

async function characterize(
  page: Page,
  html: string,
  intent: InteractionTargetIntent = emailIntent,
): Promise<Characterization> {
  await page.setContent(html);
  let observed: ObservedDiagnostic | undefined;
  registerGroundingObserver(page, (diagnostic) => {
    observed = diagnostic;
  });

  let code = "RESOLVED";
  let rankedScores: GroundingScore[] = [];
  try {
    await resolveTarget(page, intent);
  } catch (error) {
    expect(error).toBeInstanceOf(GroundingError);
    const groundingError = error as GroundingError & {
      candidates: readonly { score: GroundingScore }[];
    };
    code = groundingError.code;
    rankedScores = groundingError.candidates.map((candidate) => candidate.score);
  }

  const diagnostic = observed;
  if (!diagnostic) throw new Error("GROUNDING_DIAGNOSTIC_MISSING");
  return {
    code,
    candidateCount: diagnostic.candidateCount,
    eligibleCount: diagnostic.eligibleCount,
    confidence: diagnostic.confidence,
    confidenceMargin: diagnostic.confidenceMargin,
    candidateDistinctions: diagnostic.candidateDistinctions,
    rejectedConstraints: diagnostic.rejectedConstraints,
    evidenceFamilies: diagnostic.evidenceFamilies,
    score: diagnostic.score,
    rankedScores,
  };
}

describe("semantic identity competition", () => {
  it("restricts competition to exact identity peers without weakening fail-closed controls", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();
      const cases = {
        caseA: await characterize(page, '<input type="text" placeholder="Enter your email">'),
        caseB: await characterize(page, `
          <input type="text" placeholder="Enter your email">
          <input type="password" placeholder="Enter your password">
        `),
        caseC: await characterize(page, `
          <input type="text" placeholder="Enter your email">
          <input type="text" placeholder="Search">
        `),
        caseD: await characterize(page, `
          <input type="text" placeholder="Enter your email">
          <input type="text" placeholder="Enter your email">
        `),
        caseE: await characterize(page, '<input type="password" placeholder="Enter your password">'),
        caseF: await characterize(page, `
          <input type="text" placeholder="Enter your email" hidden>
          <input type="password" placeholder="Enter your password">
        `),
        caseG: await characterize(
          page,
          `<form><span>Identity-free group</span><input type="text"><input type="text"></form>`,
          {
            ...emailIntent,
            concept: "compatible text control",
            preferredEvidence: {
              roles: ["textbox"], names: [], labels: [], descriptions: [],
              placeholders: [], inputTypes: [],
            },
            relations: [{ kind: "same_boundary", name: "Identity-free group" }],
            confidence: {
              requiredFamilies: [], minimum: 0.8, minimumMargin: 0.14, minimumFamilyCount: 2,
            },
          },
        ),
        caseH: await characterize(page, `
          <input type="text" placeholder="Enter your email">
          <input type="text" placeholder="Search">
          <input type="text" placeholder="Enter your email">
        `),
        caseI: await characterize(
          page,
          `<input type="text" placeholder="Enter your email"><input type="search" placeholder="Search">`,
          {
            ...emailIntent,
            preferredEvidence: { ...emailIntent.preferredEvidence, inputTypes: ["search"] },
          },
        ),
        caseJ: await characterize(page, `
          <input type="password" placeholder="private-sensitive-alpha">
          <input type="password" placeholder="private-sensitive-beta">
        `),
        caseK: await characterize(page, '<input type="text" placeholder="Search">'),
        caseL: await characterize(page, `
          <input type="text" placeholder="Enter your email" disabled>
          <input type="text" placeholder="Search">
        `),
      };

      expect(cases.caseA).toMatchObject({
        code: "RESOLVED",
        candidateCount: 1,
        eligibleCount: 1,
      });
      expect(cases.caseB).toMatchObject({
        code: "RESOLVED",
        candidateCount: 2,
        eligibleCount: 1,
        confidence: 0.94,
        confidenceMargin: 0.94,
      });
      expect(cases.caseC).toMatchObject({
        code: "RESOLVED",
        candidateCount: 2,
        eligibleCount: 1,
        confidence: 0.94,
        confidenceMargin: 0.94,
      });
      expect(cases.caseD).toMatchObject({
        code: "TARGET_AMBIGUOUS",
        candidateCount: 2,
        eligibleCount: 2,
        confidenceMargin: 0,
      });
      expect(cases.caseE).toMatchObject({
        code: "INSUFFICIENT_EVIDENCE",
        candidateCount: 1,
        eligibleCount: 1,
      });
      expect(cases.caseF).toMatchObject({
        code: "INSUFFICIENT_EVIDENCE",
        candidateCount: 2,
        eligibleCount: 1,
        rejectedConstraints: expect.arrayContaining(["hidden"]),
      });
      expect(cases.caseG).toMatchObject({
        code: "TARGET_AMBIGUOUS",
        candidateCount: 2,
        eligibleCount: 2,
        confidenceMargin: 0,
      });
      expect(cases.caseH).toMatchObject({
        code: "TARGET_AMBIGUOUS",
        candidateCount: 3,
        eligibleCount: 2,
        confidenceMargin: 0,
      });
      expect(cases.caseI).toMatchObject({
        code: "RESOLVED",
        candidateCount: 2,
        eligibleCount: 1,
        confidence: 0.94,
      });
      expect(cases.caseJ).toMatchObject({
        code: "INSUFFICIENT_EVIDENCE",
        candidateCount: 2,
        eligibleCount: 2,
      });
      const safeSensitiveDiagnostic = JSON.stringify(cases.caseJ.candidateDistinctions);
      expect(safeSensitiveDiagnostic).toContain("identity suppressed");
      expect(safeSensitiveDiagnostic).not.toContain("private-sensitive-alpha");
      expect(safeSensitiveDiagnostic).not.toContain("private-sensitive-beta");
      expect(cases.caseK).toMatchObject({
        code: "INSUFFICIENT_EVIDENCE",
        candidateCount: 1,
        eligibleCount: 1,
        rejectedConstraints: expect.arrayContaining(["identity_evidence"]),
      });
      expect(cases.caseL).toMatchObject({
        code: "INSUFFICIENT_EVIDENCE",
        candidateCount: 2,
        eligibleCount: 1,
        rejectedConstraints: expect.arrayContaining(["disabled", "identity_evidence"]),
      });
    } finally {
      await browser.close();
    }
  }, 60_000);
});
