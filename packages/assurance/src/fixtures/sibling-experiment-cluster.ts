import {
  defineExperimentCluster,
  type ExperimentCluster,
  type ExperimentClusterInput,
  type ExperimentRemediationProposal,
} from "../reporting/experiment-cluster-synthesis.js";

const writeExperimentId = "resource-alias-write-path";
const cleanupExperimentId = "resource-alias-cleanup-path";
const writeEvidenceSource = { sourceExperimentIds: [writeExperimentId] } as const;
const cleanupEvidenceSource = { sourceExperimentIds: [cleanupExperimentId] } as const;
const siblingEvidenceSource = {
  sourceExperimentIds: [writeExperimentId, cleanupExperimentId],
} as const;

export function seededSiblingExperimentClusterInput(): ExperimentClusterInput {
  return {
    clusterId: "seeded-resource-identity-ownership",
    problemSignature: "resource_identity_alias_mismatch",
    experiments: [
      {
        experimentId: writeExperimentId,
        manifestRef: "seeded://write/manifest.json",
        ledgerRef: "seeded://write/ledger.jsonl",
        baselineVerificationRef: "seeded://write/reproduction.json",
        candidateVerificationRef: "seeded://write/verification.json",
        patchRef: "seeded://write/candidate.patch",
        runtimeTelemetryRefs: ["seeded://write/runtime.json"],
        failureSignatures: [
          {
            signature: "resource_identity_alias_mismatch",
            evidenceIds: ["ev-write-shared-signature"],
          },
          {
            signature: "write_path_alias_rejection",
            evidenceIds: ["ev-write-distinct-signature"],
          },
        ],
        candidateOutcome: {
          status: "passed",
          explanationEvidenceIds: ["ev-write-candidate"],
        },
      },
      {
        experimentId: cleanupExperimentId,
        manifestRef: "seeded://cleanup/manifest.json",
        ledgerRef: "seeded://cleanup/ledger.jsonl",
        baselineVerificationRef: "seeded://cleanup/reproduction.json",
        candidateVerificationRef: "seeded://cleanup/verification.json",
        patchRef: "seeded://cleanup/candidate.patch",
        runtimeTelemetryRefs: ["seeded://cleanup/runtime.json"],
        failureSignatures: [
          {
            signature: "resource_identity_alias_mismatch",
            evidenceIds: ["ev-cleanup-shared-signature"],
          },
          {
            signature: "cleanup_path_alias_miss",
            evidenceIds: ["ev-cleanup-distinct-signature"],
          },
        ],
        candidateOutcome: {
          status: "passed",
          explanationEvidenceIds: ["ev-cleanup-candidate"],
        },
      },
    ],
    evidence: [
      {
        id: "ev-write-reproduction",
        ...writeEvidenceSource,
        kind: "reproduction",
        artifactRef: "seeded://write/reproduction.json#failure",
        summary: "The write path rejected a valid alias before candidate repair.",
        facts: { exitCode: 1, reproduced: true },
      },
      {
        id: "ev-write-shared-signature",
        ...writeEvidenceSource,
        kind: "failure_signature",
        artifactRef: "seeded://write/ledger.jsonl#entry-3",
        summary: "The write failure carried the shared alias mismatch signature.",
        facts: { signature: "resource_identity_alias_mismatch" },
      },
      {
        id: "ev-write-distinct-signature",
        ...writeEvidenceSource,
        kind: "failure_signature",
        artifactRef: "seeded://write/ledger.jsonl#entry-4",
        summary: "The write symptom occurred during local admission.",
        facts: { signature: "write_path_alias_rejection" },
      },
      {
        id: "ev-write-candidate",
        ...writeEvidenceSource,
        kind: "candidate_patch",
        artifactRef: "seeded://write/verification.json#pass",
        summary: "A local writer normalization patch passed the write-path oracle.",
        facts: { candidateStatus: "passed", proposedOwner: "resource-writer" },
      },
      {
        id: "ev-write-owner",
        ...writeEvidenceSource,
        kind: "ownership",
        artifactRef: "seeded://write/ledger.jsonl#entry-6",
        summary: "The candidate made the resource writer an alias-normalization owner.",
        facts: { component: "resource-writer", responsibility: "alias-normalization" },
      },
      {
        id: "ev-cleanup-reproduction",
        ...cleanupEvidenceSource,
        kind: "reproduction",
        artifactRef: "seeded://cleanup/reproduction.json#failure",
        summary: "The cleanup path missed the same resource under a valid alias.",
        facts: { exitCode: 1, reproduced: true },
      },
      {
        id: "ev-cleanup-shared-signature",
        ...cleanupEvidenceSource,
        kind: "failure_signature",
        artifactRef: "seeded://cleanup/ledger.jsonl#entry-3",
        summary: "The cleanup failure carried the shared alias mismatch signature.",
        facts: { signature: "resource_identity_alias_mismatch" },
      },
      {
        id: "ev-cleanup-distinct-signature",
        ...cleanupEvidenceSource,
        kind: "failure_signature",
        artifactRef: "seeded://cleanup/ledger.jsonl#entry-4",
        summary: "The cleanup symptom occurred during read-side reconciliation.",
        facts: { signature: "cleanup_path_alias_miss" },
      },
      {
        id: "ev-cleanup-candidate",
        ...cleanupEvidenceSource,
        kind: "candidate_patch",
        artifactRef: "seeded://cleanup/verification.json#pass",
        summary: "A different cleanup normalization patch passed the cleanup oracle.",
        facts: { candidateStatus: "passed", proposedOwner: "cleanup-worker" },
      },
      {
        id: "ev-cleanup-owner",
        ...cleanupEvidenceSource,
        kind: "ownership",
        artifactRef: "seeded://cleanup/ledger.jsonl#entry-6",
        summary: "The candidate made the cleanup worker a second alias-normalization owner.",
        facts: { component: "cleanup-worker", responsibility: "alias-normalization" },
      },
      {
        id: "ev-shared-invariant",
        ...siblingEvidenceSource,
        kind: "invariant",
        artifactRef: "seeded://cluster/invariant.json",
        summary: "One canonical resource identity must be owned and applied consistently.",
        facts: {
          invariant: "one canonical resource identity",
          observedOwners: ["cleanup-worker", "resource-writer"],
        },
      },
      {
        id: "ev-duplicated-authority",
        ...siblingEvidenceSource,
        kind: "architectural_signal",
        artifactRef: "seeded://cluster/ownership-comparison.json",
        summary: "Both passing candidates establish sibling normalization owners.",
        facts: { signal: "duplicated_authority", ownerCount: 2 },
      },
      {
        id: "ev-candidate-conflict",
        ...siblingEvidenceSource,
        kind: "candidate_patch",
        artifactRef: "seeded://cluster/candidate-conflict.json",
        summary:
          "The two local patches encode different normalization order and cannot both own the rule.",
        facts: { conflict: true, candidates: [cleanupExperimentId, writeExperimentId] },
      },
      {
        id: "ev-compatibility",
        ...siblingEvidenceSource,
        kind: "compatibility",
        artifactRef: "seeded://cluster/compatibility.json",
        summary: "A shared canonicalizer can preserve both public alias inputs.",
        facts: { publicInputChange: false },
      },
      {
        id: "ev-migration",
        ...siblingEvidenceSource,
        kind: "migration",
        artifactRef: "seeded://cluster/migration.json",
        summary: "Persisted aliases need an audit before enforcing one canonical key.",
        facts: { persistedAliasAuditRequired: true },
      },
      {
        id: "ev-privacy",
        ...siblingEvidenceSource,
        kind: "privacy",
        artifactRef: "seeded://cluster/privacy.json",
        summary: "Only non-secret resource identity facts are required for the correction.",
        facts: { protectedValueRequired: false },
      },
      {
        id: "ev-rollout",
        ...siblingEvidenceSource,
        kind: "rollout",
        artifactRef: "seeded://cluster/rollout.json",
        summary: "Shadow comparison can qualify the shared canonicalizer before enforcement.",
        facts: { shadowComparisonAvailable: true },
      },
      {
        id: "ev-rollback",
        ...siblingEvidenceSource,
        kind: "rollback",
        artifactRef: "seeded://cluster/rollback.json",
        summary: "The shared owner can be disabled without applying either candidate patch.",
        facts: { candidatePatchApplicationRequired: false },
      },
      {
        id: "ev-residual-risk",
        ...siblingEvidenceSource,
        kind: "residual_risk",
        artifactRef: "seeded://cluster/residual-risk.json",
        summary: "A third unobserved normalization owner may still exist.",
        facts: { ownershipInventoryComplete: false },
      },
      {
        id: "ev-verification-contract",
        ...siblingEvidenceSource,
        kind: "verification",
        artifactRef: "seeded://cluster/unified-verification.json",
        summary: "The unified oracle covers write, cleanup, migration, and privacy behavior.",
        facts: { siblingPaths: 2, privacyAssertions: 1 },
      },
    ],
    knownInvariants: [
      {
        invariantId: "inv-canonical-resource-identity",
        statement: "Exactly one component owns canonical resource identity derivation.",
        currentOwners: ["resource-writer", "cleanup-worker"],
        evidenceIds: ["ev-shared-invariant", "ev-duplicated-authority"],
      },
    ],
    ownershipFacts: [
      {
        ownershipFactId: "owner-resource-writer",
        component: "resource-writer",
        responsibility: "candidate alias normalization on write",
        evidenceIds: ["ev-write-owner"],
      },
      {
        ownershipFactId: "owner-cleanup-worker",
        component: "cleanup-worker",
        responsibility: "candidate alias normalization during cleanup",
        evidenceIds: ["ev-cleanup-owner"],
      },
    ],
    architecturalSignals: [
      {
        signal: "duplicated_authority",
        evidenceIds: ["ev-duplicated-authority", "ev-shared-invariant"],
      },
    ],
    candidateConflicts: [
      {
        conflictId: "conflict-local-normalizers",
        experimentIds: [writeExperimentId, cleanupExperimentId],
        reason: "Both patches establish a different owner and normalization order.",
        evidenceIds: ["ev-write-candidate", "ev-cleanup-candidate", "ev-candidate-conflict"],
      },
    ],
  };
}

