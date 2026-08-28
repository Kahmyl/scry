import type { Q2BoundaryId } from "./types.js";

export type Q2ProofProvenance =
  | "assurance_reference"
  | "existing_regression_evidence"
  | "repository_integration"
  | "production_characterization"
  | "real_browser_local"
  | "independent_http_oracle";

export type Q2ProductionProofStatus =
  "characterized" | "partially_proven" | "production_proven_q2" | "future_proof_required";

export type Q2ProofProvenanceRecord = Readonly<{
  provenance: readonly Q2ProofProvenance[];
  productionComponentsExecuted: readonly string[];
  mockedWrappedOrTestOnlyComponents: readonly string[];
  durablePostgresInspected: boolean;
  realBrowserOrPraxisMechanicsExecuted: boolean;
  independentDispatchOracleUsed: boolean;
  resultingStateEvaluatedByQ1: true;
  productionProofStatus: Q2ProductionProofStatus;
  proofNotes: string;
}>;

const reference = "Assurance Q2 controller/scenario runner and Q1 reference snapshot";

export const q2ProofProvenance: Readonly<Record<Q2BoundaryId, Q2ProofProvenanceRecord>> = {
  B1: proof(
    ["assurance_reference", "repository_integration", "existing_regression_evidence"],
    ["AdaptiveSessionRepository", "ExecutionKernelRepository", "PostgreSQL repositories"],
    [reference, "isolated local PostgreSQL fixtures"],
    true,
    false,
    false,
    "partially_proven",
    "Real admission and operation-row repositories were exercised against PostgreSQL; the named Q2 rejection remains controller/reference driven rather than injected through full API admission.",
  ),
  B2: proof(
    ["assurance_reference", "real_browser_local", "existing_regression_evidence"],
    ["Praxis page context", "exact target/reference resolution"],
    [reference, "local browser fixture page"],
    false,
    true,
    false,
    "partially_proven",
    "Real local Praxis reference invalidation mechanics executed; the Q2 fault ledger and resulting truth vector are Assurance-owned.",
  ),
  B3: proof(
    [
      "assurance_reference",
      "repository_integration",
      "real_browser_local",
      "independent_http_oracle",
      "existing_regression_evidence",
    ],
    ["ProtectedOperationRepository", "Praxis exact-target mechanics", "PostgreSQL dispatch fence"],
    [reference, "loopback dispatch counter"],
    true,
    true,
    true,
    "partially_proven",
    "Repository fencing and exact-target mechanics executed independently; the complete pin-to-fence fault is not injected through one end-to-end production call.",
  ),
  B4: proof(
    [
      "assurance_reference",
      "repository_integration",
      "real_browser_local",
      "independent_http_oracle",
      "existing_regression_evidence",
    ],
    [
      "ProtectedOperationRepository",
      "ExecutionKernelRepository",
      "Praxis transaction/browser dispatch",
    ],
    [reference, "loopback dispatch counter"],
    true,
    true,
    true,
    "partially_proven",
    "Durable dispatch state, browser dispatch mechanics, and zero-versus-one oracle counts were exercised, but not as one complete injected production path.",
  ),
  B5: proof(
    [
      "assurance_reference",
      "real_browser_local",
      "independent_http_oracle",
      "existing_regression_evidence",
    ],
    ["Praxis transaction/browser action mechanics"],
    [reference, "loopback HTTP mutation endpoint"],
    false,
    true,
    true,
    "partially_proven",
    "Real browser action mechanics and an independent request counter executed separately; response-drop truth remains scenario modeled.",
  ),
  B6: proof(
    [
      "assurance_reference",
      "production_characterization",
      "independent_http_oracle",
      "existing_regression_evidence",
    ],
    ["API adaptive reconciliation and response-correlation regressions"],
    [reference, "loopback HTTP mutation endpoint"],
    false,
    false,
    true,
    "partially_proven",
    "The independent server proves request receipt while response loss leaves ambiguity; full provider-owned response correlation is future production proof.",
  ),
  B7: proof(
    [
      "assurance_reference",
      "production_characterization",
      "independent_http_oracle",
      "existing_regression_evidence",
    ],
    ["AdaptiveSessionKernelRunner outcome handling", "Praxis transaction policy"],
    [reference, "loopback HTTP mutation endpoint"],
    false,
    false,
    true,
    "partially_proven",
    "Owned-response/applied truth is characterized with existing production regressions and the oracle; exact effect-verification failure is not full-path injected.",
  ),
  B8: proof(
    ["assurance_reference", "production_characterization", "existing_regression_evidence"],
    ["AdaptiveSessionKernelRunner verified-observation construction"],
    [reference, "mocked interaction outcome"],
    false,
    false,
    false,
    "characterized",
    "Production outcome construction has regression evidence; this exact post-effect creation fault is evaluated in the Assurance reference model.",
  ),
  B9: proof(
    ["assurance_reference", "production_characterization", "existing_regression_evidence"],
    ["AdaptiveSessionKernelRunner verified-observation persistence path"],
    [reference, "mocked repository persistence rejection"],
    false,
    false,
    false,
    "partially_proven",
    "The production runner physically receives a post-execution persistence rejection and preserves completed truth; durable PostgreSQL failure injection was not used.",
  ),
  B10: proof(
    ["assurance_reference", "production_characterization", "existing_regression_evidence"],
    ["AgentDirectedRunService operation projection/finalization paths"],
    [reference, "mocked Run/session repositories"],
    false,
    false,
    false,
    "characterized",
    "Production service behavior has regression coverage, while the named projection fault is not injected through a durable Run repository transaction.",
  ),
  B11: proof(
    ["assurance_reference", "production_characterization", "existing_regression_evidence"],
    ["AgentDirectedRunService evidence completeness/finalization"],
    [reference, "mocked evidence and Run repositories"],
    false,
    false,
    false,
    "partially_proven",
    "Required and optional evidence decisions execute in production services with controlled dependencies; no durable evidence-link fault is injected.",
  ),
  B12: proof(
    ["assurance_reference", "production_characterization", "existing_regression_evidence"],
    ["RunProcessor", "Chronicle LocalArtifactStore", "artifact compensation path"],
    [reference, "mocked artifact metadata/timeline repository"],
    false,
    false,
    false,
    "partially_proven",
    "Real local artifact bytes are written and removed after metadata failure; the metadata-first/bytes-second direction is not separately representable.",
  ),
  B13: proof(
    ["assurance_reference", "repository_integration", "existing_regression_evidence"],
    ["ExecutionKernelRepository", "AdaptiveSessionRepository", "PostgreSQL atomic settlement"],
    [reference, "isolated local PostgreSQL fixtures"],
    true,
    false,
    false,
    "partially_proven",
    "Atomic operation settlement/fencing was inspected in PostgreSQL; complete Run/Attempt projection failure remains broader than the exercised repository transaction.",
  ),
  B14: proof(
    ["assurance_reference", "production_characterization", "existing_regression_evidence"],
    ["AgentDirectedRunService finalization and evidence gate"],
    [reference, "mocked Run/session repositories"],
    false,
    false,
    false,
    "partially_proven",
    "Production finalization logic executes under injected dependency failure; full durable Run finalization is not faulted in PostgreSQL.",
  ),
  B15: proof(
    ["assurance_reference", "production_characterization", "existing_regression_evidence"],
    ["AgentDirectedRunService evidence eligibility", "Mission evidence acceptance regressions"],
    [reference, "mocked Objective/evidence repositories"],
    false,
    false,
    false,
    "partially_proven",
    "Evidence eligibility and refusal are production-characterized; the Objective acceptance persistence boundary is not physically faulted.",
  ),
  B16: proof(
    ["assurance_reference", "existing_regression_evidence"],
    ["Mission/report publication contract regressions"],
    [reference, "report publication represented as a Q1/Q2 transition"],
    false,
    false,
    false,
    "future_proof_required",
    "No exact Q2 fault was injected through Mission/report publication; only contract regression and reference-state evidence currently exist.",
  ),
  B17: proof(
    [
      "assurance_reference",
      "repository_integration",
      "production_characterization",
      "existing_regression_evidence",
    ],
    [
      "ProtectedOutputPersistenceRepository",
      "ProtectedOperationRepository",
      "PostgreSQL protected-operation journal",
    ],
    [reference, "controlled transaction rejection harness"],
    true,
    false,
    false,
    "partially_proven",
    "Protected output transactions and canonical protected truth execute against production repositories, including rollback/fencing; the external provider/browser path is not end-to-end faulted.",
  ),
  B18: proof(
    [
      "assurance_reference",
      "repository_integration",
      "production_characterization",
      "existing_regression_evidence",
    ],
    [
      "AdaptiveSessionRepository runtime lease",
      "AdaptiveSessionKernelRunner fenced settlement",
      "PostgreSQL lease rows",
    ],
    [reference, "controlled lease-owner dependency"],
    true,
    false,
    false,
    "partially_proven",
    "Logical lease loss and stale fencing execute through production repositories/runners; real process loss remains Q4/Milestone 6 proof.",
  ),
  B19: proof(
    [
      "assurance_reference",
      "production_characterization",
      "real_browser_local",
      "existing_regression_evidence",
    ],
    ["AdaptiveSessionKernelRunner.close", "Praxis browser-session lifecycle"],
    [
      reference,
      "mocked browser close and durable lease-release rejection in the exact production ordering",
    ],
    false,
    true,
    false,
    "production_proven_q2",
    "The production runner is evicted, browser close succeeds, and durable lease release rejects; Q1 then detects L04 with mutation unknown and runtime recovery_required.",
  ),
  B20: proof(
    ["assurance_reference", "production_characterization", "existing_regression_evidence"],
    ["API causal runtime observability", "operational-event fan-out/fallback"],
    [reference, "mocked durable event sink rejection"],
    false,
    false,
    false,
    "partially_proven",
    "Production observability code executes with a failed durable sink and preserves product truth; universal causal-envelope attachment remains unproven.",
  ),
};

function proof(
  provenance: readonly Q2ProofProvenance[],
  productionComponentsExecuted: readonly string[],
  mockedWrappedOrTestOnlyComponents: readonly string[],
  durablePostgresInspected: boolean,
  realBrowserOrPraxisMechanicsExecuted: boolean,
  independentDispatchOracleUsed: boolean,
  productionProofStatus: Q2ProductionProofStatus,
  proofNotes: string,
): Q2ProofProvenanceRecord {
  return {
    provenance,
    productionComponentsExecuted,
    mockedWrappedOrTestOnlyComponents,
    durablePostgresInspected,
    realBrowserOrPraxisMechanicsExecuted,
    independentDispatchOracleUsed,
    resultingStateEvaluatedByQ1: true,
    productionProofStatus,
    proofNotes,
  };
}
