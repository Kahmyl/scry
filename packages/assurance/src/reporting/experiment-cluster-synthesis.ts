import { createHash } from "node:crypto";
import type {
  ArchitecturalThresholdSignal,
  EvidenceFactValue,
  EvidenceLinkedFinding,
  ExperimentCluster,
  ExperimentClusterEvidenceBundle,
  ExperimentClusterEvidenceInput,
  ExperimentClusterInput,
  ExperimentClusterMemberInput,
  ExperimentClusterSynthesis,
  ExperimentRemediationAnalysis,
  ExperimentRemediationOption,
  ExperimentRemediationProposal,
  ExperimentSynthesisAgentAdapter,
  ExperimentSynthesisUncertainty,
  ExperimentVerificationMatrixEntry,
  NormalizedFailureSignature,
} from "./experiment-cluster-types.js";

export * from "./experiment-cluster-types.js";

export function defineExperimentCluster(input: ExperimentClusterInput): ExperimentCluster {
  const cluster = cloneCanonical(input);

  validateCluster(cluster);

  return deepFreeze(cluster);
}

export function normalizeExperimentClusterEvidence(
  clusterInput: ExperimentCluster,
): ExperimentClusterEvidenceBundle {
  validateCluster(clusterInput);
  const cluster = cloneCanonical(clusterInput);
  const experiments = [...cluster.experiments]
    .map((experiment) => ({
      ...experiment,
      runtimeTelemetryRefs: sortedUnique(experiment.runtimeTelemetryRefs),
      failureSignatures: [...experiment.failureSignatures]
        .map((signature) => ({
          ...signature,
          evidenceIds: sortedUnique(signature.evidenceIds),
        }))
        .sort((left, right) => left.signature.localeCompare(right.signature)),
      candidateOutcome: {
        ...experiment.candidateOutcome,
        explanationEvidenceIds: sortedUnique(experiment.candidateOutcome.explanationEvidenceIds),
      },
    }))
    .sort((left, right) => left.experimentId.localeCompare(right.experimentId));
  const evidence = [...cluster.evidence]
    .map((item) => ({
      ...item,
      sourceExperimentIds: sortedUnique(item.sourceExperimentIds),
      facts: sortRecord(item.facts),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const failureSignatures = normalizeFailureSignatures(experiments);
  const knownInvariants = [...cluster.knownInvariants]
    .map((item) => ({
      ...item,
      currentOwners: sortedUnique(item.currentOwners),
      evidenceIds: sortedUnique(item.evidenceIds),
    }))
    .sort((left, right) => left.invariantId.localeCompare(right.invariantId));
  const ownershipFacts = [...cluster.ownershipFacts]
    .map((item) => ({ ...item, evidenceIds: sortedUnique(item.evidenceIds) }))
    .sort((left, right) => left.ownershipFactId.localeCompare(right.ownershipFactId));
  const architecturalSignals = [...cluster.architecturalSignals]
    .map((item) => ({ ...item, evidenceIds: sortedUnique(item.evidenceIds) }))
    .sort((left, right) => left.signal.localeCompare(right.signal));
  const candidateConflicts = [...cluster.candidateConflicts]
    .map((item) => ({
      ...item,
      experimentIds: sortedUnique(item.experimentIds),
      evidenceIds: sortedUnique(item.evidenceIds),
    }))
    .sort((left, right) => left.conflictId.localeCompare(right.conflictId));
  const digestInput = {
    schemaVersion: 1 as const,
    clusterId: cluster.clusterId,
    problemSignature: cluster.problemSignature,
    experiments,
    evidence,
    failureSignatures,
    knownInvariants,
    ownershipFacts,
    architecturalSignals,
    candidateConflicts,
  };
  const bundle: ExperimentClusterEvidenceBundle = {
    ...digestInput,
    bundleDigest: sha256(canonicalJson(digestInput)),
  };

  return deepFreeze(bundle);
}

export function synthesizeExperimentCluster(
  cluster: ExperimentCluster,
  proposalInput: ExperimentRemediationProposal,
): ExperimentClusterSynthesis {
  const bundle = normalizeExperimentClusterEvidence(cluster);
  const proposal = validateAndFreezeProposal(bundle, proposalInput);

  return deepFreeze({
    schemaVersion: 1,
    clusterId: bundle.clusterId,
    evidenceBundleDigest: bundle.bundleDigest,
    proposalSource: "deterministic",
    proposalAgent: null,
    proposal,
    authorizationRequired: true,
    executionAuthority: "none",
    prohibitedActions: ["patch_application", "push", "merge", "deployment"],
  });
}

export async function synthesizeExperimentClusterWithAgent(
  cluster: ExperimentCluster,
  agent: ExperimentSynthesisAgentAdapter,
): Promise<ExperimentClusterSynthesis> {
  requireText(agent.descriptor.id, "SYNTHESIS_AGENT_ID");
  requireText(agent.descriptor.provider, "SYNTHESIS_AGENT_PROVIDER");
  requireText(agent.descriptor.version, "SYNTHESIS_AGENT_VERSION");
  const bundle = normalizeExperimentClusterEvidence(cluster);
  const proposal = validateAndFreezeProposal(bundle, await agent.propose(bundle));

  return deepFreeze({
    schemaVersion: 1,
    clusterId: bundle.clusterId,
    evidenceBundleDigest: bundle.bundleDigest,
    proposalSource: "agent_assisted",
    proposalAgent: cloneCanonical(agent.descriptor),
    proposal,
    authorizationRequired: true,
    executionAuthority: "none",
    prohibitedActions: ["patch_application", "push", "merge", "deployment"],
  });
}

function validateCluster(cluster: ExperimentClusterInput): void {
  requireText(cluster.clusterId, "CLUSTER_ID");
  requireText(cluster.problemSignature, "PROBLEM_SIGNATURE");

  if (cluster.experiments.length < 2) {
    throw new Error("ASSURANCE_EXPERIMENT_CLUSTER_SIBLINGS_REQUIRED");
  }

  const experimentIds = uniqueIdentifiers(
    cluster.experiments.map(({ experimentId }) => experimentId),
    "EXPERIMENT_ID",
  );
  const evidenceIds = uniqueIdentifiers(
    cluster.evidence.map(({ id }) => id),
    "EVIDENCE_ID",
  );
  const evidenceById = new Map(cluster.evidence.map((evidence) => [evidence.id, evidence]));

  for (const evidence of cluster.evidence) {
    requireText(evidence.id, "EVIDENCE_ID");
    requireText(evidence.artifactRef, "EVIDENCE_ARTIFACT_REF");
    requireText(evidence.summary, "EVIDENCE_SUMMARY");

    const sourceExperiments = uniqueIdentifiers(
      evidence.sourceExperimentIds,
      "EVIDENCE_SOURCE_EXPERIMENT",
    );

    if (sourceExperiments.size === 0) {
      throw new Error(`ASSURANCE_EXPERIMENT_CLUSTER_EVIDENCE_SOURCE_REQUIRED:${evidence.id}`);
    }

    for (const experimentId of sourceExperiments) {
      if (!experimentIds.has(experimentId)) {
        throw new Error(`ASSURANCE_EXPERIMENT_CLUSTER_EVIDENCE_EXPERIMENT_UNKNOWN:${evidence.id}`);
      }
    }

    canonicalJson(evidence.facts);
  }

  for (const experiment of cluster.experiments) {
    for (const value of [
      experiment.experimentId,
      experiment.manifestRef,
      experiment.ledgerRef,
      experiment.baselineVerificationRef,
      experiment.candidateVerificationRef,
      experiment.patchRef,
    ]) {
      requireText(value, "EXPERIMENT_REFERENCE");
    }

    if (experiment.failureSignatures.length === 0) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_CLUSTER_FAILURE_SIGNATURE_REQUIRED:${experiment.experimentId}`,
      );
    }

    for (const signature of experiment.failureSignatures) {
      requireText(signature.signature, "FAILURE_SIGNATURE");
      validateEvidenceLinks(
        signature.evidenceIds,
        evidenceIds,
        evidenceById,
        [experiment.experimentId],
        "FAILURE_SIGNATURE",
      );
    }

    validateEvidenceLinks(
      experiment.candidateOutcome.explanationEvidenceIds,
      evidenceIds,
      evidenceById,
      [experiment.experimentId],
      "CANDIDATE_OUTCOME",
    );
  }

  uniqueIdentifiers(
    cluster.knownInvariants.map(({ invariantId }) => invariantId),
    "INVARIANT_ID",
  );
  for (const invariant of cluster.knownInvariants) {
    requireText(invariant.statement, "INVARIANT_STATEMENT");

    if (invariant.currentOwners.length === 0) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_CLUSTER_INVARIANT_OWNER_REQUIRED:${invariant.invariantId}`,
      );
    }

    validateEvidenceLinks(
      invariant.evidenceIds,
      evidenceIds,
      evidenceById,
      experimentIds,
      "INVARIANT",
    );
  }

  uniqueIdentifiers(
    cluster.ownershipFacts.map(({ ownershipFactId }) => ownershipFactId),
    "OWNERSHIP_FACT_ID",
  );
  for (const ownership of cluster.ownershipFacts) {
    requireText(ownership.component, "OWNERSHIP_COMPONENT");
    requireText(ownership.responsibility, "OWNERSHIP_RESPONSIBILITY");
    validateEvidenceLinks(
      ownership.evidenceIds,
      evidenceIds,
      evidenceById,
      experimentIds,
      "OWNERSHIP",
    );
  }

  const signals = new Set<ArchitecturalThresholdSignal>();
  for (const signal of cluster.architecturalSignals) {
    if (signals.has(signal.signal)) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_CLUSTER_ARCHITECTURAL_SIGNAL_DUPLICATE:${signal.signal}`,
      );
    }

    signals.add(signal.signal);
    validateEvidenceLinks(
      signal.evidenceIds,
      evidenceIds,
      evidenceById,
      experimentIds,
      "ARCHITECTURAL_SIGNAL",
    );
  }

  uniqueIdentifiers(
    cluster.candidateConflicts.map(({ conflictId }) => conflictId),
    "CANDIDATE_CONFLICT_ID",
  );
  for (const conflict of cluster.candidateConflicts) {
    const conflictExperiments = uniqueIdentifiers(conflict.experimentIds, "CONFLICT_EXPERIMENT_ID");

    if (conflictExperiments.size < 2) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_CLUSTER_CONFLICT_SIBLINGS_REQUIRED:${conflict.conflictId}`,
      );
    }

    for (const experimentId of conflictExperiments) {
      if (!experimentIds.has(experimentId)) {
        throw new Error(
          `ASSURANCE_EXPERIMENT_CLUSTER_CONFLICT_EXPERIMENT_UNKNOWN:${conflict.conflictId}`,
        );
      }
    }

    validateEvidenceLinks(
      conflict.evidenceIds,
      evidenceIds,
      evidenceById,
      conflictExperiments,
      "CANDIDATE_CONFLICT",
    );
  }
}

