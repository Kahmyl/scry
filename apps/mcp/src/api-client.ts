import {
  PRAXIS_CONTRACT_VERSION,
  PRAXIS_RUNTIME_VERSION,
  PRAXIS_SCORING_POLICY_VERSION,
} from "@scry/contracts";

export class ScryApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly safeActions: string[] = [],
    readonly context: Record<string, unknown> = {},
  ) {
    super(`Scry API request rejected: ${JSON.stringify({ code, status, safeActions, context })}`);
    this.name = "ScryApiError";
  }
}

const SAFE_REJECTION_CONTEXT_KEYS = new Set([
  "state",
  "current",
  "target",
  "phase",
  "capability",
  "missingCount",
  "limit",
  "actualVersion",
  "actualRevision",
  "actualRevisionId",
  "commandId",
  "turnId",
  "sourceMissionRevision",
  "currentMissionRevision",
  "objectiveId",
  "dependencyId",
  "mutationOutcome",
  "retry",
  "retryClass",
  "continuation",
  "recoveryTool",
  "requiresNewFlowDraftAndAuthoringSession",
  "idempotencyReuse",
  "disclosedOrigins",
  "missingTrustedScriptOrigins",
  "missingAllowedOrigin",
  "environment",
  "environmentId",
  "resourceExists",
  "executionReadiness",
  "recovery",
  "recoveryBinding",
  "recoveryKind",
  "requiresFreshIdempotencyKey",
  "requiresPendingTurn",
  "failedAuthoringSessionId",
  "failedOperationId",
  "sourceTurnId",
  "preservesMissionId",
  "preservesObjectiveId",
  "preservesFlowDraftId",
  "preservesCurrentFlow",
  "missionId",
  "flowDraftId",
  "sessionId",
  "environmentResourceExists",
  "refreshedDecisionBoundary",
  "requestedTurnId",
  "currentTurnState",
  "type",
  "reasonCode",
  "authoringRecovery",
  "idempotencyKey",
  "operationId",
  "reconciliation",
  "redispatchAllowed",
  "missionFenceCleared",
  "validationIssueCount",
  "safeActions",
]);

export function apiRejection(error: ScryApiError) {
  const { mutationOutcome, retry, retryClass, ...context } = error.context;
  return {
    code: error.code,
    status: error.status,
    appliedState: mutationOutcome ?? "unknown",
    retry: retry ?? retryClass ?? "unspecified",
    safeActions: error.safeActions,
    ...(Object.keys(context).length ? { context } : {}),
  };
}

export class ScryApiClient {
  private capabilitiesPromise?: Promise<ScryCapabilities>;
  constructor(
    readonly baseUrl = process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/api",
    readonly serviceToken = process.env.SCRY_SERVICE_TOKEN,
    readonly publicBaseUrl = process.env.SCRY_PUBLIC_API_BASE_URL ?? baseUrl,
  ) {}

  async get<T>(path: string): Promise<T> {
    return this.request(path);
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request(path, { method: "DELETE" });
  }

  capabilities() {
    this.capabilitiesPromise ??= this.get<ScryCapabilities>("/capabilities");
    return this.capabilitiesPromise;
  }

  async requireCurrentRelease() {
    const capabilities = await this.capabilities();
    const expectedRelease = process.env.SCRY_RELEASE_ID;
    const expectedSchema = process.env.SCRY_SCHEMA_FINGERPRINT;
    if (
      (expectedRelease && capabilities.releaseId !== expectedRelease) ||
      (expectedSchema && capabilities.schemaFingerprint !== expectedSchema)
    ) {
      throw new ScryApiError(
        "SCRY_RELEASE_MISMATCH",
        409,
        ["restart_mcp_with_current_release", "verify_api_release"],
        { mutationOutcome: "not_applied", retry: "safe_after_prerequisite" },
      );
    }
    if (
      !capabilities.praxis ||
      capabilities.praxis.contractVersion !== PRAXIS_CONTRACT_VERSION ||
      capabilities.praxis.runtimeVersion !== PRAXIS_RUNTIME_VERSION ||
      capabilities.praxis.scoringPolicyVersion !== PRAXIS_SCORING_POLICY_VERSION ||
      capabilities.praxis.cutoff !== true
    ) {
      throw new ScryApiError(
        "SCRY_PRAXIS_VERSION_MISMATCH",
        409,
        ["restart_mcp_with_current_release", "verify_api_release"],
        { mutationOutcome: "not_applied", retry: "safe_after_prerequisite" },
      );
    }
    return capabilities;
  }

