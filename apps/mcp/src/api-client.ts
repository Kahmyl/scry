import { PRAXIS_CONTRACT_VERSION, PRAXIS_RUNTIME_VERSION, PRAXIS_SCORING_POLICY_VERSION } from "@scry/contracts";

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

  capabilities() {
    this.capabilitiesPromise ??= this.get<ScryCapabilities>("/capabilities");
    return this.capabilitiesPromise;
  }

  async requireCurrentRelease() {
    const capabilities = await this.capabilities();
    const expectedRelease = process.env.SCRY_RELEASE_ID;
    const expectedSchema = process.env.SCRY_SCHEMA_FINGERPRINT;
    if ((expectedRelease && capabilities.releaseId !== expectedRelease) || (expectedSchema && capabilities.schemaFingerprint !== expectedSchema)) {
      throw new Error("SCRY_RELEASE_MISMATCH");
    }
    if (!capabilities.praxis
      || capabilities.praxis.contractVersion !== PRAXIS_CONTRACT_VERSION
      || capabilities.praxis.runtimeVersion !== PRAXIS_RUNTIME_VERSION
      || capabilities.praxis.scoringPolicyVersion !== PRAXIS_SCORING_POLICY_VERSION
      || capabilities.praxis.cutoff !== true) {
      throw new Error("SCRY_PRAXIS_VERSION_MISMATCH");
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

export type ScryCapabilities = {
  releaseId: string;
  schemaFingerprint: string;
  supportedActions: string[];
  evidenceChannels: string[];
  artifactCapabilities: string[];
  collectorCapabilities: string[];
  groundingCapabilities?: string[];
  intelligenceCapabilities?: { modelAssistance: boolean; visualGrounding: string };
  missionContext?: { requiredForWrites:boolean;transport:"explicit";phases:string[] };
  praxis?: { contractVersion:number;runtimeVersion:string;scoringPolicyVersion:number;cutoff:boolean;evidenceChannels:string[];strategies:string[];hardBoundaries:string[] };
};
