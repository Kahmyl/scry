import { supabase } from "./supabase.js";
import { publicConfig } from "./runtime-config.js";

export const API_BASE = publicConfig.apiBaseUrl;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authenticatedHeaders(init?.headers);
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 401) await supabase?.auth.signOut();
    throw new Error(
      body?.message
        ? Array.isArray(body.message)
          ? body.message.join(", ")
          : body.message
        : `Request failed (${response.status})`,
    );
  }
  return body as T;
}

export async function apiBlob(path: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: await authenticatedHeaders(),
  });
  if (!response.ok) throw new Error(`Artifact request failed (${response.status})`);
  return response.blob();
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown) {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function remove<T>(path: string) {
  return api<T>(path, { method: "DELETE" });
}

async function authenticatedHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  if (data.session?.access_token) {
    headers.set("authorization", `Bearer ${data.session.access_token}`);
  }
  return headers;
}

export type Project = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
};

export type Environment = {
  id: string;
  name: string;
  baseOrigin: string;
  policy: Record<string, unknown>;
};

export type VeilPreferenceRecord = {
  schemaVersion: 1;
  environmentId: string;
  preferences: {
    profile: "balanced" | "private" | "minimal_capture" | "custom";
    allowedOrigins: string[];
    controls: Record<string, boolean>;
    leaseTtlMs: number;
  };
  effectivePolicy: {
    profile: "balanced" | "private" | "minimal_capture" | "custom";
    digest: string;
    controls: Record<string, boolean>;
    allowedOrigins: string[];
    leaseTtlMs: number;
  };
  updatedAt: string;
};

export type VeilRunObservation = {
  schemaVersion: 1;
  effectiveProfile: "balanced" | "private" | "minimal_capture" | "custom";
  policyDigest: string;
  status: "pending" | "verified" | "degraded" | "sealed";
  timeline: Array<{
    sequence: number;
    type: "transition" | "gap" | "disposition";
    startedAt: string;
    endedAt?: string;
    reasonCode: string;
    channel?: string;
  }>;
  gaps: Array<{ startedAt: string; endedAt?: string; reasonCode: string; remediation: string }>;
  findings: Array<{
    code: string;
    severity: "info" | "warning" | "blocking";
    reasonCode: string;
    channel?: string;
    occurredAt?: string;
    remediation: string;
  }>;
};

export type Credential = {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type Calibration = {
  id: string;
  missionId: string;
  objectiveId: string;
  name: string;
  latestRevisionId: string;
  revision: number;
  operationId: string;
  operationDigest: string;
  sessionId?: string;
  attestationId?: string;
  status: "draft" | "approved" | "rejected";
  sessionState?:
    | "requested"
    | "queued"
    | "claimed"
    | "preparing"
    | "executing_preflight"
    | "boundary_reached"
    | "arming_privacy"
    | "capsule_bootstrapping"
    | "preparation_running"
    | "preparation_verified"
    | "executing_protected_transaction"
    | "verifying_safe_exit"
    | "scanning_channels"
    | "attested"
    | "failed"
    | "cancelled"
    | "expired"
    | "sealed"
    | "mutation_outcome_unknown";
  safeDiagnostics?: { code?: string; phase?: string; stepId?: string };
  createdAt: string;
};
export type CredentialIncident = {
  id: string;
  runId: string;
  credentialId?: string;
  operationId: string;
  adapterId?: string;
  state: "pending" | "revoked" | "failed" | "timed_out" | "manual_action_required";
  reasonCode: string;
  safeDiagnostics?: { code?: string; manualAction?: string };
  createdAt: string;
  resolvedAt?: string;
};

export type McpAccessToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  token?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
};

export type Flow = {
  id: string;
  name: string;
  description: string;
  visibility?: "reusable" | "mission_local" | "internal";
  purpose?: string;
  missionLinks?: Array<{ missionId: string; objectiveId: string; missionTitle: string }>;
  latestVersion?: number;
  latestVersionId?: string;
  latestContent?: {
    objective: string;
    expectedOutcomes: string[];
  };
  latestRevisionId?: string;
  latestRevision?: number;
  latestPlan?: {
    name?: string;
    objective?: string;
    steps: Array<{
      id?: string;
      title?: string;
      action?: {
        type?: string;
        url?: string;
        target?: {
          concept?: string;
          requiredCapabilities?: string[];
          preferredEvidence?: {
            roles?: string[];
            names?: string[];
            labels?: string[];
            expectedText?: string;
            visual?: { sources?: string[] };
          };
          scope?: { kind?: string };
        };
        value?: string;
        secretRef?: string;
      };
      assertions?: Array<{
        type?: string;
        expected?: string;
        match?: string;
        target?: {
          concept?: string;
          requiredCapabilities?: string[];
          preferredEvidence?: {
            roles?: string[];
            names?: string[];
            labels?: string[];
            expectedText?: string;
            visual?: { sources?: string[] };
          };
          scope?: { kind?: string };
        };
      }>;
      after?: {
        mode?: "all" | "any";
        timeoutMs?: number;
        conditions?: Array<Record<string, unknown>>;
      };
      captureIntent?: "final" | "transient";
    }>;
    allowedOrigins?: string[];
  };
};