export function defineSeededSiblingExperimentCluster(): ExperimentCluster {
  return defineExperimentCluster(seededSiblingExperimentClusterInput());
}

export function seededSiblingRemediationProposal(): ExperimentRemediationProposal {
  const supersedeWrite = {
    experimentId: writeExperimentId,
    disposition: "superseded_by_recommendation" as const,
    reason: "The local passing patch would preserve write-path ownership duplication.",
    evidenceIds: ["ev-write-candidate", "ev-candidate-conflict"],
  };
  const supersedeCleanup = {
    experimentId: cleanupExperimentId,
    disposition: "superseded_by_recommendation" as const,
    reason: "The local passing patch would preserve cleanup-path ownership duplication.",
    evidenceIds: ["ev-cleanup-candidate", "ev-candidate-conflict"],
  };

  return {
    sharedRootCauses: [
      {
        findingId: "shared-duplicated-normalization-owner",
        statement:
          "The sibling failures share one resource-identity invariant whose normalization authority is duplicated.",
        affectedExperimentIds: [writeExperimentId, cleanupExperimentId],
        evidenceIds: [
          "ev-write-shared-signature",
          "ev-cleanup-shared-signature",
          "ev-shared-invariant",
          "ev-duplicated-authority",
        ],
      },
    ],
    distinctRootCauses: [
      {
        findingId: "distinct-write-admission",
        statement: "The write symptom is exposed during local admission.",
        affectedExperimentIds: [writeExperimentId],
        evidenceIds: ["ev-write-reproduction", "ev-write-distinct-signature"],
      },
      {
        findingId: "distinct-cleanup-reconciliation",
        statement: "The cleanup symptom is exposed during read-side reconciliation.",
        affectedExperimentIds: [cleanupExperimentId],
        evidenceIds: ["ev-cleanup-reproduction", "ev-cleanup-distinct-signature"],
      },
    ],
    violatedInvariantIds: ["inv-canonical-resource-identity"],
    currentOwnerFactIds: ["owner-resource-writer", "owner-cleanup-worker"],
    candidateAssessments: [
      {
        experimentId: writeExperimentId,
        observedOutcome: "passed",
        explanation:
          "The writer patch passed its local oracle because it normalized before admission, while creating a sibling owner.",
        evidenceIds: ["ev-write-candidate", "ev-write-owner"],
      },
      {
        experimentId: cleanupExperimentId,
        observedOutcome: "passed",
        explanation:
          "The cleanup patch passed its local oracle because it normalized during reconciliation, while creating another owner.",
        evidenceIds: ["ev-cleanup-candidate", "ev-cleanup-owner"],
      },
    ],
    options: {
      contained: {
        optionId: "option-contained-local-patches",
        scope: "contained",
        viability: "not_recommended",
        summary:
          "Retain both local fixes only as evidence because selecting either path leaves sibling divergence and selecting both is inconsistent.",
        evidenceIds: ["ev-write-candidate", "ev-cleanup-candidate", "ev-candidate-conflict"],
        thresholdSignals: [],
        candidatePatchDispositions: [supersedeWrite, supersedeCleanup],
      },
      subsystem: {
        optionId: "option-subsystem-shared-owner",
        scope: "subsystem",
        viability: "viable",
        summary:
          "Move canonical identity derivation to one shared resource-identity owner and route both sibling paths through it.",
        evidenceIds: ["ev-shared-invariant", "ev-duplicated-authority", "ev-candidate-conflict"],
        thresholdSignals: [],
        candidatePatchDispositions: [supersedeWrite, supersedeCleanup],
      },
      foundational: {
        optionId: "option-foundational-identity-model",
        scope: "foundational",
        viability: "viable",
        summary:
          "A wider identity-model rebuild is evidence-permitted by duplicated authority but not yet required by the two-path cluster.",
        evidenceIds: ["ev-duplicated-authority", "ev-residual-risk"],
        thresholdSignals: ["duplicated_authority"],
        candidatePatchDispositions: [supersedeWrite, supersedeCleanup],
      },
    },
    recommendedOptionId: "option-subsystem-shared-owner",
    recommendedAnalysis: {
      compatibility: {
        statement:
          "Preserve existing public aliases while canonicalizing behind the shared boundary.",
        evidenceIds: ["ev-compatibility"],
      },
      migration: {
        statement: "Audit persisted aliases before enforcing the canonical key.",
        evidenceIds: ["ev-migration"],
      },
      privacy: {
        statement:
          "Use non-secret resource identity facts only; no protected value enters synthesis.",
        evidenceIds: ["ev-privacy"],
      },
      rollout: {
        statement: "Run shadow comparisons on both sibling paths before enforcement.",
        evidenceIds: ["ev-rollout"],
      },
      rollback: {
        statement:
          "Disable the shared owner and retain evidence without applying either local patch.",
        evidenceIds: ["ev-rollback"],
      },
      residualRisk: {
        statement:
          "An unobserved third normalization owner remains possible until inventory closes.",
        evidenceIds: ["ev-residual-risk"],
      },
    },
    verificationMatrix: [
      {
        verificationId: "verify-sibling-alias-acceptance",
        claim: "Both write and cleanup paths accept the same valid aliases through one owner.",
        coverage: ["acceptance", "sibling_regression"],
        evidenceIds: ["ev-write-candidate", "ev-cleanup-candidate", "ev-verification-contract"],
      },
      {
        verificationId: "verify-baseline-failure-sensitivity",
        claim: "Reintroducing divergent ownership fails both original reproduction oracles.",
        coverage: ["failure_path", "sibling_regression"],
        evidenceIds: ["ev-write-reproduction", "ev-cleanup-reproduction"],
      },
      {
        verificationId: "verify-alias-migration",
        claim: "Persisted aliases remain resolvable during migration and converge to one key.",
        coverage: ["migration", "rollout", "rollback"],
        evidenceIds: ["ev-migration", "ev-rollout", "ev-rollback"],
      },
      {
        verificationId: "verify-synthesis-privacy",
        claim: "No protected value is required or emitted by identity synthesis.",
        coverage: ["privacy"],
        evidenceIds: ["ev-privacy"],
      },
    ],
    uncertainties: [
      {
        uncertaintyId: "uncertainty-third-owner",
        statement: "The cluster does not establish whether another normalization owner exists.",
        missingEvidence: ["repository-wide resource identity ownership inventory"],
        evidenceIds: ["ev-residual-risk"],
      },
    ],
  };
}
