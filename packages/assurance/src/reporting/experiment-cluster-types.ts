export type ExperimentClusterEvidenceKind =
  | "reproduction"
  | "failure_signature"
  | "candidate_patch"
  | "verification"
  | "ownership"
  | "invariant"
  | "architectural_signal"
  | "compatibility"
  | "migration"
  | "privacy"
  | "rollout"
  | "rollback"
  | "residual_risk";

export type ArchitecturalThresholdSignal =
  | "duplicated_authority"
  | "invalid_representable_state"
  | "recurring_lifecycle_divergence"
  | "cleanup_dependent_safety"
  | "inevitable_new_bypass";

export type EvidenceFactValue =
  string | number | boolean | null | readonly string[] | readonly number[] | readonly boolean[];

export interface ExperimentClusterEvidenceInput {
  id: string;
  sourceExperimentIds: readonly string[];
  kind: ExperimentClusterEvidenceKind;
  artifactRef: string;
  summary: string;
  facts: Readonly<Record<string, EvidenceFactValue>>;
}

export interface ExperimentFailureSignatureInput {
  signature: string;
  evidenceIds: readonly string[];
}

export interface ExperimentCandidateOutcomeInput {
  status: "passed" | "failed" | "inconclusive";
  explanationEvidenceIds: readonly string[];
}

export interface ExperimentClusterMemberInput {
  experimentId: string;
  manifestRef: string;
  ledgerRef: string;
  baselineVerificationRef: string;
  candidateVerificationRef: string;
  patchRef: string;
  runtimeTelemetryRefs: readonly string[];
  failureSignatures: readonly ExperimentFailureSignatureInput[];
  candidateOutcome: ExperimentCandidateOutcomeInput;
}

export interface ExperimentInvariantFactInput {
  invariantId: string;
  statement: string;
  currentOwners: readonly string[];
  evidenceIds: readonly string[];
}

export interface ExperimentOwnershipFactInput {
  ownershipFactId: string;
  component: string;
  responsibility: string;
  evidenceIds: readonly string[];
}

export interface ExperimentArchitecturalSignalInput {
  signal: ArchitecturalThresholdSignal;
  evidenceIds: readonly string[];
}

export interface ExperimentCandidateConflictInput {
  conflictId: string;
  experimentIds: readonly string[];
  reason: string;
  evidenceIds: readonly string[];
}

export interface ExperimentClusterInput {
  clusterId: string;
  problemSignature: string;
  experiments: readonly ExperimentClusterMemberInput[];
  evidence: readonly ExperimentClusterEvidenceInput[];
  knownInvariants: readonly ExperimentInvariantFactInput[];
  ownershipFacts: readonly ExperimentOwnershipFactInput[];
  architecturalSignals: readonly ExperimentArchitecturalSignalInput[];
  candidateConflicts: readonly ExperimentCandidateConflictInput[];
}

export type ExperimentCluster = Readonly<ExperimentClusterInput>;

export interface NormalizedFailureSignature {
  signature: string;
  classification: "shared" | "distinct";
  experimentIds: readonly string[];
  evidenceIds: readonly string[];
}

export interface ExperimentClusterEvidenceBundle {
  schemaVersion: 1;
  clusterId: string;
  problemSignature: string;
  bundleDigest: string;
  experiments: readonly ExperimentClusterMemberInput[];
  evidence: readonly ExperimentClusterEvidenceInput[];
  failureSignatures: readonly NormalizedFailureSignature[];
  knownInvariants: readonly ExperimentInvariantFactInput[];
  ownershipFacts: readonly ExperimentOwnershipFactInput[];
  architecturalSignals: readonly ExperimentArchitecturalSignalInput[];
  candidateConflicts: readonly ExperimentCandidateConflictInput[];
}

export interface EvidenceLinkedFinding {
  findingId: string;
  statement: string;
  affectedExperimentIds: readonly string[];
  evidenceIds: readonly string[];
}

export interface ExperimentCandidateAssessment {
  experimentId: string;
  observedOutcome: ExperimentCandidateOutcomeInput["status"];
  explanation: string;
  evidenceIds: readonly string[];
}

export type CandidatePatchDisposition =
  | "candidate_for_review"
  | "retain_as_evidence"
  | "superseded_by_recommendation"
  | "reject_inconsistent";

export interface ExperimentCandidatePatchDisposition {
  experimentId: string;
  disposition: CandidatePatchDisposition;
  reason: string;
  evidenceIds: readonly string[];
}

export type RemediationScope = "contained" | "subsystem" | "foundational";

export interface ExperimentRemediationOption {
  optionId: string;
  scope: RemediationScope;
  viability: "viable" | "not_recommended" | "not_justified";
  summary: string;
  evidenceIds: readonly string[];
  thresholdSignals: readonly ArchitecturalThresholdSignal[];
  candidatePatchDispositions: readonly ExperimentCandidatePatchDisposition[];
}

export interface EvidenceLinkedAnalysis {
  statement: string;
  evidenceIds: readonly string[];
}

export interface ExperimentRemediationAnalysis {
  compatibility: EvidenceLinkedAnalysis;
  migration: EvidenceLinkedAnalysis;
  privacy: EvidenceLinkedAnalysis;
  rollout: EvidenceLinkedAnalysis;
  rollback: EvidenceLinkedAnalysis;
  residualRisk: EvidenceLinkedAnalysis;
}

export interface ExperimentVerificationMatrixEntry {
  verificationId: string;
  claim: string;
  coverage: readonly (
    | "acceptance"
    | "sibling_regression"
    | "failure_path"
    | "migration"
    | "privacy"
    | "rollout"
    | "rollback"
  )[];
  evidenceIds: readonly string[];
}

export interface ExperimentSynthesisUncertainty {
  uncertaintyId: string;
  statement: string;
  missingEvidence: readonly string[];
  evidenceIds: readonly string[];
}

export interface ExperimentRemediationProposal {
  sharedRootCauses: readonly EvidenceLinkedFinding[];
  distinctRootCauses: readonly EvidenceLinkedFinding[];
  violatedInvariantIds: readonly string[];
  currentOwnerFactIds: readonly string[];
  candidateAssessments: readonly ExperimentCandidateAssessment[];
  options: {
    contained: ExperimentRemediationOption;
    subsystem: ExperimentRemediationOption;
    foundational: ExperimentRemediationOption;
  };
  recommendedOptionId: string;
  recommendedAnalysis: ExperimentRemediationAnalysis;
  verificationMatrix: readonly ExperimentVerificationMatrixEntry[];
  uncertainties: readonly ExperimentSynthesisUncertainty[];
}

export interface ExperimentSynthesisAgentAdapter {
  readonly descriptor: {
    id: string;
    provider: string;
    version: string;
  };
  propose(bundle: ExperimentClusterEvidenceBundle): Promise<ExperimentRemediationProposal>;
}

export interface ExperimentClusterSynthesis {
  schemaVersion: 1;
  clusterId: string;
  evidenceBundleDigest: string;
  proposalSource: "deterministic" | "agent_assisted";
  proposalAgent: ExperimentSynthesisAgentAdapter["descriptor"] | null;
  proposal: ExperimentRemediationProposal;
  authorizationRequired: true;
  executionAuthority: "none";
  prohibitedActions: readonly ["patch_application", "push", "merge", "deployment"];
}
