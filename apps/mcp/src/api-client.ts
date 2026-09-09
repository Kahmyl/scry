export type BrowserAgentIdentity = Readonly<{
  provider: string;
  model?: string;
  externalRunId?: string;
  experimentId?: string;
}>;

export class BrowserApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly safeActions: string[] = [],
  ) {
    super(`Browser API request rejected: ${JSON.stringify({ code, status, safeActions })}`);
    this.name = "BrowserApiError";
  }
}

export class BrowserApiClient {
  constructor(
    readonly baseUrl = process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/api",
    readonly token = process.env.SCRY_SERVICE_TOKEN,
    readonly identity: BrowserAgentIdentity = {
      provider: process.env.SCRY_EXTERNAL_AGENT_PROVIDER ?? "unknown",
      ...(process.env.SCRY_EXTERNAL_AGENT_MODEL
        ? { model: process.env.SCRY_EXTERNAL_AGENT_MODEL }
        : {}),
      ...(process.env.SCRY_EXTERNAL_AGENT_RUN_ID
        ? { externalRunId: process.env.SCRY_EXTERNAL_AGENT_RUN_ID }
        : {}),
      ...(process.env.SCRY_EXTERNAL_AGENT_EXPERIMENT_ID
        ? { experimentId: process.env.SCRY_EXTERNAL_AGENT_EXPERIMENT_ID }
        : {}),
    },
  ) {}

  get<T>(path: string): Promise<T> {
    return this.request(path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    headers.set("x-scry-agent-provider", bounded(this.identity.provider));
    if (this.identity.model) headers.set("x-scry-agent-model", bounded(this.identity.model));
    if (this.identity.externalRunId)
      headers.set("x-scry-external-run-id", bounded(this.identity.externalRunId));
    if (this.identity.experimentId)
      headers.set("x-scry-experiment-id", bounded(this.identity.experimentId));
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = record(body);
      const detail = record(envelope?.message) ?? envelope;
      const code =
        stringField(detail, "code") ??
        stringField(envelope, "code") ??
        (typeof envelope?.message === "string" ? envelope.message : `HTTP_${response.status}`);
      const safeActions = stringArrayField(detail, "safeActions") ?? [];
      throw new BrowserApiError(code, response.status, safeActions);
    }
    return body as T;
  }
}

function bounded(value: string): string {
  return value.slice(0, 200).replace(/[\r\n]/gu, "");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string) {
  return typeof value?.[key] === "string" ? value[key] : undefined;
}

function stringArrayField(value: Record<string, unknown> | undefined, key: string) {
  const candidate = value?.[key];
  return Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
    ? candidate.slice(0, 20)
    : undefined;
}
