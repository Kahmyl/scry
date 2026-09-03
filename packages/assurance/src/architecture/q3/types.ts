import type { Q1InvariantResult, Q1Snapshot } from "../q1/types.js";

export type Q3ScenarioId =
  | "Q3-01"
  | "Q3-02"
  | "Q3-03"
  | "Q3-04"
  | "Q3-05"
  | "Q3-06"
  | "Q3-07"
  | "Q3-08"
  | "Q3-09"
  | "Q3-10"
  | "Q3-11"
  | "Q3-12"
  | "Q3-13"
  | "Q3-14";

export type Q3FixtureMode =
  | "NORMAL"
  | "DELAYED_ACK"
  | "DROP_ACK_AFTER_COMMIT"
  | "NO_COMMIT_DROP"
  | "RESPONSE_BEFORE_UI_PROJECTION"
  | "STILL_AMBIGUOUS";

export type Q3EvidenceMode =
  | "REQUIRED_AVAILABLE"
  | "REQUIRED_FAILED"
  | "REQUIRED_QUARANTINED"
  | "OPTIONAL_AVAILABLE"
  | "OPTIONAL_SUPPRESSED";

export type Q3OracleResource = Readonly<{
  id: string;
  label: string;
  quantity: number;
  state: "active" | "revoked";
  idempotencyKey: string;
}>;

export type Q3OracleTruth = Readonly<{
  source: "independent_fixture_oracle";
  generation: number;
  mutationRequests: readonly Readonly<{
    idempotencyKey: string;
    operationCorrelation: string | null;
    mode: Q3FixtureMode;
    committed: boolean;
    response: "normal" | "delayed" | "dropped";
    receivedSequence: number;
    acknowledgedSequence: number | null;
  }>[];
  resources: readonly Q3OracleResource[];
  retrievalCount: number;
  authenticationSuccessCount: number;
  documentGeneration: number;
  targetReplacementCount: number;
  workerRequestCount: number;
  evidenceMode: Q3EvidenceMode;
  cleanupRequests: number;
  cleanupEffects: number;
}>;

export type Q3ScryView = Readonly<{
  dispatchBoundary: "not_dispatched" | "possible" | "acknowledged";
  functionalTruth: Q1Snapshot["operation"]["functionalTruth"];
  mutationTruth: Q1Snapshot["operation"]["mutationTruth"];
  runtimeTruth: Q1Snapshot["truth"]["runtime"];
  evidenceTruth: Q1Snapshot["truth"]["evidence"];
  lifecycle: string;
  resourceIdentity: string | null;
  reconciliationResult: "none" | "proven_applied" | "proven_not_applied" | "still_unknown";
  redispatchCount: number;
}>;

export type Q3ProofProvenance =
  | "assurance_reference"
  | "repository_integration"
  | "real_browser_local"
  | "real_mcp_local"
  | "real_veil_local"
  | "real_chronicle_local"
  | "independent_fixture_oracle"
  | "production_characterization";

export type Q3ScenarioResult = Readonly<{
  id: Q3ScenarioId;
  seed: number;
  fixtureMode: Q3FixtureMode;
  evidenceMode: Q3EvidenceMode;
  productLayers: readonly string[];
  productionComponentsExecuted: readonly string[];
  modeledOrTestOnlyComponents: readonly string[];
  proofProvenance: readonly Q3ProofProvenance[];
  browser: boolean;
  postgres: boolean;
  veil: boolean;
  chronicle: boolean;
  mcp: boolean;
  q2Fault: string | null;
  scry: Q3ScryView;
  oracle: Q3OracleTruth;
  oracleDigest: string;
  comparison: "PASS" | "FAIL";
  comparisonReasons: readonly string[];
  q1: Readonly<{
    result: "PASS" | "FAIL";
    relevantInvariantIds: readonly string[];
    invariantResults: readonly Q1InvariantResult[];
  }>;
  verdict: "PASS" | "FAIL";
  assertions: readonly string[];
  lifecycleResidue: readonly string[];
  reproduction: string;
}>;
