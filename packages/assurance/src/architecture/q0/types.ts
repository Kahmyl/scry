export type ModelClassification =
  | "current_authoritative_owner"
  | "current_logical_identity"
  | "current_compatibility_adapter"
  | "current_read_only_projection"
  | "qualification_only"
  | "historical_retained_schema"
  | "unresolved_from_static_source";

export type SourceEvidence = {
  path: string;
  symbol?: string;
  note: string;
};

export type StateProbe = {
  path: string;
  exportName: string;
};

export type Machine = {
  id: string;
  name: string;
  classification: ModelClassification;
  durableOrLogicalOwner: string;
  sourceEvidence: SourceEvidence[];
  states: string[];
  terminalStates: string[];
  transitionAuthority: string;
  immutabilityRules: string[];
  leaseOrFence: string;
  expiry: string;
  recoveryOwner: string;
  dependencies: string[];
  stateProbe?: StateProbe;
  transitionEdges?: Record<string, string[]>;
};

export type LegacyOverlay = {
  id: string;
  name: string;
  classification: ModelClassification;
  rationale: string;
  sourceEvidence: SourceEvidence[];
};

export type TruthDimension = {
  id: string;
  name: string;
  productionSource: string;
  values: string[];
  monotonicity: string;
  establishingComponents: string[];
  projectionOnlyComponents: string[];
};

export type OwnershipConcern = {
  id: string;
  concern: string;
  status:
    | "single_owner"
    | "layered_ownership"
    | "compatibility_projection"
    | "genuine_duplicate_authority"
    | "unresolved";
  authoritativeOwner: string;
  layers: {
    semanticTruthOwner: string;
    transitionPolicyOwner: string;
    commandOrchestrationOwners: string[];
    transactionPersistenceOwner: string;
    projectionOwners: string[];
    qualificationOwner: string;
  };
  collaboratingComponents: string[];
  forbiddenOwners: string[];
  sourceEvidence: SourceEvidence[];
  finding?: string;
};

export type Boundary = {
  id: string;
  name: string;
  ownerConcernId: string;
  component: string;
  sourceEvidence: SourceEvidence[];
  truthBefore: string;
  possibleEffect: string;
  legalFailureClassifications: string[];
  retryClass: string;
  recoveryOwner: string;
  invariantIds: string[];
};

export type TimerLease = {
  id: string;
  name: string;
  owner: string;
  sourceEvidence: SourceEvidence[];
  startBoundary: string;
  renewal: string;
  expirationSemantics: string;
  mutationImplication: string;
  recoveryOwner: string;
  explicitlyDurable: boolean;
};

export type AuthorityDomain = {
  id: string;
  name: string;
  owner: string;
  scope: string;
  sourceEvidence: SourceEvidence[];
  mayEstablishDocumentAuthority: boolean;
};

export type ConflictScope = {
  id: string;
  blocker: string;
  scopeDimensions: string[];
  owner: string;
  sourceEvidence: SourceEvidence[];
  repositoryGlobalAllowed: boolean;
};

export type Invariant = {
  id: string;
  statement: string;
  risk: "P0" | "P1" | "P2" | "P3";
  authoritativeComponents: string[];
  machineIds: string[];
  stateRefs: Array<{ machineId: string; state: string }>;
  boundaryIds: string[];
  currentProofLocations: string[];
  proofStrength: "strong" | "medium" | "weak" | "missing";
  missingProof: string;
  futureGate: "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6" | "Q7";
};

export type Risk = {
  id: string;
  level: "P0" | "P1";
  statement: string;
  invariantIds: string[];
  boundaryIds: string[];
  owner: string;
  stabilizationMilestone: number;
};

export type ArchitectureSource = {
  path: string;
  status: "canonical" | "current_supporting" | "superseded_or_historical";
};

export type CorrectnessManifest = {
  schemaVersion: 1;
  manifestVersion: string;
  authorityRule: "production_authority_plus_independent_drift_detector";
  machines: Machine[];
  legacyOverlays: LegacyOverlay[];
  truthVector: TruthDimension[];
  ownership: OwnershipConcern[];
  boundaries: Boundary[];
  timersAndLeases: TimerLease[];
  authorityDomains: AuthorityDomain[];
  conflictScopes: ConflictScope[];
  invariants: Invariant[];
  risks: Risk[];
  architectureSources: ArchitectureSource[];
  unresolvedQuestions: string[];
};

export type Q0ReasonId =
  | "Q0_DUPLICATE_AUTHORITATIVE_OWNER"
  | "Q0_STALE_ARCHITECTURE_CANONICAL"
  | "Q0_UNKNOWN_PRODUCTION_STATE"
  | "Q0_MANIFEST_TERMINAL_UNKNOWN"
  | "Q0_TRANSITION_AUTHORITY_DRIFT"
  | "Q0_UNCLASSIFIED_LEGACY_OVERLAY"
  | "Q0_INVARIANT_REFERENCE_INVALID"
  | "Q0_BOUNDARY_OWNER_UNKNOWN"
  | "Q0_BOUNDARY_RECOVERY_OWNER_MISSING"
  | "Q0_REQUEST_LOADER_DOCUMENT_AUTHORITY"
  | "Q0_SOURCE_EVIDENCE_MISSING"
  | "Q0_RISK_TRACEABILITY_INCOMPLETE"
  | "Q0_DUPLICATE_ID";

export type Q0Finding = {
  reasonId: Q0ReasonId;
  subject: string;
  message: string;
};

export type ProductionSnapshot = {
  states: Record<string, string[]>;
  terminalStates: Record<string, string[]>;
  transitionEdges: Record<string, string[]>;
};

export type NegativeControlResult = {
  id: string;
  expectedReasonId: Q0ReasonId;
  observedReasonIds: Q0ReasonId[];
  passed: boolean;
};
