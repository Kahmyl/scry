import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  Q5_PREPAID_FREE_PHASES,
  crossPaidQ5Boundary,
  type Q5Gate,
  type Q5PrepaidFreePhase,
} from "../scripts/m6-q5-authoritative-harness.js";

import {
  LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED,
  Q5_CANONICAL_SCOPE,
  Q5_IDENTITY_CLASSES,
  assertPreparedScopeValid,
  bootstrapQ5CanonicalScope,
  type Q5CanonicalEnvironment,
  type Q5CanonicalProject,
  type Q5CredentialPair,
  type Q5PreparedScope,
  type Q5ScopeBootstrapStore,
} from "../src/runtime/q5-scope-bootstrap.js";

const facts = {
  sourceCommit: "a".repeat(40),
  sourceManifest: "b".repeat(64),
  schemaFingerprint: "c".repeat(64),
  migrationIdentity: "d".repeat(64),
};

describe("Q5 canonical scope bootstrap", () => {
  it("classifies stable, provisioned, and attempt identities explicitly", () => {
    expect(Q5_IDENTITY_CLASSES.stableCanonical).toContain("applicationIdentity");
    expect(Q5_IDENTITY_CLASSES.provisionedInstance).toEqual(
      expect.arrayContaining(["projectId", "environmentId", "issuanceOperationId"]),
    );
    expect(Q5_IDENTITY_CLASSES.attempt).toEqual(
      expect.arrayContaining(["authoritativeAttemptId", "missionId", "runId"]),
    );
  });

  it("bootstraps an empty canonical store with generated identities and no paid attempt", async () => {
    const store = memoryStore({ project: null, environment: null, pairs: [] });
    const result = await bootstrapQ5CanonicalScope(store, facts);
    expect(result).toMatchObject({
      status: "credential_issuance_required",
      code: LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED,
      paidAttemptCreated: false,
    });
    if (result.status !== "credential_issuance_required") throw new Error("expected blocker");
    expect(result.projectId).not.toBe("6b3b5011-0f41-430c-a8a2-d4abfd9ff3f1");
    expect(result.environmentId).not.toBe("9a581bb0-2276-4888-9ddb-07b2485cddc3");
    expect(store.createCanonicalProject).toHaveBeenCalledOnce();
    expect(store.createCanonicalEnvironment).toHaveBeenCalledOnce();
    expect(store.freezePreparedScope).not.toHaveBeenCalled();
  });

  it("resolves an existing canonical scope without duplicating it", async () => {
    const project = canonicalProject();
    const environment = canonicalEnvironment(project.id);
    const store = memoryStore({ project, environment, pairs: [] });
    await bootstrapQ5CanonicalScope(store, facts);
    expect(store.createCanonicalProject).not.toHaveBeenCalled();
    expect(store.createCanonicalEnvironment).not.toHaveBeenCalled();
  });

  it("fails closed for ambiguous Projects and wrong canonical application/environment", async () => {
    const project = canonicalProject();
    const ambiguous = memoryStore({
      project,
      environment: canonicalEnvironment(project.id),
      pairs: [],
    });
    vi.mocked(ambiguous.findCanonicalProjects).mockResolvedValue([project, canonicalProject()]);
    await expect(bootstrapQ5CanonicalScope(ambiguous, facts)).rejects.toThrow(
      "Q5_CANONICAL_PROJECT_AMBIGUOUS",
    );
    const wrong = memoryStore({
      project,
      environment: { ...canonicalEnvironment(project.id), applicationIdentity: "caller-label" },
      pairs: [],
    });
    await expect(bootstrapQ5CanonicalScope(wrong, facts)).rejects.toThrow(
      "Q5_CANONICAL_APPLICATION_ENVIRONMENT_MISMATCH",
    );
  });

  it("freezes a supported generated issuance result without assuming its UUIDs", async () => {
    const project = canonicalProject();
    const environment = canonicalEnvironment(project.id);
    const pair = eligiblePair(project.id, environment.id);
    const store = memoryStore({ project, environment, pairs: [pair] });
    const result = await bootstrapQ5CanonicalScope(store, facts);
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("expected prepared scope");
    expect(result.scope).toMatchObject({
      projectId: project.id,
      environmentId: environment.id,
      issuanceOperationId: pair.issuanceOperationId,
      credentialPairReferenceId: pair.pairReferenceId,
      credentialProvenance: "supported_protected_issuance",
      state: "prepared",
    });
    expect(result.scope.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["revoked", { revoked: true }],
    ["expired", { expiresAt: "2020-01-01T00:00:00.000Z" }],
    ["wrong scope", { projectId: randomUUID() }],
    [
      "fabricated provenance",
      {
        provenance: "supported_protected_issuance",
        issuanceState: "completed",
        persistenceState: "committed",
        atomic: false,
      },
    ],
  ] as const)("rejects %s credentials and requires supported issuance", async (_name, mutation) => {
    const project = canonicalProject();
    const environment = canonicalEnvironment(project.id);
    const pair = { ...eligiblePair(project.id, environment.id), ...mutation } as Q5CredentialPair;
    const result = await bootstrapQ5CanonicalScope(
      memoryStore({ project, environment, pairs: [pair] }),
      facts,
      new Date("2026-08-29T00:00:00.000Z"),
    );
    expect(result).toMatchObject({
      status: "credential_issuance_required",
      code: LIVE_Q5_CREDENTIAL_ISSUANCE_REQUIRED,
      paidAttemptCreated: false,
    });
  });

  it("invalidates prepared scope mutation and source/schema/credential changes", async () => {
    const project = canonicalProject();
    const environment = canonicalEnvironment(project.id);
    const pair = eligiblePair(project.id, environment.id);
    const result = await bootstrapQ5CanonicalScope(
      memoryStore({ project, environment, pairs: [pair] }),
      facts,
    );
    if (result.status !== "prepared") throw new Error("expected prepared scope");
    expect(() => assertPreparedScopeValid(result.scope, facts, pair)).not.toThrow();
    expect(() =>
      assertPreparedScopeValid(result.scope, { ...facts, sourceManifest: "e".repeat(64) }, pair),
    ).toThrow("Q5_PREPARED_SCOPE_SOURCE_RUNTIME_CHANGED");
    expect(() =>
      assertPreparedScopeValid({ ...result.scope, projectId: randomUUID() }, facts, pair),
    ).toThrow();
    expect(() => assertPreparedScopeValid(result.scope, facts, { ...pair, revoked: true })).toThrow(
      "Q5_PREPARED_SCOPE_CREDENTIAL_INVALID",
    );
  });

  it("serializes concurrent bootstrap through the canonical store lock", async () => {
    const store = memoryStore({ project: null, environment: null, pairs: [] });
    await Promise.all([
      bootstrapQ5CanonicalScope(store, facts),
      bootstrapQ5CanonicalScope(store, facts),
    ]);
    expect(store.createCanonicalProject).toHaveBeenCalledOnce();
    expect(store.createCanonicalEnvironment).toHaveBeenCalledOnce();
  });

  it("drives the deterministic fake-agent boundary from bootstrap output before one mock consumption", async () => {
    const project = canonicalProject();
    const environment = canonicalEnvironment(project.id);
    const pair = eligiblePair(project.id, environment.id);
    const bootstrap = await bootstrapQ5CanonicalScope(
      memoryStore({ project, environment, pairs: [pair] }),
      facts,
    );
    if (bootstrap.status !== "prepared") throw new Error("expected prepared scope");
    const order: string[] = [`bootstrap:${bootstrap.scope.id}`];
    const gates = Object.fromEntries(
      Q5_PREPAID_FREE_PHASES.map((phase) => [
        phase,
        async () => (order.push(phase), { pass: true }),
      ]),
    ) as unknown as Record<Q5PrepaidFreePhase, Q5Gate>;
    const result = await crossPaidQ5Boundary({
      gates,
      consumeAttempt: async () => {
        order.push(`consume:${bootstrap.scope.id}`);
        return { attemptId: randomUUID(), state: "consumed" };
      },
      constructProviderAfterConsumption: async () => {
        order.push("fake-agent:30-tool-mcp:create:exact-retrieve:evidence:finalize");
        return { calls: 1, protectedAuthentication: true, mutations: 1, exactRetrieval: true };
      },
    });
    expect(order).toEqual([
      `bootstrap:${bootstrap.scope.id}`,
      ...Q5_PREPAID_FREE_PHASES,
      `consume:${bootstrap.scope.id}`,
      "fake-agent:30-tool-mcp:create:exact-retrieve:evidence:finalize",
    ]);
    expect(result.provider).toEqual({
      calls: 1,
      protectedAuthentication: true,
      mutations: 1,
      exactRetrieval: true,
    });
  });
});

function canonicalProject(): Q5CanonicalProject {
  return { id: randomUUID(), designation: Q5_CANONICAL_SCOPE.qualificationKey };
}

function canonicalEnvironment(projectId: string): Q5CanonicalEnvironment {
  return {
    id: randomUUID(),
    projectId,
    applicationIdentity: Q5_CANONICAL_SCOPE.applicationIdentity,
    environmentClass: Q5_CANONICAL_SCOPE.environmentClass,
    baseOrigin: Q5_CANONICAL_SCOPE.targetOrigin,
    allowedOrigins: Q5_CANONICAL_SCOPE.allowedOrigins,
    protectedPolicy: Q5_CANONICAL_SCOPE.protectedPolicy,
    qualificationCompatible: true,
  };
}

function eligiblePair(projectId: string, environmentId: string): Q5CredentialPair {
  return {
    pairReferenceId: randomUUID(),
    projectId,
    environmentId,
    applicationIdentity: Q5_CANONICAL_SCOPE.applicationIdentity,
    issuanceOperationId: randomUUID(),
    clientIdReferenceId: randomUUID(),
    clientSecretReferenceId: randomUUID(),
    credentialType: Q5_CANONICAL_SCOPE.credentialType,
    protectedPolicy: Q5_CANONICAL_SCOPE.protectedPolicy,
    provenance: "supported_protected_issuance",
    issuanceState: "completed",
    persistenceState: "committed",
    atomic: true,
    active: true,
    revoked: false,
    expiresAt: null,
  };
}

function memoryStore(input: {
  project: Q5CanonicalProject | null;
  environment: Q5CanonicalEnvironment | null;
  pairs: Q5CredentialPair[];
}): Q5ScopeBootstrapStore {
  let project = input.project;
  let environment = input.environment;
  let queue = Promise.resolve();
  const exclusively = async <T>(_key: string, operation: () => Promise<T>) => {
    const prior = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => (release = resolve));
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  return {
    exclusively: vi.fn(exclusively) as Q5ScopeBootstrapStore["exclusively"],
    findCanonicalProjects: vi.fn(async () => (project ? [project] : [])),
    createCanonicalProject: vi.fn(async (designation) => {
      project = { id: randomUUID(), designation };
      return project;
    }),
    findCanonicalEnvironments: vi.fn(async () => (environment ? [environment] : [])),
    createCanonicalEnvironment: vi.fn(async (projectId) => {
      environment = canonicalEnvironment(projectId);
      return environment;
    }),
    findCredentialPairs: vi.fn(async () => input.pairs),
    freezePreparedScope: vi.fn(
      async (scope) =>
        ({
          ...scope,
          id: randomUUID(),
          state: "prepared",
        }) as Q5PreparedScope,
    ),
  };
}