function validateAndFreezeProposal(
  bundle: ExperimentClusterEvidenceBundle,
  proposalInput: ExperimentRemediationProposal,
): ExperimentRemediationProposal {
  const proposal = cloneCanonical(proposalInput);
  const evidenceIds = new Set(bundle.evidence.map(({ id }) => id));
  const evidenceById = new Map(bundle.evidence.map((evidence) => [evidence.id, evidence]));
  const experimentIds = new Set(bundle.experiments.map(({ experimentId }) => experimentId));
  const invariantIds = new Set(bundle.knownInvariants.map(({ invariantId }) => invariantId));
  const ownerFactIds = new Set(bundle.ownershipFacts.map(({ ownershipFactId }) => ownershipFactId));

  if (proposal.sharedRootCauses.length === 0) {
    throw new Error("ASSURANCE_EXPERIMENT_SYNTHESIS_SHARED_ROOT_CAUSE_REQUIRED");
  }

  validateFindings(
    proposal.sharedRootCauses,
    "SHARED_ROOT_CAUSE",
    evidenceIds,
    evidenceById,
    experimentIds,
    2,
  );
  validateFindings(
    proposal.distinctRootCauses,
    "DISTINCT_ROOT_CAUSE",
    evidenceIds,
    evidenceById,
    experimentIds,
    1,
  );

  validateKnownIdentifiers(proposal.violatedInvariantIds, invariantIds, "VIOLATED_INVARIANT");
  validateKnownIdentifiers(proposal.currentOwnerFactIds, ownerFactIds, "CURRENT_OWNER_FACT");

  const assessments = new Map(
    proposal.candidateAssessments.map((assessment) => [assessment.experimentId, assessment]),
  );

  if (
    assessments.size !== proposal.candidateAssessments.length ||
    assessments.size !== experimentIds.size
  ) {
    throw new Error("ASSURANCE_EXPERIMENT_SYNTHESIS_CANDIDATE_ASSESSMENT_COVERAGE_INVALID");
  }

  for (const experiment of bundle.experiments) {
    const assessment = assessments.get(experiment.experimentId);

    if (!assessment || assessment.observedOutcome !== experiment.candidateOutcome.status) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_SYNTHESIS_CANDIDATE_OUTCOME_MISMATCH:${experiment.experimentId}`,
      );
    }

    requireText(assessment.explanation, "CANDIDATE_ASSESSMENT");
    validateEvidenceLinks(
      assessment.evidenceIds,
      evidenceIds,
      evidenceById,
      [experiment.experimentId],
      "CANDIDATE_ASSESSMENT",
    );
  }

  const options = [
    proposal.options.contained,
    proposal.options.subsystem,
    proposal.options.foundational,
  ];
  const optionIds = uniqueIdentifiers(
    options.map(({ optionId }) => optionId),
    "OPTION_ID",
  );

  for (const [scope, option] of [
    ["contained", proposal.options.contained],
    ["subsystem", proposal.options.subsystem],
    ["foundational", proposal.options.foundational],
  ] as const) {
    if (option.scope !== scope) {
      throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_OPTION_SCOPE_INVALID:${scope}`);
    }

    requireText(option.summary, "OPTION_SUMMARY");
    validateEvidenceLinks(
      option.evidenceIds,
      evidenceIds,
      evidenceById,
      experimentIds,
      "REMEDIATION_OPTION",
    );
    validatePatchDispositions(option, bundle, evidenceIds, evidenceById);
  }

  validateFoundationalOption(proposal.options.foundational, bundle);

  if (!optionIds.has(proposal.recommendedOptionId)) {
    throw new Error("ASSURANCE_EXPERIMENT_SYNTHESIS_RECOMMENDED_OPTION_UNKNOWN");
  }

  const recommended = options.find(({ optionId }) => optionId === proposal.recommendedOptionId);

  if (!recommended || recommended.viability !== "viable") {
    throw new Error("ASSURANCE_EXPERIMENT_SYNTHESIS_RECOMMENDED_OPTION_NOT_VIABLE");
  }

  rejectConflictingPatchRecommendation(recommended, bundle);
  validateAnalysis(proposal.recommendedAnalysis, evidenceIds, evidenceById, experimentIds);
  validateVerificationMatrix(proposal.verificationMatrix, evidenceIds, evidenceById, experimentIds);
  validateUncertainties(proposal.uncertainties, evidenceIds);

  return deepFreeze(proposal);
}

