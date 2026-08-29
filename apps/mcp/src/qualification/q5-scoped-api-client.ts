import { ScryApiClient, ScryApiError, type ExternalAgentIdentity } from "../api-client.js";

export type Q5Scope = Readonly<{
  attemptId: string;
  state: string;
  campaignId: string;
  canonicalApplicationId: string;
  applicationIdentity: string;
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  externalRunId: string;
  flowDraftId: string;
  flowRevisionId: string;
  targetOrigin: string;
  allowedOrigins: string[];
  credentialReferenceIds: string[];
  runId: string | null;
  praxisSessionId: string | null;
}>;

const allowedRoutes = [
  ["GET", /^\/capabilities$/],
  ["POST", /^\/projects\/operating-context$/],
  ["GET", /^\/projects\/[^/]+\/environments$/],
  ["GET", /^\/projects\/[^/]+\/credential-candidates(?:\?.*)?$/],
  ["POST", /^\/praxis-sessions$/],
  ["GET", /^\/praxis-sessions\/[^/]+(?:\/observation)?$/],
  [
    "POST",
    /^\/praxis-sessions\/[^/]+\/(?:regions\/inspect|public-values\/read|resources\/inspect|public-resources\/read|structure\/inspect|public-structure-values\/read|runtime-state\/inspect|public-runtime-values\/read|reconcile-unknown|close)$/,
  ],
  ["POST", /^\/projects\/[^/]+\/runs$/],
  ["GET", /^\/runs\/[^/]+$/],
  ["POST", /^\/runs\/[^/]+\/(?:operations|praxis-session|finalize)$/],
  ["POST", /^\/objectives\/[^/]+\/evidence$/],
  ["PATCH", /^\/objectives\/[^/]+$/],
  ["GET", /^\/missions\/[^/]+$/],
  ["GET", /^\/missions\/[^/]+\/report-preview$/],
  ["POST", /^\/missions\/[^/]+\/(?:authorizations|finalize-agent-work|reports)$/],
  ["POST", /^\/agent-sessions\/[^/]+\/end$/],
] as const;

export class Q5ScopedApiClient extends ScryApiClient {
  constructor(
    baseUrl: string,
    serviceToken: string,
    publicBaseUrl: string,
    identity: ExternalAgentIdentity,
    readonly scope: Q5Scope,
    private readonly control: ScryApiClient,
  ) {
    super(baseUrl, serviceToken, publicBaseUrl, identity);
  }

  override async get<T>(path: string): Promise<T> {
    this.assertRequest("GET", path);
    return this.projectResponse(path, await super.get<T>(path));
  }

  override async post<T>(path: string, body: unknown = {}): Promise<T> {
    this.assertRequest("POST", path, body);
    const result = await super.post<T>(path, body);
    await this.bindRuntime(path, result);
    return this.projectResponse(path, result);
  }

  override async patch<T>(path: string, body: unknown): Promise<T> {
    this.assertRequest("PATCH", path, body);
    return this.projectResponse(path, await super.patch<T>(path, body));
  }

  override async delete<T>(_path: string): Promise<T> {
    throw new ScryApiError("Q5_MCP_ROUTE_FORBIDDEN", 403, ["use_q5_profile_tools_only"]);
  }

