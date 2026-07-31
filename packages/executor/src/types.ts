import type {
  Artifact,
  AttemptResult,
  ExecutionPolicyV1,
  RunEvent,
  TestPlan,
  OutcomeClassification,
} from "@scry/contracts";
import type { RuntimePolicyViolationCode } from "@scry/policy";

export type SecretResolver = (reference: string) => Promise<string>;
export type SecretCapture = (name: string, value: string) => Promise<{ credentialId: string }>;

export type ExecuteOptions = {
  plan: TestPlan;
  policy: ExecutionPolicyV1;
  outputDirectory: string;
  runId?: string;
  attemptId?: string;
  browserChannel?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  secretResolver?: SecretResolver;
  secretCapture?: SecretCapture;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  readinessTimeoutMultiplier?: number;
};

export type ExecutionReport = AttemptResult & {
  protocolVersion: "1" | "2";
  planName: string;
  outcomeClassification: OutcomeClassification;
  error?: string;
  steps: StepExecutionResult[];
  diagnostics: DiagnosticRecord[];
  policyViolations: PolicyViolationRecord[];
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
