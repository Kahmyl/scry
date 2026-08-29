import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateQ5DeterministicBoundary } from "../src/architecture/m6/report.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("Milestone 6 report", () => {
  it("separates passing mechanical safety from blocked repository-blind qualification", async () => {
    const report = JSON.parse(
      await readFile(`${root}/artifacts/system-correctness/m6/m6-report.json`, "utf8"),
    );
    expect(report.verdicts).toEqual({
      milestone6Implementation: "PASS",
      m6ClosureReview: "FAIL",
      q04MechanicalCampaignSafety: "PASS",
      q4ProcessLoss: "PASS",
      q5RepositoryBlindAgent: "BLOCKED",
      m6ProductGate: "BLOCKED",
      progression: "BLOCKED",
    });
    expect(Object.keys(report.q04.negativeCases)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
    ]);
    expect(report.q4.processCount).toBeGreaterThanOrEqual(15);
    expect(report.q4.uniquePidCount).toBe(report.q4.processCount);
    expect(report.q5.qualification).toBe("M6_Q5_VITRACT_PREVIEW_TEST");
    expect(report.mutationAccounting).toMatchObject({
      q5Campaigns: 0,
      authorizedMutations: 0,
      externalRequests: 0,
      externalEffects: 0,
      duplicates: 0,
      redispatches: 0,
    });
    expect(report.q5).toMatchObject({
      agentCompetence: "BLOCKED",
      agentQualityFinding: expect.stringContaining("competence remains unproven"),
      productSafety: "PASS",
    });
    expect(report.q5.agentQualityFinding).toContain("competence remains unproven");
    expect(report.q5.authoritativeEvidence.present).toBe(false);
    expect(report.privacyAndCredentials).toMatchObject({
      protectedLeakCount: 0,
      persistentMcpTokenChanged: false,
      transcriptCommitted: false,
    });
    expect(report.futureGates.Q7).toContain("REAL Stage 6 Test Mode");
    expect(JSON.stringify(report)).not.toContain("Milestone 8");
  });

  it("rejects incomplete, renamed, paid, or evidence-free deterministic boundary claims", async () => {
    const boundary = JSON.parse(
      await readFile(
        `${root}/artifacts/system-correctness/m6/q5-deterministic-boundary.json`,
        "utf8",
      ),
    );
    expect(validateQ5DeterministicBoundary(boundary)).toBe(true);
    for (const mutate of [
      (value: any) => (value.paidAuthorization = "CONSUMED"),
      (value: any) => (value.scope.deepSeekCalls = 1),
      (value: any) => (value.groups["13_invented_group"] = "PASS"),
      (value: any) => (value.evidence["06_deterministic_fake_agent_journey"] = []),
      (value: any) => (value.evidence["00_real_shaped_bootstrap"] = []),
    ]) {
      const candidate = structuredClone(boundary);
      mutate(candidate);
      expect(validateQ5DeterministicBoundary(candidate)).toBe(false);
    }
  });
});
