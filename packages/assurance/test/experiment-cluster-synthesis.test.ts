import {
  defineExperimentCluster,
  defineSeededSiblingExperimentCluster,
  normalizeExperimentClusterEvidence,
  seededSiblingExperimentClusterInput,
  seededSiblingRemediationProposal,
  synthesizeExperimentCluster,
  synthesizeExperimentClusterWithAgent,
  type ExperimentRemediationProposal,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("Assurance sibling-experiment synthesis", () => {
  it("defines immutable clusters and normalizes evidence deterministically", () => {
    const input = seededSiblingExperimentClusterInput();
    const cluster = defineExperimentCluster(input);
    const reordered = defineExperimentCluster({
      ...input,
      experiments: [...input.experiments].reverse(),
      evidence: [...input.evidence].reverse(),
      knownInvariants: [...input.knownInvariants].reverse(),
      ownershipFacts: [...input.ownershipFacts].reverse(),
      architecturalSignals: [...input.architecturalSignals].reverse(),
      candidateConflicts: [...input.candidateConflicts].reverse(),
    });
    const bundle = normalizeExperimentClusterEvidence(cluster);
    const reorderedBundle = normalizeExperimentClusterEvidence(reordered);

    expect(bundle.bundleDigest).toBe(reorderedBundle.bundleDigest);
    expect(bundle).toEqual(reorderedBundle);
    expect(Object.isFrozen(cluster)).toBe(true);
    expect(Object.isFrozen(cluster.experiments[0])).toBe(true);
    expect(Object.isFrozen(bundle.evidence[0]?.facts)).toBe(true);
    expect(bundle.evidence.every(({ sourceExperimentIds }) => sourceExperimentIds.length > 0)).toBe(
      true,
    );
    expect(bundle.failureSignatures).toEqual([
      {
        signature: "cleanup_path_alias_miss",
        classification: "distinct",
        experimentIds: ["resource-alias-cleanup-path"],
        evidenceIds: ["ev-cleanup-distinct-signature"],
      },
      {
        signature: "resource_identity_alias_mismatch",
        classification: "shared",
        experimentIds: ["resource-alias-cleanup-path", "resource-alias-write-path"],
        evidenceIds: ["ev-cleanup-shared-signature", "ev-write-shared-signature"],
      },
      {
        signature: "write_path_alias_rejection",
        classification: "distinct",
        experimentIds: ["resource-alias-write-path"],
        evidenceIds: ["ev-write-distinct-signature"],
      },
    ]);
  });

  it("recommends one shared owner and supersedes mutually inconsistent local patches", () => {
    const cluster = defineSeededSiblingExperimentCluster();
    const synthesis = synthesizeExperimentCluster(cluster, seededSiblingRemediationProposal());
    const recommended = synthesis.proposal.options.subsystem;

    expect(synthesis.proposal.recommendedOptionId).toBe("option-subsystem-shared-owner");
    expect(recommended.candidatePatchDispositions).toEqual([
      expect.objectContaining({
        experimentId: "resource-alias-write-path",
        disposition: "superseded_by_recommendation",
      }),
      expect.objectContaining({
        experimentId: "resource-alias-cleanup-path",
        disposition: "superseded_by_recommendation",
      }),
    ]);
    expect(synthesis.proposal.options.foundational).toMatchObject({
      viability: "viable",
      thresholdSignals: ["duplicated_authority"],
    });
    expect(synthesis.proposal.verificationMatrix).toHaveLength(4);
    expect(synthesis.proposal.uncertainties).toEqual([
      expect.objectContaining({
        uncertaintyId: "uncertainty-third-owner",
        missingEvidence: ["repository-wide resource identity ownership inventory"],
      }),
    ]);
    expect(synthesis).toMatchObject({
      proposalSource: "deterministic",
      proposalAgent: null,
      authorizationRequired: true,
      executionAuthority: "none",
      prohibitedActions: ["patch_application", "push", "merge", "deployment"],
    });
  });

  it("rejects unsupported findings instead of treating model assertions as evidence", () => {
    const proposal = seededSiblingRemediationProposal();
    const unsupported: ExperimentRemediationProposal = {
      ...proposal,
      sharedRootCauses: [
        {
          ...proposal.sharedRootCauses[0]!,
          statement: "A model asserted an unsupported root cause.",
          evidenceIds: ["model-assertion"],
        },
      ],
    };

    expect(() =>
      synthesizeExperimentCluster(defineSeededSiblingExperimentCluster(), unsupported),
    ).toThrow("ASSURANCE_EXPERIMENT_SYNTHESIS_EVIDENCE_UNKNOWN:model-assertion");
  });

  it("rejects a recommendation that promotes both known-conflicting candidate patches", () => {
    const proposal = seededSiblingRemediationProposal();
    const inconsistent: ExperimentRemediationProposal = {
      ...proposal,
      options: {
        ...proposal.options,
        subsystem: {
          ...proposal.options.subsystem,
          candidatePatchDispositions: proposal.options.subsystem.candidatePatchDispositions.map(
            (disposition) => ({
              ...disposition,
              disposition: "candidate_for_review" as const,
            }),
          ),
        },
      },
    };

    expect(() =>
      synthesizeExperimentCluster(defineSeededSiblingExperimentCluster(), inconsistent),
    ).toThrow(
      "ASSURANCE_EXPERIMENT_SYNTHESIS_CONFLICTING_PATCH_RECOMMENDATION:conflict-local-normalizers",
    );
  });

  it("requires an explicit architectural threshold before a foundational option is viable", () => {
    const input = seededSiblingExperimentClusterInput();
    const clusterWithoutThreshold = defineExperimentCluster({
      ...input,
      architecturalSignals: [],
    });

    expect(() =>
      synthesizeExperimentCluster(clusterWithoutThreshold, seededSiblingRemediationProposal()),
    ).toThrow(
      "ASSURANCE_EXPERIMENT_SYNTHESIS_FOUNDATIONAL_SIGNAL_UNSUPPORTED:duplicated_authority",
    );
  });

  it("validates optional agent-assisted proposals through the same evidence gate", async () => {
    const proposal = seededSiblingRemediationProposal();
    const synthesis = await synthesizeExperimentClusterWithAgent(
      defineSeededSiblingExperimentCluster(),
      {
        descriptor: {
          id: "deterministic-structured-proposal",
          provider: "assurance-test",
          version: "1",
        },
        async propose(bundle) {
          expect(bundle.evidence).toHaveLength(20);
          return proposal;
        },
      },
    );

    expect(synthesis).toMatchObject({
      proposalSource: "agent_assisted",
      proposalAgent: {
        id: "deterministic-structured-proposal",
        provider: "assurance-test",
        version: "1",
      },
      authorizationRequired: true,
      executionAuthority: "none",
    });

    await expect(
      synthesizeExperimentClusterWithAgent(defineSeededSiblingExperimentCluster(), {
        descriptor: { id: "unsupported", provider: "assurance-test", version: "1" },
        async propose() {
          return {
            ...proposal,
            sharedRootCauses: [
              {
                ...proposal.sharedRootCauses[0]!,
                evidenceIds: ["agent-opinion-only"],
              },
            ],
          };
        },
      }),
    ).rejects.toThrow("ASSURANCE_EXPERIMENT_SYNTHESIS_EVIDENCE_UNKNOWN:agent-opinion-only");
  });
});
