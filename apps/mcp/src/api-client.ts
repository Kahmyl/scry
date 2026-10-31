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

  async getImage(path: string): Promise<{ type: "image"; data: string; mimeType: string }> {
    // Optional image delivery must not keep a completed browser action waiting
    // indefinitely. The same signal also bounds consumption of a stalled body.
    const response = await this.response(path, { signal: AbortSignal.timeout(10000) });
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType) || !response.body)
      throw new Error("SCRY_BROWSER_IMAGE_INVALID");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024) throw new Error("SCRY_BROWSER_IMAGE_CAPACITY");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return { type: "image", data: Buffer.concat(chunks).toString("base64"), mimeType };
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.response(path, init)).json() as Promise<T>;
  }

  private async response(path: string, init?: RequestInit): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("SCRY_BROWSER_API_PATH_INVALID");
    const headers = new Headers(init?.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    headers.set("x-scry-agent-provider", bounded(this.identity.provider));
    if (this.identity.model) headers.set("x-scry-agent-model", bounded(this.identity.model));
    if (this.identity.externalRunId)
      headers.set("x-scry-external-run-id", bounded(this.identity.externalRunId));
    if (this.identity.experimentId)
      headers.set("x-scry-experiment-id", bounded(this.identity.experimentId));
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      const envelope = record(body);
      const detail = record(envelope?.message) ?? envelope;
      const code =
        stringField(detail, "code") ??
        stringField(envelope, "code") ??
        (typeof envelope?.message === "string" ? envelope.message : `HTTP_${response.status}`);
      const safeActions = stringArrayField(detail, "safeActions") ?? [];
      throw new BrowserApiError(code, response.status, safeActions);
    }
    return response;
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