function validateFindings(
  findings: readonly EvidenceLinkedFinding[],
  label: string,
  evidenceIds: ReadonlySet<string>,
  evidenceById: ReadonlyMap<string, ExperimentClusterEvidenceInput>,
  experimentIds: ReadonlySet<string>,
  requiredExperimentCount: number,
): void {
  uniqueIdentifiers(
    findings.map(({ findingId }) => findingId),
    `${label}_ID`,
  );

  for (const finding of findings) {
    requireText(finding.statement, label);
    const affected = uniqueIdentifiers(finding.affectedExperimentIds, `${label}_EXPERIMENT`);

    if (affected.size !== requiredExperimentCount && requiredExperimentCount === 1) {
      throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_${label}_SCOPE_INVALID:${finding.findingId}`);
    }

    if (requiredExperimentCount > 1 && affected.size < requiredExperimentCount) {
      throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_${label}_SCOPE_INVALID:${finding.findingId}`);
    }

    for (const experimentId of affected) {
      if (!experimentIds.has(experimentId)) {
        throw new Error(
          `ASSURANCE_EXPERIMENT_SYNTHESIS_${label}_EXPERIMENT_UNKNOWN:${finding.findingId}`,
        );
      }
    }

    validateEvidenceLinks(finding.evidenceIds, evidenceIds, evidenceById, affected, label);
  }
}

