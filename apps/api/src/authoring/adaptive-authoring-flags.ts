export type AdaptiveAuthoringFlags = {
  interactiveProbeSessions: boolean;
  candidateAssistedResolution: boolean;
  selectorHints: boolean;
  riskAdaptiveThresholds: boolean;
  authenticationKernel: boolean;
  malformedControlCorpus: boolean;
  protectedAcquisitionAdapters: boolean;
  transcriptCompiler: boolean;
  certificationPublicationGate: boolean;
  releaseCorpusGate: boolean;
};

export function adaptiveAuthoringFlags(
  environment: NodeJS.ProcessEnv = process.env,
): AdaptiveAuthoringFlags {
  return {
    interactiveProbeSessions: enabled(environment, "SCRY_INTERACTIVE_PROBE_SESSIONS_ENABLED", true),
    candidateAssistedResolution: enabled(
      environment,
      "SCRY_CANDIDATE_ASSISTED_RESOLUTION_ENABLED",
      true,
    ),
    selectorHints: enabled(environment, "SCRY_SELECTOR_HINTS_ENABLED", true),
    riskAdaptiveThresholds: enabled(environment, "SCRY_RISK_ADAPTIVE_THRESHOLDS_ENABLED", true),
    authenticationKernel: enabled(environment, "SCRY_AUTHENTICATION_KERNEL_ENABLED", true),
    malformedControlCorpus: enabled(environment, "SCRY_MALFORMED_CONTROL_CORPUS_ENABLED", false),
    protectedAcquisitionAdapters: enabled(
      environment,
      "SCRY_PROTECTED_ACQUISITION_ADAPTERS_ENABLED",
      false,
    ),
    transcriptCompiler: enabled(environment, "SCRY_TRANSCRIPT_COMPILER_ENABLED", false),
    certificationPublicationGate: enabled(
      environment,
      "SCRY_CERTIFICATION_PUBLICATION_GATE_ENABLED",
      false,
    ),
    releaseCorpusGate: enabled(environment, "SCRY_RELEASE_CORPUS_GATE_ENABLED", false),
  };
}

function enabled(environment: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const value = environment[name];
  if (value === undefined) return fallback;
  return value === "true";
}
