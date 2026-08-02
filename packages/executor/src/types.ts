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
import type { BrowserContext, Page } from "playwright";
import type { CalibrationStructure } from "./calibration.js";

import type { RecordingCoordinator } from "./recording-coordinator.js";
import type { PrivacyGate } from "./privacy-gate.js";

export type SecretResolver = (reference: string) => Promise<string>;
export type SecretCapture = (name: string, value: string) => Promise<{ credentialId: string }>;
export type AtomicSecretCapture = (input: { operationId: string; reference: string; name: string; value: string; scope: "run" | "project" }) => Promise<{ credentialId: string }>;
export type PublicValueCapture = (input: { operationId: string; reference: string; name: string; value: string; scope: "run" | "project" }) => Promise<{ valueId: string }>;
export type PublicValueResolver = (reference: string) => Promise<string>;
export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type ExecuteOptions = {
  plan: CurrentPlan;
  policy: ExecutionPolicy;
  outputDirectory: string;
  runId?: string;
  attemptId?: string;
  browserChannel?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  browserStorageState?: BrowserStorageState;
  captureBrowserState?: (state: BrowserStorageState) => void | Promise<void>;
  secretResolver?: SecretResolver;
  secretCapture?: SecretCapture;
  atomicSecretCapture?: AtomicSecretCapture;
  publicValueCapture?: PublicValueCapture;
  publicValueResolver?: PublicValueResolver;
  protectedTransactionStore?: import("./protected-transaction-coordinator.js").ProtectedTransactionStore;
  checkpointStore?: import("./checkpoint-coordinator.js").CheckpointStore;
  flowRevisionId?: string;
  environmentId?: string;
  calibrationVerifier?: (input: { attestationId: string; operationId: string; operationDigest: string; structureFingerprint: string }) => Promise<boolean>;
  /**
   * Internal calibration rehearsal boundary. Execution stops before the matching
   * protected mutation and returns the sanitized page structure to the caller.
   * This is deliberately not a plan action or public protocol capability.
   */
  calibrationRehearsal?: {
    operationId: string;
    stopBeforeMutation?: boolean;
    onBoundary: (input: { stepId: string; structure: CalibrationStructure; url: string }) => void | Promise<void>;
  };
  markCredentialCompromised?: (credentialId: string, code: string, operationId: string) => Promise<void>;
  recordContextProvenance?: (input: { contextId: string; provenance: import("@scry/contracts").ContextProvenance; operationId: string }) => Promise<void>;
  recoverAcquisition?: (input: { operationId: string; expiresAt: string; permittedActions: string[] }) => Promise<{ action: "retry" | "request_secure_assistance" | "revoke" | "abandon" | "expired"; correctedScope?: import("@scry/contracts").SemanticScope }>;
  groundingHistory?: (intentDigest: string) => Promise<import("@scry/contracts").SemanticFingerprint | undefined>;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  readinessTimeoutMultiplier?: number;
  /** Phase 1 synthetic-gap hook. It must never handle real protected values. */
  recordingTestHook?: (input: { page: Page; recording: RecordingCoordinator }) => Promise<void>;
  /** Phase 2 synthetic privacy interval hook. It must never handle real protected values. */
  privacyTestHook?: (input: { page: Page; privacy: PrivacyGate }) => Promise<void>;
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
  evidence: Array<{ kind: "screenshot" | "dom" | "network"; status: "available" | "degraded" | "failed"; error?: string }>;
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
