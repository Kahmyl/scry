import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
    expect(report.q5.agent.repositoryBlindness).toMatchObject({
      cwdOutsideRepository: true,
      exposedCapabilities: ["Scry MCP"],
      shell: false,
      database: false,
      fixtureHttp: false,
      oracle: false,
      parentSemanticCoaching: false,
    });
    expect(report.mutationAccounting).toMatchObject({
      q5Campaigns: 1,
      authorizedMutations: 1,
      externalRequests: 0,
      externalEffects: 0,
      duplicates: 0,
      redispatches: 0,
    });
    expect(report.q5).toMatchObject({
      agentCompetence: "BLOCKED",
      agentQualityFinding: expect.stringContaining(
        "agent-facing dispatch_run_operation contract defect",
      ),
      productSafety: "PASS",
    });
    expect(report.q5.agentQualityFinding).toContain("competence remains unproven");
    expect(report.q5.agentQualityFinding).not.toContain("documented read-only semantic effect");
    expect(report.privacyAndCredentials).toMatchObject({
      protectedLeakCount: 0,
      persistentMcpTokenChanged: false,
      transcriptCommitted: false,
    });
    expect(report.futureGates.Q7).toContain("REAL Stage 6 Test Mode");
    expect(JSON.stringify(report)).not.toContain("Milestone 8");
  });
});
