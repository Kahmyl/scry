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

export type Credential = {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
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

export type Specification = {
  id: string;
  name: string;
  description: string;
  latestVersion?: number;
  latestVersionId?: string;
  latestContent?: {
    objective: string;
    expectedOutcomes: string[];
  };
  latestPlanVersionId?: string;
  latestPlan?: {
    protocolVersion?: "1" | "2";
    name?: string;
    objective?: string;
    steps: Array<{
      id?: string;
      title?: string;
      action?: {
        type?: string;
        url?: string;
        target?: { strategy?: string; role?: string; name?: string; value?: string };
        value?: string;
        secretRef?: string;
      };
      assertions?: Array<{
        type?: string;
        expected?: string;
        match?: string;
        target?: { strategy?: string; role?: string; name?: string; value?: string };
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
  state: RunState;
  planName: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  rerunOfRunId?: string;
  resolvedAt?: string;
  resolvedByRunId?: string;
  needsAttention: boolean;
  outcomeClassification?: OutcomeClassification;
  confirmationOfRunId?: string;
  confirmationRunId?: string;
  environmentSnapshot: { name: string; baseOrigin: string };
  executionSnapshot: {
    browser: string;
    viewport: { width: number; height: number };
    seed: number;
  };
};

export type OutcomeClassification =
  | "passed" | "assertion_failure" | "readiness_timeout" | "transient_observation"
  | "inconclusive_plan" | "confirmed_product_failure" | "non_reproduced_failure"
  | "infrastructure_failure" | "policy_failure" | "execution_timeout" | "cancelled";

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
  events: Array<{
    id: string;
    attemptId: string;
    sequence: number;
    type: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  }>;
  assertions: Array<{
    attemptId: string;
    stepId: string;
    assertionIndex: number;
    assertionType: string;
    status: "passed" | "failed" | "unevaluated";
    error?: string;
  }>;
  artifacts: Array<{
    id: string;
    attemptId: string;
    stepId?: string;
    kind: string;
    status: string;
    contentType: string;
    sizeBytes?: string;
    observation?: Record<string, unknown>;
  }>;
};
