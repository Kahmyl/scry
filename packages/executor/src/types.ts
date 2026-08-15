import type {
  Artifact,
  AttemptResult,
  ExecutionPolicy,
  RecordingTimelineEntry,
  RunEvent,
  CurrentPlan,
  OutcomeClassification,
} from "@scry/contracts";
import type { RuntimePolicyViolationCode } from "@scry/policy";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import type { CalibrationStructure } from "./calibration.js";

import type { RecordingCoordinator } from "./recording-coordinator.js";
import type { VeilRuntimeCoordinator } from "@scry/veil";

export type SecretResolver = (reference: string) => Promise<string>;
export type SecretCapture = (name: string, value: string) => Promise<{ credentialId: string }>;
export type AtomicSecretCapture = (input: {
  operationId: string;
  reference: string;
  name: string;
  value: string;
  scope: "run" | "project";
}) => Promise<{ credentialId: string }>;
export type PublicValueCapture = (input: {
  operationId: string;
  reference: string;
  name: string;
  value: string;
  scope: "run" | "project";
}) => Promise<{ valueId: string }>;
export type AtomicOutputCapture = (input: {
  operationId: string;
  claim: import("./protected-transaction-coordinator.js").ProtectedOperationClaim;
  outputs: Array<{
    reference: string;
    classification: "public" | "protected";
    name: string;
    value: string;
    scope: "run" | "project";
  }>;
  externalResourceBindings: import("@scry/contracts").ProtectedTransaction["extraction"]["externalResourceBindings"];
}) => Promise<{
  claim: import("./protected-transaction-coordinator.js").ProtectedOperationClaim;
  references: Record<string, { classification: "public" | "protected"; credentialId?: string; valueId?: string; scope: "run" | "project" }>;
}>;
export type PublicValueResolver = (reference: string) => Promise<string>;
export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type ExecuteOptions = {
  plan: CurrentPlan;
  policy: ExecutionPolicy;
  outputDirectory: string;
  /** Internal ownership of external expected-effect verification. */
  expectedEffectVerificationOwner?: "kernel" | "praxis";
  runId?: string;
  attemptId?: string;
  browserChannel?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  browserStorageState?: BrowserStorageState;
  /** Native browser authority supplied by the deployed runtime composition root. */
  openBrowser?: (options?: BrowserContextOptions) => Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
  }>;
  executeNativeNavigation?: (
    page: Page,
    url: string,
    allowedOrigins: string[],
    timeoutMs?: number,
    trustedScriptOrigins?: string[],
  ) => Promise<void>;
  /** Typed same-origin request authority. The deployed driver owns cookies and any bearer bridge. */
  executeSameOriginRequest?: (
    page: Page,
    request: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: Record<string, string | number | boolean | null>;
      expectedStatus: { min: number; max: number };
      timeoutMs?: number;
    },
    allowedOrigins: string[],
    beforeDispatch?: () => Promise<void>,
  ) => Promise<{ status: number; classification: "expected" | "unexpected" }>;
  onNativeResolution?: (input: {
    status: "resolved" | "fallback";
    reasonCode?: string;
    durationMs: number;
  }) => void | Promise<void>;
  onExpectedEffectVerification?: (input: {
    status: "succeeded" | "failed";
    reasonCode?: string;
    durationMs: number;
  }) => void | Promise<void>;
  /** Internal authoring boundary: execute against the already-owned safe session. */
  existingSafeSession?: import("./browser-session.js").SafeBrowserSession;
  captureBrowserState?: (state: BrowserStorageState) => void | Promise<void>;
  captureSuccessorCheckpoint?: (checkpoint: {
    schemaVersion: 1;
    policyDigest: string;
    storageState: BrowserStorageState;
    sessionStorage: { origin: string; entries: Array<[string, string]> };
    restorationUrl: string;
    safeSemanticContext: {
      title: string;
      controls: Array<{ role: string; name: string }>;
    };
  }) => void | Promise<void>;
  secretResolver?: SecretResolver;
  secretCapture?: SecretCapture;
  atomicSecretCapture?: AtomicSecretCapture;
  publicValueCapture?: PublicValueCapture;
  atomicOutputCapture?: AtomicOutputCapture;
  stageProtectedResponseOutputs?: NonNullable<
    import("./protected-transaction-coordinator.js").ProtectedTransactionDependencies["stageResponseOutputsAtomically"]
  >;
  recoverStagedProtectedResponseOutputs?: NonNullable<
    import("./protected-transaction-coordinator.js").ProtectedTransactionDependencies["recoverStagedResponseOutputs"]
  >;
  publicValueResolver?: PublicValueResolver;
  protectedTransactionStore?: import("./protected-transaction-coordinator.js").ProtectedTransactionStore;
  checkpointStore?: import("./checkpoint-coordinator.js").CheckpointStore;
  flowRevisionId?: string;
  environmentId?: string;
  calibrationVerifier?: (input: {
    attestationId: string;
    operationId: string;
    operationDigest: string;
    structureFingerprint: string;
  }) => Promise<boolean>;
  /**
   * Internal calibration rehearsal boundary. Execution stops before the matching
   * protected mutation and returns the sanitized page structure to the caller.
   * This is deliberately not a plan action or public protocol capability.
   */
  calibrationRehearsal?: {
    operationId: string;
    stopBeforeMutation?: boolean;
    onBoundary: (input: {
      stepId: string;
      structure: CalibrationStructure;
      url: string;
    }) => void | Promise<void>;
  };
  markCredentialCompromised?: (
    credentialId: string,
    code: string,
    operationId: string,
  ) => Promise<void>;
  recordContextProvenance?: (input: {
    contextId: string;
    provenance: import("@scry/contracts").ContextProvenance;
    operationId: string;
  }) => Promise<void>;
  recoverAcquisition?: (input: {
    operationId: string;
    expiresAt: string;
    permittedActions: string[];
  }) => Promise<{
    action: "retry" | "request_secure_assistance" | "revoke" | "abandon" | "expired";
    correctedScope?: import("@scry/contracts").SemanticScope;
  }>;
  groundingHistory?: (
    intentDigest: string,
  ) => Promise<import("@scry/contracts").SemanticFingerprint | undefined>;
  onGroundingDiagnostic?: (
    diagnostic: import("@scry/praxis").GroundingDiagnostic & {
      intentDigest: string;
      outcome: "resolved" | "rejected";
      code?: string;
    },
  ) => void | Promise<void>;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  onPraxisResult?: (result: import("@scry/contracts").PraxisResult) => void | Promise<void>;
  /** Durable fence hook invoked after target resolution, immediately before browser dispatch. */
  onMutationDispatch?: () => void | Promise<void>;
  /** Trusted runtime-only disposition; absent from authored plans and actions. */
  dispatchDisposition?: "execute" | "qualification_only";
  onReadyToDispatch?: (input: { operationId: string; disposition: "execute" | "qualification_only" }) => void | Promise<void>;
  /** Internal phase signal used to derive privacy settlement from lifecycle facts. */
  onPrivacyBoundary?: (phase: "entered" | "verified" | "sealed") => void | Promise<void>;
  readinessTimeoutMultiplier?: number;
  veilAdmissionKey?: string;
  /** Immutable, run-bound Veil authority snapshot. Production workers must provide it. */
  veilPolicySnapshot?: import("@scry/contracts").VeilPolicySnapshot;
  /** Phase 1 synthetic-gap hook. It must never handle real protected values. */
  recordingTestHook?: (input: { page: Page; recording: RecordingCoordinator }) => Promise<void>;
  /** Phase 2 synthetic privacy interval hook. It must never handle real protected values. */
  privacyTestHook?: (input: { page: Page; privacy: VeilRuntimeCoordinator }) => Promise<void>;
};

