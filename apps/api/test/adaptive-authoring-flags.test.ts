import { describe, expect, it } from "vitest";

import { adaptiveAuthoringFlags } from "../src/authoring/adaptive-authoring-flags.js";

describe("adaptive authoring rollout controls", () => {
  it("keeps established PR1-PR8 behavior enabled and new release gates opt-in", () => {
    expect(adaptiveAuthoringFlags({})).toEqual({
      interactiveProbeSessions: true,
      candidateAssistedResolution: true,
      selectorHints: true,
      riskAdaptiveThresholds: true,
      authenticationKernel: true,
      malformedControlCorpus: false,
      protectedAcquisitionAdapters: false,
      transcriptCompiler: false,
      certificationPublicationGate: false,
      releaseCorpusGate: false,
    });
  });

  it("parses every control independently without truthy-string ambiguity", () => {
    expect(
      adaptiveAuthoringFlags({
        SCRY_INTERACTIVE_PROBE_SESSIONS_ENABLED: "false",
        SCRY_MALFORMED_CONTROL_CORPUS_ENABLED: "true",
        SCRY_PROTECTED_ACQUISITION_ADAPTERS_ENABLED: "true",
        SCRY_TRANSCRIPT_COMPILER_ENABLED: "true",
        SCRY_CERTIFICATION_PUBLICATION_GATE_ENABLED: "true",
        SCRY_RELEASE_CORPUS_GATE_ENABLED: "true",
      }),
    ).toMatchObject({
      interactiveProbeSessions: false,
      malformedControlCorpus: true,
      protectedAcquisitionAdapters: true,
      transcriptCompiler: true,
      certificationPublicationGate: true,
      releaseCorpusGate: true,
    });
  });
});