function validatePatchDispositions(
  option: ExperimentRemediationOption,
  bundle: ExperimentClusterEvidenceBundle,
  evidenceIds: ReadonlySet<string>,
  evidenceById: ReadonlyMap<string, ExperimentClusterEvidenceInput>,
): void {
  const dispositions = new Map(
    option.candidatePatchDispositions.map((item) => [item.experimentId, item]),
  );

  if (
    dispositions.size !== option.candidatePatchDispositions.length ||
    dispositions.size !== bundle.experiments.length
  ) {
    throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_PATCH_DISPOSITION_COVERAGE:${option.optionId}`);
  }

  for (const experiment of bundle.experiments) {
    const disposition = dispositions.get(experiment.experimentId);

    if (!disposition) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_SYNTHESIS_PATCH_DISPOSITION_MISSING:${experiment.experimentId}`,
      );
    }

    requireText(disposition.reason, "PATCH_DISPOSITION_REASON");
    validateEvidenceLinks(
      disposition.evidenceIds,
      evidenceIds,
      evidenceById,
      [experiment.experimentId],
      "PATCH_DISPOSITION",
    );
  }
}

function validateFoundationalOption(
  option: ExperimentRemediationOption,
  bundle: ExperimentClusterEvidenceBundle,
): void {
  const available = new Set(bundle.architecturalSignals.map(({ signal }) => signal));
  const requested = new Set(option.thresholdSignals);

  if (option.viability === "viable" && requested.size === 0) {
    throw new Error("ASSURANCE_EXPERIMENT_SYNTHESIS_FOUNDATIONAL_THRESHOLD_REQUIRED");
  }

  if (option.viability === "not_justified" && requested.size > 0) {
    throw new Error("ASSURANCE_EXPERIMENT_SYNTHESIS_FOUNDATIONAL_THRESHOLD_CONTRADICTED");
  }

  for (const signal of requested) {
    if (!available.has(signal)) {
      throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_FOUNDATIONAL_SIGNAL_UNSUPPORTED:${signal}`);
    }

    const signalEvidence = bundle.architecturalSignals.find(
      (item) => item.signal === signal,
    )?.evidenceIds;

    if (!signalEvidence?.some((evidenceId) => option.evidenceIds.includes(evidenceId))) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_SYNTHESIS_FOUNDATIONAL_SIGNAL_EVIDENCE_REQUIRED:${signal}`,
      );
    }
  }
}