export type ExecutionReport = AttemptResult & {
  planName: string;
  outcomeClassification: OutcomeClassification;
  error?: string;
  steps: StepExecutionResult[];
  diagnostics: DiagnosticRecord[];
  policyViolations: PolicyViolationRecord[];
  artifactTimeline: RecordingTimelineEntry[];
};

export type StepExecutionResult = {
  id: string;
  title: string;
  status: "passed" | "failed" | "unevaluated";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  assertions: AssertionExecutionResult[];
  artifacts: Artifact[];
  evidenceFailures?: Array<{ kind: Artifact["kind"]; error: string }>;
  action: { status: "passed" | "failed" | "unevaluated"; error?: string };
  evidence: Array<{
    kind: "screenshot" | "dom" | "network";
    status: "available" | "degraded" | "failed";
    error?: string;
  }>;
  readiness?: {
    status: "passed" | "failed" | "not_configured";
    startedAt: string;
    completedAt: string;
    durationMs: number;
    matchedConditions: string[];
    error?: string;
  };
  stabilization?: {
    method: "dom-and-network" | "none";
    durationMs: number;
    domQuiet: boolean;
    networkQuiet: boolean;
    visibleLoader: boolean;
  };
};

export type AssertionExecutionResult = {
  index: number;
  type: string;
  status: "passed" | "failed" | "unevaluated";
  error?: string;
};

export type DiagnosticRecord = {
  type: "console" | "page_error" | "request_failed";
  occurredAt: string;
  message: string;
  url?: string;
  method?: string;
};

export type PolicyViolationRecord = {
  code: RuntimePolicyViolationCode;
  message: string;
  occurredAt: string;
  target?: string;
  resourceType?: string;
  disposition?: "fatal" | "blocked_subresource";
};