export type Run = {
  id: string;
  missionId: string;
  objectiveId: string;
  missionTitle?: string;
  role?:
    | "exploratory"
    | "diagnostic"
    | "calibration"
    | "candidate"
    | "accepted"
    | "superseded"
    | "invalidated";
  state: RunState;
  planName: string;
  createdAt: string;
  updatedAt: string;
  currentPhase?: string;
  phase?: string;
  attemptCount: number;
  rerunOfRunId?: string;
  resolvedAt?: string;
  resolvedByRunId?: string;
  needsAttention: boolean;
  outcomeClassification?: OutcomeClassification;
  resultClassification?:
    | "application_pass"
    | "application_failure"
    | "calibration_required"
    | "infrastructure_failure"
    | "environment_failure"
    | "policy_refusal"
    | "cancelled"
    | "legacy_authoring_attempt";
  reliabilityEligible?: boolean;
  compiledContractId?: string;
  confirmationOfRunId?: string;
  confirmationRunId?: string;
  environmentSnapshot: { name: string; baseOrigin: string };
  executionSnapshot: {
    browser: string;
    viewport: { width: number; height: number };
    seed: number;
  };
};

export type MissionSummary = {
  id: string;
  projectId: string;
  title: string;
  originalInstruction: string;
  status:
    "planning" | "running" | "blocked" | "awaiting_user" | "completed" | "failed" | "cancelled";
  resumePointer?: MissionResumePointer;
  revision: number;
  objectiveCount: number;
  terminalObjectiveCount: number;
  acceptedEvidenceCount: number;
  lastMeaningfulActivity?: string;
  latestReportId?: string;
  createdAt: string;
  updatedAt: string;
};
export type MissionResumePointer = {
  objectiveId: string;
  recommendedAction:
    | "revise_flow"
    | "run_candidate"
    | "review_failure"
    | "complete_calibration"
    | "await_user"
    | "publish_report";
  flowId?: string;
  revisionId?: string;
  runId?: string;
  explanation: string;
};
export type MissionObjective = {
  id: string;
  title: string;
  description: string;
  status: "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";
  orchestrationState?:
    | "unscheduled"
    | "ready"
    | "queued"
    | "running"
    | "awaiting_evidence"
    | "passed"
    | "failed"
    | "blocked"
    | "awaiting_authorization"
    | "cancelled";
  executionMode?: "automatic" | "manual";
  blockerCode?: string;
  blockerDetails?: Record<string, unknown>;
  activeRunId?: string;
  dependencies: string[];
  completionCriteria: Array<{ description: string; required: boolean }>;
  conclusion?: string;
  order: number;
  latestCandidateRunId?: string;
};
export type MissionDetail = MissionSummary & {
  objectives: MissionObjective[];
  flows: Array<Flow & { objectiveId: string }>;
  runs: Array<Run>;
  authoring: Array<{
    id: string;
    objectiveId: string;
    name: string;
    state: "editing" | "probing" | "compiling" | "publishable" | "published" | "abandoned";
    version: number;
    updatedAt: string;
    probes: Array<{
      id: string;
      level: string;
      state: string;
      draftVersion: number;
      result?: { allResolved?: boolean; diagnostics?: Array<{ code?: string }> };
      createdAt: string;
    }>;
    compilations: Array<{
      id: string;
      status: string;
      draftVersion: number;
      diagnostics: Array<{ code?: string }>;
      createdAt: string;
    }>;
  }>;
  acceptedEvidence: Array<{
    id: string;
    objectiveId: string;
    runId: string;
    artifactId?: string;
    conclusion: string;
    acceptedAt: string;
  }>;
  reports: MissionReport[];
};
export type MissionReport = {
  id: string;
  missionId: string;
  missionTitle?: string;
  revision: number;
  status: "published" | "superseded";
  snapshot: {
    mission: { title: string; originalInstruction: string; status: string };
    overallConclusion: string;
    journeySummary: string[];
    remainingActions: string[];
    objectiveResults: Array<{
      id: string;
      title: string;
      status: string;
      conclusion?: string;
      acceptedRunIds: string[];
      acceptedArtifactIds: string[];
    }>;
    supersededAttemptCount: number;
    generatedAt: string;
  };
  createdAt: string;
};

