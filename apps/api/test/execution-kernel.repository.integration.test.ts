import { randomUUID } from "node:crypto";

import type { ExecutionRequest } from "@scry/contracts";
import { createExecutionCapabilityManifest, ExecutionKernel } from "@scry/executor";
import type { ExecutionReport } from "@scry/executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Database } from "../src/infrastructure/index.js";
import { ExecutionKernelRepository } from "../src/runtime/index.js";

const configuredDatabaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const integration = configuredDatabaseUrl ? describe : describe.skip;

integration("execution kernel repository integration", () => {
  let database: Database;
  let repository: ExecutionKernelRepository;

  beforeAll(() => {
    process.env.DATABASE_URL = configuredDatabaseUrl;
    database = new Database();
    repository = new ExecutionKernelRepository(database);
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  it("runs against the explicitly configured authoring integration database", () => {
    expect(configuredDatabaseUrl).toBeTruthy();
    expect(process.env.DATABASE_URL).toBe(configuredDatabaseUrl);
  });

  it("admits one operation owner and rejects re-entry or identity drift", async () => {
    const request = executionRequest();
    await repository.begin({ request, startedAt: new Date().toISOString() });
    await expect(
      repository.begin({ request, startedAt: new Date().toISOString() }),
    ).rejects.toThrow("EXECUTION_OPERATION_ALREADY_ADMITTED");
    await expect(
      repository.begin({
        request: { ...request, correlationId: randomUUID() },
        startedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("EXECUTION_OPERATION_IDEMPOTENCY_CONFLICT");
    await repository.complete({
      request,
      completedAt: new Date().toISOString(),
      outcome: {
        operationId: request.operationId,
        functionalResult: "succeeded",
        mutationOutcome: "not_applied",
        privacyResult: "verified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
      },
    });
    await expect(
      repository.begin({ request, startedAt: new Date().toISOString() }),
    ).rejects.toThrow("EXECUTION_OPERATION_ALREADY_TERMINAL");
    await expect(
      repository.appendEvent(request.sessionId, request.operationId, "late.event"),
    ).rejects.toThrow("EXECUTION_OPERATION_NOT_ADMITTED");
    await expect(
      database.query(
        `DELETE FROM execution_kernel_operations WHERE session_id=$1 AND operation_id=$2`,
        [request.sessionId, request.operationId],
      ),
    ).rejects.toThrow("Execution kernel operations are append-only");
  });

  it("serializes concurrent event sequence allocation", async () => {
    const request = executionRequest(randomUUID(), "concurrent-events");
    await repository.begin({ request, startedAt: new Date().toISOString() });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.appendEvent(request.sessionId, request.operationId, "test.event", { index }),
      ),
    );
    const events = await database.query<{ sequence: number }>(
      `SELECT sequence FROM execution_kernel_events
       WHERE session_id=$1 AND operation_id=$2 ORDER BY sequence`,
      [request.sessionId, request.operationId],
    );
    expect(events.rows.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("persists protected mutation fencing and encrypted captured values", async () => {
    const sessionId = randomUUID();
    const operationId = "protected-operation";
    const digest = "a".repeat(64);
    await repository.begin({
      request: executionRequest(sessionId, operationId),
      startedAt: new Date().toISOString(),
    });
    const claim = await repository.claimMutation(sessionId, {
      operationId,
      mutationKind: "one_time",
      programDigest: digest,
      inputSchemaDigest: digest,
      inputDigest: digest,
    });
    expect(claim).toEqual({ state: "planned", fencingToken: 1 });
    await expect(
      repository.transitionMutation(sessionId, {
        operationId,
        fencingToken: 1,
        expected: "planned",
        next: "dispatch_authorized",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.transitionMutation(sessionId, {
        operationId,
        fencingToken: 1,
        expected: "planned",
        next: "dispatching",
      }),
    ).resolves.toBe(false);

    const protectedValue = `integration-${randomUUID()}`;
    const captured = await repository.persistSecret(sessionId, {
      operationId,
      reference: "captured-secret",
      name: "Captured secret",
      value: protectedValue,
      scope: "run",
    });
    expect(captured.credentialId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(repository.resolveSecret(sessionId, "captured-secret")).resolves.toBe(
      protectedValue,
    );
    await repository.recordMutation(sessionId, operationId, {
      operationId: "protected-child-operation",
      phase: "mutation_dispatching",
      facts: { safe: true },
    });
    const childEvent = await database.query<{ safeFacts: Record<string, unknown> }>(
      `SELECT safe_facts AS "safeFacts" FROM execution_kernel_events
       WHERE session_id=$1 AND operation_id=$2 AND phase='mutation_dispatching'`,
      [sessionId, operationId],
    );
    expect(childEvent.rows[0]?.safeFacts).toMatchObject({
      protectedOperationId: "protected-child-operation",
    });

    const request = executionRequest(sessionId, operationId);
    await repository.complete({
      request,
      completedAt: new Date().toISOString(),
      outcome: {
        operationId,
        functionalResult: "succeeded",
        mutationOutcome: "applied",
        privacyResult: "verified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
      },
    });
    await expect(repository.resolveSecret(sessionId, "captured-secret")).resolves.toBeUndefined();
  });

  it("keeps terminal journal and mutation settlement atomic when operation persistence fails", async () => {
    const sessionId = randomUUID();
    const mutationIdentity = "atomic-mutation";
    const digest = "c".repeat(64);
    const claim = await repository.claimMutation(sessionId, {
      operationId: mutationIdentity,
      mutationKind: "one_time",
      programDigest: digest,
      inputSchemaDigest: digest,
      inputDigest: digest,
    });
    await repository.transitionMutation(sessionId, {
      operationId: mutationIdentity,
      fencingToken: claim.fencingToken,
      expected: "planned",
      next: "dispatching",
    });
    const request = executionRequest(sessionId, "operation-that-was-never-admitted");
    await expect(
      repository.settle({
        request,
        state: "completed",
        completedAt: new Date().toISOString(),
        outcome: successfulOutcome(request.operationId, "applied"),
        mutation: {
          mutationIdentity,
          fencingToken: claim.fencingToken,
          expected: "dispatching",
          next: "reconciled_succeeded",
        },
      }),
    ).rejects.toThrow("EXECUTION_OPERATION_CLAIM_FENCED");
    const mutation = await database.query<{ state: string }>(
      `SELECT state FROM execution_kernel_mutations WHERE session_id=$1 AND operation_id=$2`,
      [sessionId, mutationIdentity],
    );
    expect(mutation.rows[0]?.state).toBe("dispatching");
  });

  it("allows a real kernel retry only after a proven pre-dispatch target change", async () => {
    const sessionId = randomUUID();
    const correlationId = randomUUID();
    const mutationIdentity = "stable-pre-dispatch-mutation";
    const manifest = createExecutionCapabilityManifest({ mode: "run", correlationId });
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("PRAXIS_TARGET_CHANGED_BEFORE_ACTION"))
      .mockResolvedValueOnce(passedReport());
    const kernel = new ExecutionKernel(dispatch as never);
    const capabilities = {
      manifest,
      journal: {
        begin: (input: Parameters<ExecutionKernelRepository["begin"]>[0]) =>
          repository.begin(input),
        complete: (input: Parameters<ExecutionKernelRepository["complete"]>[0]) =>
          repository.complete(input),
        fail: (input: Parameters<ExecutionKernelRepository["fail"]>[0]) => repository.fail(input),
        settle: (input: Parameters<ExecutionKernelRepository["settle"]>[0]) =>
          repository.settle(input),
      },
      mutationFence: {
        claim: ({
          mutationIdentity: identity,
          requestDigest,
        }: {
          mutationIdentity: string;
          requestDigest: string;
        }) =>
          repository.claimMutation(sessionId, {
            operationId: identity,
            mutationKind: "one_time",
            programDigest: requestDigest,
            inputSchemaDigest: requestDigest,
            inputDigest: requestDigest,
          }),
        transition: ({
          mutationIdentity: identity,
          ...transition
        }: {
          mutationIdentity: string;
          fencingToken: number;
          expected: string;
          next: string;
        }) => repository.transitionMutation(sessionId, { operationId: identity, ...transition }),
      },
      options: { outputDirectory: "/tmp/unused" },
    };
    const first = mutatingExecutionRequest({
      sessionId,
      operationId: "pre-dispatch-attempt-1",
      correlationId,
      mutationIdentity,
      manifestDigest: manifest.digest,
    });
    await expect(kernel.execute({ request: first, capabilities })).rejects.toThrow(
      "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
    );
    const second = mutatingExecutionRequest({
      sessionId,
      operationId: "pre-dispatch-attempt-2",
      correlationId,
      mutationIdentity,
      manifestDigest: manifest.digest,
    });
    await expect(kernel.execute({ request: second, capabilities })).resolves.toMatchObject({
      outcome: { mutationOutcome: "not_applied" },
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const operations = await database.query<{ operationId: string }>(
      `SELECT operation_id AS "operationId" FROM execution_kernel_operations
       WHERE session_id=$1 ORDER BY started_at`,
      [sessionId],
    );
    expect(operations.rows.map((row) => row.operationId)).toEqual([
      "pre-dispatch-attempt-1",
      "pre-dispatch-attempt-2",
    ]);
  });

  it("cleans run-scoped values by owning operation and sweeps crash leftovers", async () => {
    const sessionId = randomUUID();
    const first = executionRequest(sessionId, "value-owner-1");
    const second = executionRequest(sessionId, "value-owner-2");
    await repository.begin({ request: first, startedAt: new Date().toISOString() });
    await repository.begin({ request: second, startedAt: new Date().toISOString() });
    await repository.persistSecret(sessionId, {
      operationId: first.operationId,
      reference: "owner-1-secret",
      name: "Owner 1 secret",
      value: "owner-1-protected",
      scope: "run",
    });
    await repository.persistPublicValue(sessionId, {
      operationId: first.operationId,
      reference: "owner-1-public",
      name: "Owner 1 public",
      value: "owner-1-value",
      scope: "run",
    });
    await repository.persistSecret(sessionId, {
      operationId: second.operationId,
      reference: "owner-2-secret",
      name: "Owner 2 secret",
      value: "owner-2-protected",
      scope: "run",
    });
    await repository.persistPublicValue(sessionId, {
      operationId: second.operationId,
      reference: "owner-2-public",
      name: "Owner 2 public",
      value: "owner-2-value",
      scope: "run",
    });
    await repository.complete({
      request: first,
      completedAt: new Date().toISOString(),
      outcome: successfulOutcome(first.operationId, "not_applied"),
    });
    await expect(repository.resolveSecret(sessionId, "owner-1-secret")).resolves.toBeUndefined();
    await expect(
      repository.resolvePublicValue(sessionId, "owner-1-public"),
    ).resolves.toBeUndefined();
    await expect(repository.resolveSecret(sessionId, "owner-2-secret")).resolves.toBe(
      "owner-2-protected",
    );
    await expect(repository.resolvePublicValue(sessionId, "owner-2-public")).resolves.toBe(
      "owner-2-value",
    );
    const retention = await database.query<{ secretRetention: Date; publicRetention: Date }>(
      `SELECT secret.retention_until AS "secretRetention",
              public.retention_until AS "publicRetention"
       FROM execution_kernel_secret_values secret
       JOIN execution_kernel_public_values public
         ON public.session_id=secret.session_id AND public.operation_id=secret.operation_id
       WHERE secret.session_id=$1 AND secret.operation_id=$2`,
      [sessionId, second.operationId],
    );
    expect(retention.rows[0]?.secretRetention).toBeInstanceOf(Date);
    expect(retention.rows[0]?.publicRetention).toBeInstanceOf(Date);
    await expect(
      repository.purgeExpiredValues(new Date(Date.now() + 25 * 60 * 60 * 1_000)),
    ).resolves.toBe(2);
    await expect(repository.resolveSecret(sessionId, "owner-2-secret")).resolves.toBeUndefined();
    await expect(
      repository.resolvePublicValue(sessionId, "owner-2-public"),
    ).resolves.toBeUndefined();
  });
});

function successfulOutcome(
  operationId: string,
  mutationOutcome: "not_applied" | "applied" | "unknown",
) {
  return {
    operationId,
    functionalResult: "succeeded" as const,
    mutationOutcome,
    privacyResult: "unverified" as const,
    evidenceResult: [],
    qualityFindings: [],
    durationMs: 1,
  };
}

function mutatingExecutionRequest(input: {
  sessionId: string;
  operationId: string;
  correlationId: string;
  mutationIdentity: string;
  manifestDigest: string;
}): ExecutionRequest {
  return {
    ...executionRequest(input.sessionId, input.operationId),
    correlationId: input.correlationId,
    capabilityManifestDigest: input.manifestDigest,
    idempotencyKey: `${input.operationId}-idempotency`,
    mutationIdentity: input.mutationIdentity,
    plan: {
      name: "Pre-dispatch retry",
      objective: "Retry only a proven non-dispatch",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: { maxActions: 1, maxDurationMs: 1_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "press",
          title: "Press Enter",
          action: { type: "press", key: "Enter" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    },
  };
}

function passedReport(): ExecutionReport {
  const now = new Date().toISOString();
  return {
    runId: "integration-run",
    attemptId: "integration-attempt",
    planName: "Pre-dispatch retry",
    state: "passed",
    outcomeClassification: "passed",
    startedAt: now,
    completedAt: now,
    durationMs: 1,
    requiredAssertions: { passed: 0, failed: 0, unevaluated: 0 },
    diagnostics: [],
    policyViolations: [],
    steps: [],
    artifacts: [],
    artifactTimeline: [],
  };
}

function executionRequest(
  sessionId: string = randomUUID(),
  operationId: string = "integration-operation",
): ExecutionRequest {
  return {
    sessionId,
    operationId,
    correlationId: randomUUID(),
    mode: "run",
    plan: {
      name: "Integration",
      objective: "Journal operation",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: { maxActions: 1, maxDurationMs: 1_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "navigate",
          title: "Navigate",
          action: { type: "navigate", url: "https://example.test" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    },
    policy: {
      allowedOrigins: ["https://example.test"],
      allowPrivateNetwork: false,
      allowDownloads: false,
      allowPopups: false,
      maxActions: 1,
      maxDurationMs: 1_000,
      maxNavigations: 1,
    },
    capabilityManifestDigest: "b".repeat(64),
    idempotencyKey: `integration-${sessionId}-${operationId}`.slice(0, 200),
  };
}