  artifactUrl(artifactId: string) {
    return `${this.publicBaseUrl}/artifacts/${encodeURIComponent(artifactId)}`;
  }

  async getArtifact(artifactId: string) {
    const headers = new Headers();
    if (this.serviceToken) headers.set("authorization", `Bearer ${this.serviceToken}`);
    const response = await fetch(`${this.baseUrl}/artifacts/${encodeURIComponent(artifactId)}`, {
      headers,
    });
    if (!response.ok) throw new Error(`Scry artifact request failed: HTTP ${response.status}`);
    return {
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      data: new Uint8Array(await response.arrayBuffer()),
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (this.serviceToken) headers.set("authorization", `Bearer ${this.serviceToken}`);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = asRecord(body);
      const detail = asRecord(envelope?.message) ?? envelope;

      const detailCode = stringField(detail, "code");
      const envelopeCode = stringField(envelope, "code");
      const validationMessages = stringArrayField(envelope, "message") ?? [];

      const inferredValidationFailure =
        response.status === 400 && !detailCode && !envelopeCode && validationMessages.length > 0;

      const code =
        detailCode ??
        envelopeCode ??
        (typeof envelope?.message === "string" ? envelope.message : undefined) ??
        (inferredValidationFailure
          ? "SCRY_API_REQUEST_VALIDATION_FAILED"
          : `HTTP_${response.status}`);

      const safeActions =
        stringArrayField(detail, "safeActions") ?? stringArrayField(envelope, "safeActions") ?? [];

      const { safeActions: _safeActions, code: _code, ...safeDetail } = detail ?? {};

      throw new ScryApiError(code, response.status, safeActions, {
        ...safeRejectionContext(safeDetail),
        ...(inferredValidationFailure
          ? {
              mutationOutcome: "not_applied",
              validationIssueCount: validationMessages.length,
            }
          : {}),
      });
    }
    return body as T;
  }
}

function safeRejectionContext(value: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(
      ([key, candidate]) => SAFE_REJECTION_CONTEXT_KEYS.has(key) && isSafeRejectionValue(candidate),
    ),
  );
}

function isSafeRejectionValue(value: unknown): boolean {
  if (typeof value === "string") return value.length <= 500;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean" || value === null) return true;
  if (Array.isArray(value)) return value.length <= 20 && value.every(isSafeRejectionValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length <= 20 &&
      entries.every(
        ([key, candidate]) =>
          SAFE_REJECTION_CONTEXT_KEYS.has(key) && isSafeRejectionValue(candidate),
      )
    );
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string) {
  return typeof value?.[key] === "string" ? value[key] : undefined;
}

function stringArrayField(value: Record<string, unknown> | undefined, key: string) {
  const candidate = value?.[key];
  return Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
    ? candidate
    : undefined;
}

export type ScryCapabilities = {
  releaseId: string;
  schemaFingerprint: string;
  supportedActions: string[];
  evidenceChannels: string[];
  artifactCapabilities: string[];
  collectorCapabilities: string[];
  adaptiveExecution?: {
    kernel: boolean;
    authoringTurn: boolean;
    modes: Array<"observe" | "transact" | "run">;
  };
  agentDirectedExecution?: {
    livePraxisSession: boolean;
    factualObservation: boolean;
    exactReferenceRequired: boolean;
    durableRunLedger: boolean;
    explicitRunFinalization: boolean;
    automaticProgression: boolean;
    compileCertificationRequired: boolean;
    calibrationRequired: boolean;
  };
  directBrowser?: { enabled: boolean; maxActionsPerTurn: number; sessionIdleTtlMs: number };
  groundingCapabilities?: string[];
  intelligenceCapabilities?: { modelAssistance: boolean; visualGrounding: string };
  missionContext?: { requiredForWrites: boolean; transport: "explicit"; phases: string[] };
  praxis?: {
    contractVersion: number;
    runtimeVersion: string;
    scoringPolicyVersion: number;
    cutoff: boolean;
    evidenceChannels: string[];
    strategies: string[];
    hardBoundaries: string[];
  };
};