export type OutcomeClassification =
  | "passed"
  | "assertion_failure"
  | "readiness_timeout"
  | "transient_observation"
  | "inconclusive_plan"
  | "confirmed_product_failure"
  | "non_reproduced_failure"
  | "infrastructure_failure"
  | "policy_failure"
  | "execution_timeout"
  | "cancelled";

export type RunState =
  | "draft"
  | "queued"
  | "preparing"
  | "running"
  | "finalizing"
  | "passed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "infrastructure_error";

export type Report = {
  praxis: {
    contractVersion: 1;
    runtimeVersions: string[];
    status: "pending" | "complete" | "unavailable" | "failed";
    transactions: Array<{
      transactionId: string;
      operationId: string;
      stepId?: string | null;
      runtimeVersion: string;
      startedAt: string;
      completedAt?: string | null;
      result: {
        status: "succeeded" | "failed" | "inconclusive" | "cancelled";
        mutationOutcome: "not_started" | "not_applied" | "applied" | "unknown";
        retry?: "safe" | "unsafe" | "requires_reobservation" | "requires_revision";
        timing: { totalMs: number; phases: Record<string, number | null> };
        report: { summary: string; safeActions: string[] };
      };
    }>;
    findings: Array<{
      id: string;
      transactionId: string;
      finding: { code: string; severity: string; confidence: number; remediation: string };
      artifactRefs: string[];
      createdAt: string;
    }>;
  };
  run: Run & {
    planSnapshot: {
      name: string;
      objective: string;
      steps: Array<{
        id: string;
        title: string;
        action: { type: string };
        after?: { mode: "all" | "any"; timeoutMs: number; conditions: Array<{ type: string }> };
        captureIntent?: "final" | "transient";
      }>;
    };
    policySnapshot: Record<string, unknown>;
  };
  attempts: Array<{
    id: string;
    attemptNumber: number;
    state: RunState;
    startedAt?: string;
    completedAt?: string;
    error?: string;
  }>;
  currentAttempt?: {
    id: string;
    attemptNumber: number;
    state: RunState;
    startedAt?: string;
    completedAt?: string;
    error?: string;
  } | null;
  events: Array<{
    id: string;
    attemptId: string;
    sequence: number;
    type: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  }>;
  steps: Array<{
    attemptId: string;
    stepId: string;
    title: string;
    ordinal: number;
    action: { status: "passed" | "failed" | "unevaluated"; error?: string | null };
    readiness?: {
      status?: "passed" | "failed" | "not_configured";
      error?: string;
      [key: string]: unknown;
    } | null;
    assertions: Array<{
      index: number;
      type: string;
      status: "passed" | "failed" | "unevaluated";
      error?: string | null;
    }>;
    assertionsSummary: { passed: number; failed: number; unevaluated: number };
    evidence: Array<{ kind?: string; status?: string; error?: string; [key: string]: unknown }>;
    startedAt?: string | null;
    completedAt?: string | null;
    durationMs?: number | null;
  }>;
  artifacts: Array<{
    id: string;
    attemptId: string;
    stepId?: string;
    kind: string;
    availability: "pending" | "available" | "incomplete" | "quarantined" | "destroyed" | "failed";
    privacyClassification: "safe" | "sanitized" | "uncertain";
    failureProvenance?: string;
    reasonCode?: string;
    contentType: string;
    sizeBytes?: string;
    observation?: Record<string, unknown>;
    resource?: string | null;
  }>;
  artifactTimeline: import("./recording-timeline.js").RecordingTimelineEntry[];
  privacy: {
    intervals: Array<Record<string, unknown>>;
    operations: Array<Record<string, unknown>>;
    credentialIncidents: Array<Record<string, unknown>>;
  };
  veil: VeilRunObservation;
  failure?: {
    provenance: "product" | "plan" | "policy" | "infrastructure" | "privacy" | "executor";
    code: string;
    message?: string;
    stepId?: string;
    channel?: string;
  } | null;
  sections: {
    attempts: string;
    steps: string;
    events: string;
    artifacts: string;
    timeline: string;
  };
  integrity: {
    status: "complete" | "partial" | "failed";
    issues: Array<{ code: string; message: string }>;
  };
  safeActions: Array<"cancel" | "rerun" | "revise_flow" | "read_artifact">;
  release: { releaseId: string; schemaFingerprint: string };
};