function rejectConflictingPatchRecommendation(
  recommended: ExperimentRemediationOption,
  bundle: ExperimentClusterEvidenceBundle,
): void {
  const dispositions = new Map(
    recommended.candidatePatchDispositions.map(({ experimentId, disposition }) => [
      experimentId,
      disposition,
    ]),
  );

  for (const conflict of bundle.candidateConflicts) {
    const promoted = conflict.experimentIds.filter(
      (experimentId) => dispositions.get(experimentId) === "candidate_for_review",
    );

    if (promoted.length > 1) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_SYNTHESIS_CONFLICTING_PATCH_RECOMMENDATION:${conflict.conflictId}`,
      );
    }
  }
}

function validateAnalysis(
  analysis: ExperimentRemediationAnalysis,
  evidenceIds: ReadonlySet<string>,
  evidenceById: ReadonlyMap<string, ExperimentClusterEvidenceInput>,
  experimentIds: ReadonlySet<string>,
): void {
  for (const [key, item] of Object.entries(analysis)) {
    requireText(item.statement, `ANALYSIS_${key.toUpperCase()}`);
    validateEvidenceLinks(
      item.evidenceIds,
      evidenceIds,
      evidenceById,
      experimentIds,
      `ANALYSIS_${key.toUpperCase()}`,
    );
  }
}

function validateVerificationMatrix(
  matrix: readonly ExperimentVerificationMatrixEntry[],
  evidenceIds: ReadonlySet<string>,
  evidenceById: ReadonlyMap<string, ExperimentClusterEvidenceInput>,
  experimentIds: ReadonlySet<string>,
): void {
  if (matrix.length === 0) {
    throw new Error("ASSURANCE_EXPERIMENT_SYNTHESIS_VERIFICATION_MATRIX_REQUIRED");
  }

  uniqueIdentifiers(
    matrix.map(({ verificationId }) => verificationId),
    "VERIFICATION_MATRIX_ID",
  );

  for (const row of matrix) {
    requireText(row.claim, "VERIFICATION_MATRIX_CLAIM");

    if (row.coverage.length === 0) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_SYNTHESIS_VERIFICATION_COVERAGE_REQUIRED:${row.verificationId}`,
      );
    }

    validateEvidenceLinks(
      row.evidenceIds,
      evidenceIds,
      evidenceById,
      experimentIds,
      "VERIFICATION_MATRIX",
    );
  }
}