  private assertRequest(method: string, path: string, body?: unknown) {
    if (
      !allowedRoutes.some(
        ([allowedMethod, pattern]) => allowedMethod === method && pattern.test(path),
      )
    )
      throw new ScryApiError("Q5_MCP_ROUTE_FORBIDDEN", 403, ["use_q5_profile_tools_only"]);
    const exact = {
      projectId: this.scope.projectId,
      environmentId: this.scope.environmentId,
      canonicalApplicationId: this.scope.canonicalApplicationId,
      applicationIdentity: this.scope.applicationIdentity,
      missionId: this.scope.missionId,
      objectiveId: this.scope.objectiveId,
      agentSessionId: this.scope.agentSessionId,
      qualificationCampaignAuthorizationId: this.scope.campaignId,
      campaignId: this.scope.campaignId,
      externalRunId: this.scope.externalRunId,
      flowDraftId: this.scope.flowDraftId,
      flowRevisionId: this.scope.flowRevisionId,
      runId: this.scope.runId,
      praxisSessionId: this.scope.praxisSessionId,
    } as const;
    for (const [key, expected] of Object.entries(exact)) {
      const observed = keyedValues(path, body, key);
      if (observed.some((value) => expected === null || value !== expected))
        throw new ScryApiError("Q5_MCP_SCOPE_MISMATCH", 403, ["use_exact_q5_scope"], {
          capability: key,
        });
    }
    for (const value of keyedValuesForNames(path, body, [
      "credentialReferenceId",
      "protectedReferenceId",
      "initialProtectedReferenceIds",
      "protectedInputReferences",
      "credentialIds",
    ]))
      if (!this.scope.credentialReferenceIds.includes(value))
        throw new ScryApiError("Q5_MCP_SCOPE_MISMATCH", 403, ["use_exact_q5_credentials"], {
          capability: "credentialReference",
        });
    for (const value of originValues(body))
      if (!this.scope.allowedOrigins.includes(value))
        throw new ScryApiError("Q5_MCP_ORIGIN_FORBIDDEN", 403, ["use_exact_q5_origin"]);
    if (path !== "/projects/operating-context")
      assertPathId(path, "/projects/", this.scope.projectId);
    assertPathId(path, "/missions/", this.scope.missionId);
    assertPathId(path, "/objectives/", this.scope.objectiveId);
    assertPathId(path, "/agent-sessions/", this.scope.agentSessionId);
    if (path.includes("/runs/")) assertPathId(path, "/runs/", this.scope.runId);
    if (path.includes("/praxis-sessions/"))
      assertPathId(path, "/praxis-sessions/", this.scope.praxisSessionId);
  }

  private async bindRuntime(path: string, result: unknown) {
    if (path === "/praxis-sessions" && this.scope.praxisSessionId === null) {
      const id = findId(result, ["id", "sessionId"]);
      if (id) {
        await this.control.post(
          `/internal/q5-authoritative-attempts/${this.scope.attemptId}/runtime-bindings`,
          {
            praxisSessionId: id,
          },
        );
        (this.scope as { praxisSessionId: string | null }).praxisSessionId = id;
      }
    }
    if (
      new RegExp(`^/projects/${this.scope.projectId}/runs$`).test(path) &&
      this.scope.runId === null
    ) {
      const id = findId(result, ["id", "runId"]);
      if (id) {
        await this.control.post(
          `/internal/q5-authoritative-attempts/${this.scope.attemptId}/runtime-bindings`,
          {
            runId: id,
          },
        );
        (this.scope as { runId: string | null }).runId = id;
      }
    }
  }

  private projectResponse(path: string, value: unknown): any {
    if (/\/credential-candidates/.test(path) && value && typeof value === "object") {
      const record = value as { items?: Array<{ id?: string; referenceId?: string }> };
      return {
        ...record,
        items: (record.items ?? []).filter((item) =>
          this.scope.credentialReferenceIds.includes(item.referenceId ?? item.id ?? ""),
        ),
        truncated: false,
      };
    }
    if (/^\/projects\/[^/]+\/environments$/.test(path) && value && typeof value === "object") {
      const record = value as {
        items?: Array<{ id?: string }>;
        environments?: Array<{ id?: string }>;
      };
      const filter = (items: Array<{ id?: string }> | undefined) =>
        (items ?? []).filter(({ id }) => id === this.scope.environmentId);
      return {
        ...record,
        ...(Array.isArray(record.items) ? { items: filter(record.items) } : {}),
        ...(Array.isArray(record.environments)
          ? { environments: filter(record.environments) }
          : {}),
      };
    }
    if (path === "/projects/operating-context" && value && typeof value === "object")
      return projectOperatingContext(value as Record<string, unknown>, this.scope);
    return value;
  }
}

