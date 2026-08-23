import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { currentActionSchema } from "@scry/contracts";

import {
  auditProviderNeutralMatrix,
  evaluateAgentLabQualification,
  providerAdapterQualificationBoundary,
  providerNeutralCharacteristicMatrix,
  qualifyProviderNeutralCase,
  requiredProviderNeutralDimensions,
  runAgentLabQualification,
  type AgentLabRunResult,
  type AssuranceEvidenceRef,
  type ProviderNeutralCharacteristicCase,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function evidence(characteristic: ProviderNeutralCharacteristicCase): AssuranceEvidenceRef[] {
  return characteristic.proofs.map((proof, index) => ({
    source: proof.tier === "public_optional" ? "external" : "fixture",
    kind: proof.tier,
    ref: `${characteristic.id}:${index}:${proof.path}`,
  }));
}

function passingObservation(characteristic: ProviderNeutralCharacteristicCase) {
  return {
    caseId: characteristic.id,
    mutationTruth: characteristic.expectedMutationTruth,
    privacyBehavior: characteristic.privacyBehavior,
    recoverySemantics: characteristic.recoverySemantics,
    authoritativeOwner: characteristic.authoritativeOwner,
    evidence: evidence(characteristic),
  } as const;
}

function passingAgentResult(objective: string): AgentLabRunResult {
  return {
    status: "completed",
    objective,
    provider: "deepseek",
    model: "deepseek-qualification",
    mcp_url: "http://qualification.invalid/mcp",
    advertised_tools: ["get_operating_context"],
    turns: 2,
    tool_calls: 1,
    invalid_calls: 0,
    stale_reference_calls: 0,
    repeated_unchanged_observations: 0,
    unnecessary_capabilities_calls: 0,
    completed: true,
    duration_ms: 10,
    transcript_path: "deepseek-transcript.jsonl",
  };
}

describe("provider-neutral characteristic qualification", () => {
  it("covers every required characteristic without provider-named cases or public-only release oracles", () => {
    expect(auditProviderNeutralMatrix(providerNeutralCharacteristicMatrix)).toEqual({
      status: "pass",
      missingDimensions: [],
      duplicateCaseIds: [],
      publicSoleReleaseOracleCases: [],
      providerNamedCases: [],
    });

    const covered = new Set(
      providerNeutralCharacteristicMatrix
        .filter(({ requiredForCore }) => requiredForCore)
        .flatMap(({ dimensions }) => dimensions),
    );
    expect([...covered].sort()).toEqual([...requiredProviderNeutralDimensions].sort());
  });

  it("maps every declared proof to an existing source assertion before adding fixtures", async () => {
    for (const characteristic of providerNeutralCharacteristicMatrix) {
      expect(characteristic.proofs.length, characteristic.id).toBeGreaterThan(0);
      expect(characteristic.expectedEvidence.length, characteristic.id).toBeGreaterThan(0);
      for (const proof of characteristic.proofs) {
        const source = await readFile(resolve(repositoryRoot, proof.path), "utf8");
        expect(source, `${characteristic.id}:${proof.path}`).toContain(proof.contains);
      }
    }
  });

  it.each(providerNeutralCharacteristicMatrix)(
    "qualifies the deterministic core contract for $id",
    (characteristic) => {
      const result = qualifyProviderNeutralCase(characteristic, passingObservation(characteristic));

      expect(result.coreStatus).toBe("pass");
      expect(result.reasonCodes).toEqual([]);
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.deepSeekStatus).toBe(
        characteristic.agentLab.kind === "deepseek_representative"
          ? "external_prerequisite"
          : "not_relevant",
      );
    },
  );

  it("reports unavailable facts as inconclusive rather than manufacturing mutation, privacy, recovery, or ownership", () => {
    const characteristic = providerNeutralCharacteristicMatrix[0]!;
    const result = qualifyProviderNeutralCase(characteristic, {
      caseId: characteristic.id,
      evidence: [],
    });

    expect(result.coreStatus).toBe("inconclusive");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "CASE_EVIDENCE_UNAVAILABLE",
        "MUTATION_TRUTH_UNAVAILABLE",
        "PRIVACY_EVIDENCE_UNAVAILABLE",
        "RECOVERY_EVIDENCE_UNAVAILABLE",
        "AUTHORITY_EVIDENCE_UNAVAILABLE",
      ]),
    );
  });

  it("fails wrong mutation truth, privacy behavior, retry semantics, and authoritative owner independently", () => {
    const characteristic = providerNeutralCharacteristicMatrix.find(
      ({ id }) => id === "response_timeout_ambiguity",
    )!;
    const result = qualifyProviderNeutralCase(characteristic, {
      ...passingObservation(characteristic),
      mutationTruth: "not_applied",
      privacyBehavior: "public_facts_only",
      recoverySemantics: "safe_after_correction",
      authoritativeOwner: "external_agent",
    });

    expect(result.coreStatus).toBe("fail");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "MUTATION_TRUTH_MISMATCH",
        "PRIVACY_BEHAVIOR_MISMATCH",
        "RECOVERY_SEMANTICS_MISMATCH",
        "AUTHORITATIVE_OWNER_MISMATCH",
      ]),
    );
  });

  it("runs representative cases through the existing DeepSeek Agent Lab cohort without redefining core truth", async () => {
    const deepSeek = await runAgentLabQualification({
      cohort: "deepseek",
      execute: async (scenario) => passingAgentResult(scenario.objective),
    });
    const relevant = providerNeutralCharacteristicMatrix.filter(
      ({ agentLab }) => agentLab.kind === "deepseek_representative",
    );

    expect(deepSeek.status).toBe("PASS");
    expect(relevant.length).toBeGreaterThan(0);
    for (const characteristic of relevant) {
      const result = qualifyProviderNeutralCase(
        characteristic,
        passingObservation(characteristic),
        deepSeek,
      );
      expect(result).toMatchObject({ coreStatus: "pass", deepSeekStatus: "pass" });
    }

    const failedDeepSeek = evaluateAgentLabQualification({ cohort: "deepseek", scenarioRuns: [] });
    const independent = qualifyProviderNeutralCase(
      relevant[0]!,
      passingObservation(relevant[0]!),
      failedDeepSeek,
    );
    expect(independent).toMatchObject({ coreStatus: "pass", deepSeekStatus: "fail" });
  });

  it("rejects non-DeepSeek Agent Lab cohorts and never names Qwen or Ollama", () => {
    const characteristic = providerNeutralCharacteristicMatrix.find(
      ({ agentLab }) => agentLab.kind === "deepseek_representative",
    )!;
    const nonDeepSeek = evaluateAgentLabQualification({
      cohort: "local",
      scenarioRuns: [],
      externalPrerequisite: "not used",
    });
    const result = qualifyProviderNeutralCase(
      characteristic,
      passingObservation(characteristic),
      nonDeepSeek,
    );

    expect(result).toMatchObject({
      coreStatus: "pass",
      deepSeekStatus: "fail",
      deepSeekReasonCodes: ["NON_DEEPSEEK_COHORT_REJECTED"],
    });
    expect(JSON.stringify(providerNeutralCharacteristicMatrix)).not.toMatch(/qwen|ollama/i);
  });

  it("keeps provider adapters factual and outside protected persistence, target choice, progression, and UNKNOWN authority", () => {
    expect(providerAdapterQualificationBoundary).toEqual({
      maySupplyFactualReconciliationEvidence: true,
      mayInspectScryProtectedPersistence: false,
      mayChooseSemanticTargets: false,
      mayChooseMissionProgression: false,
      mayWeakenUnknownMutationTruth: false,
    });
  });

  it("keeps unsupported file upload outside generic mutation architecture", () => {
    expect(
      currentActionSchema.safeParse({
        type: "upload",
        target: { concept: "file input" },
        filePath: "/tmp/should-not-dispatch",
      }).success,
    ).toBe(false);
    const characteristic = providerNeutralCharacteristicMatrix.find(
      ({ id }) => id === "unsupported_file_upload",
    )!;
    expect(characteristic).toMatchObject({
      expectedMutationTruth: "not_applied",
      authoritativeOwner: "external_agent",
      recoverySemantics: "external_agent_decides_from_facts",
    });
  });

  it("keeps public applications optional and never the sole release oracle", () => {
    const publicCases = providerNeutralCharacteristicMatrix.filter(({ proofs }) =>
      proofs.some(({ tier }) => tier === "public_optional"),
    );
    expect(publicCases.length).toBeGreaterThan(0);
    expect(publicCases.every(({ requiredForCore }) => !requiredForCore)).toBe(true);
    expect(
      publicCases.flatMap(({ proofs }) => proofs).every(({ releaseOracle }) => !releaseOracle),
    ).toBe(true);
  });
});
