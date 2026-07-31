export class ScryApiClient {
  constructor(
    readonly baseUrl = process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/v1",
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
      const detail = body && typeof body === "object"
        ? (Object.keys(body).length === 1 && "message" in body
          ? String(body.message)
          : JSON.stringify(body))
        : `HTTP ${response.status}`;
      throw new Error(`Scry API request failed: ${detail}`);
    }
    return body as T;
  }
}