function assertPathId(path: string, marker: string, expected: string | null) {
  const value = path.split(marker)[1]?.split(/[/?]/)[0];
  if (value && (!expected || decodeURIComponent(value) !== expected))
    throw new ScryApiError("Q5_MCP_SCOPE_MISMATCH", 403, ["use_exact_q5_scope"]);
}

function keyedValues(path: string, body: unknown, key: string) {
  const values: string[] = [];
  const query = new URL(`http://q5.invalid${path}`).searchParams.get(key);
  if (query) values.push(query);
  const visit = (candidate: unknown, depth: number) => {
    if (!candidate || typeof candidate !== "object" || depth > 5) return;
    if (Array.isArray(candidate)) return candidate.forEach((entry) => visit(entry, depth + 1));
    for (const [name, value] of Object.entries(candidate as Record<string, unknown>)) {
      if (name === key && typeof value === "string") values.push(value);
      else visit(value, depth + 1);
    }
  };
  visit(body, 0);
  return values;
}

function keyedValuesForNames(path: string, body: unknown, names: string[]) {
  const values: string[] = [];
  const admitted = new Set(names);
  const query = new URL(`http://q5.invalid${path}`).searchParams;
  for (const name of names) values.push(...query.getAll(name));
  const visit = (candidate: unknown, depth: number, key = "") => {
    if (candidate === null || candidate === undefined || depth > 6) return;
    if (typeof candidate === "string") {
      if (admitted.has(key)) values.push(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      if (admitted.has(key))
        for (const entry of candidate)
          if (typeof entry === "string") values.push(entry);
          else for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    if (typeof candidate === "object")
      for (const [name, value] of Object.entries(candidate as Record<string, unknown>))
        visit(value, depth + 1, name);
  };
  visit(body, 0);
  return values;
}

function originValues(body: unknown) {
  const values: string[] = [];
  const visit = (candidate: unknown, key = "", depth = 0) => {
    if (depth > 5) return;
    if (Array.isArray(candidate)) return candidate.forEach((entry) => visit(entry, key, depth + 1));
    if (candidate && typeof candidate === "object")
      return Object.entries(candidate as Record<string, unknown>).forEach(([name, value]) =>
        visit(value, name, depth + 1),
      );
    if (typeof candidate === "string" && (key === "url" || key === "allowedOrigins")) {
      try {
        values.push(new URL(candidate).origin);
      } catch {}
    }
  };
  visit(body);
  return values;
}

function findId(value: unknown, names: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const name of names) {
    const candidate = (value as Record<string, unknown>)[name];
    if (typeof candidate === "string") return candidate;
  }
  for (const candidate of Object.values(value as Record<string, unknown>)) {
    const nested = findId(candidate, names);
    if (nested) return nested;
  }
  return undefined;
}

function projectOperatingContext(value: Record<string, unknown>, scope: Q5Scope) {
  const copy = structuredClone(value);
  const filterItems = (candidate: unknown, allowed: Set<string>) => {
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as { items?: Array<Record<string, unknown>>; truncated?: boolean };
    if (Array.isArray(record.items))
      record.items = record.items.filter((item) =>
        [...allowed].includes(String(item.id ?? item.missionId ?? item.objectiveId ?? "")),
      );
    if ("truncated" in record) record.truncated = false;
  };
  const root = copy as Record<string, any>;
  filterItems(root.selection?.projectCandidates, new Set([scope.projectId]));
  filterItems(root.missions?.candidates, new Set([scope.missionId]));
  filterItems(root.credentials, new Set(scope.credentialReferenceIds));
  filterItems(root.environments, new Set([scope.environmentId]));
  return root;
}