function validateUncertainties(
  uncertainties: readonly ExperimentSynthesisUncertainty[],
  evidenceIds: ReadonlySet<string>,
): void {
  uniqueIdentifiers(
    uncertainties.map(({ uncertaintyId }) => uncertaintyId),
    "UNCERTAINTY_ID",
  );

  for (const uncertainty of uncertainties) {
    requireText(uncertainty.statement, "UNCERTAINTY");

    if (uncertainty.missingEvidence.length === 0) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_SYNTHESIS_MISSING_EVIDENCE_REQUIRED:${uncertainty.uncertaintyId}`,
      );
    }

    for (const evidenceId of uncertainty.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_EVIDENCE_UNKNOWN:${evidenceId}`);
      }
    }
  }
}

function validateEvidenceLinks(
  linkedIds: readonly string[],
  evidenceIds: ReadonlySet<string>,
  evidenceById: ReadonlyMap<string, ExperimentClusterEvidenceInput>,
  allowedExperiments: Iterable<string>,
  label: string,
): void {
  if (linkedIds.length === 0) {
    throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_EVIDENCE_REQUIRED:${label}`);
  }

  const allowed = new Set(allowedExperiments);

  for (const evidenceId of new Set(linkedIds)) {
    if (!evidenceIds.has(evidenceId)) {
      throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_EVIDENCE_UNKNOWN:${evidenceId}`);
    }

    const evidence = evidenceById.get(evidenceId);

    if (!evidence?.sourceExperimentIds.some((experimentId) => allowed.has(experimentId))) {
      throw new Error(
        `ASSURANCE_EXPERIMENT_SYNTHESIS_EVIDENCE_SCOPE_INVALID:${label}:${evidenceId}`,
      );
    }
  }
}

function normalizeFailureSignatures(
  experiments: readonly ExperimentClusterMemberInput[],
): readonly NormalizedFailureSignature[] {
  const grouped = new Map<
    string,
    {
      experimentIds: Set<string>;
      evidenceIds: Set<string>;
    }
  >();

  for (const experiment of experiments) {
    for (const signature of experiment.failureSignatures) {
      const group = grouped.get(signature.signature) ?? {
        experimentIds: new Set<string>(),
        evidenceIds: new Set<string>(),
      };

      group.experimentIds.add(experiment.experimentId);
      for (const evidenceId of signature.evidenceIds) {
        group.evidenceIds.add(evidenceId);
      }

      grouped.set(signature.signature, group);
    }
  }

  return [...grouped.entries()]
    .map(([signature, group]) => {
      const experimentIds = [...group.experimentIds].sort();

      return {
        signature,
        classification: experimentIds.length > 1 ? "shared" : "distinct",
        experimentIds,
        evidenceIds: [...group.evidenceIds].sort(),
      } satisfies NormalizedFailureSignature;
    })
    .sort((left, right) => left.signature.localeCompare(right.signature));
}

function validateKnownIdentifiers(
  identifiers: readonly string[],
  known: ReadonlySet<string>,
  label: string,
): void {
  if (identifiers.length === 0) {
    throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_${label}_REQUIRED`);
  }

  const unique = uniqueIdentifiers(identifiers, label);

  for (const identifier of unique) {
    if (!known.has(identifier)) {
      throw new Error(`ASSURANCE_EXPERIMENT_SYNTHESIS_${label}_UNKNOWN:${identifier}`);
    }
  }
}

function uniqueIdentifiers(values: readonly string[], label: string): Set<string> {
  const unique = new Set<string>();

  for (const value of values) {
    requireText(value, label);

    if (unique.has(value)) {
      throw new Error(`ASSURANCE_EXPERIMENT_CLUSTER_${label}_DUPLICATE:${value}`);
    }

    unique.add(value);
  }

  return unique;
}

function requireText(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`ASSURANCE_EXPERIMENT_CLUSTER_${label}_REQUIRED`);
  }
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortRecord<T extends EvidenceFactValue>(
  input: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, T>;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("ASSURANCE_EXPERIMENT_CLUSTER_NON_FINITE_FACT");
  }

  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }

    Object.freeze(value);
  }

  return value;
}
