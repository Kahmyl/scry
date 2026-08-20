import { randomUUID } from "node:crypto";

import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";
import { ExecutionKernel, type ExecutionReport } from "@scry/executor";
import { compileDefaultVeilPolicy } from "@scry/veil";
import { describe, expect, it, vi } from "vitest";

import { ExecutionCapabilityFactory } from "../src/runtime/index.js";

const policy = executionPolicySchema.parse({
  allowedOrigins: ["https://example.test"],
  allowPrivateNetwork: false,
});

describe.each([
  { path: "protected Probe", mode: "transact" as const, parent: "probe-attempt" },
  { path: "protected calibration", mode: "certify" as const, parent: "calibration-attempt" },
])("$path kernel composition", ({ mode, parent }) => {
  it("journals protected sub-operation phases under the admitted parent", async () => {
    const admitted = new Set<string>();
    const mutationStates = new Map<string, string>();
    const kernelRepository = {
      begin: vi.fn(async ({ request }: { request: { operationId: string } }) => {
        admitted.add(request.operationId);
      }),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      appendEvent: vi.fn(
        async (
          _sessionId: string,
          operationId: string,
          _phase?: string,
          _facts?: Record<string, unknown>,
        ) => {
          if (!admitted.has(operationId)) throw new Error("EXECUTION_OPERATION_NOT_ADMITTED");
        },
      ),
      persistSecret: vi.fn(),
      persistPublicValue: vi.fn(),
      resolvePublicValue: vi.fn(),
      claimMutation: vi.fn(async (_sessionId: string, input: { operationId: string }) => ({
        state: mutationStates.get(input.operationId) ?? "planned",
        fencingToken: 1,
      })),
      transitionMutation: vi.fn(
        async (
          _sessionId: string,
          input: { operationId: string; expected: string; next: string },
        ) => {
          const current = mutationStates.get(input.operationId) ?? "planned";
          if (current !== input.expected) return false;
          mutationStates.set(input.operationId, input.next);
          return true;
        },
      ),
      recordMutation: vi.fn(
        async (
          _sessionId: string,
          parentOperationId: string,
          input: { operationId: string; phase: string; facts?: Record<string, unknown> },
        ) => {
          if (!admitted.has(parentOperationId)) {
            throw new Error("EXECUTION_OPERATION_NOT_ADMITTED");
          }
          await kernelRepository.appendEvent("session", parentOperationId, input.phase, {
            ...input.facts,
            protectedOperationId: input.operationId,
          });
        },
      ),
      establishCheckpoint: vi.fn(),
      claimCheckpoint: vi.fn(),
      completeCheckpoint: vi.fn(),
      recordContextProvenance: vi.fn(),
    };
    const factory = new ExecutionCapabilityFactory(
      {} as never,
      kernelRepository as never,
      { openBrowser: vi.fn() } as never,
    );
    const correlationId = randomUUID();
    const capabilities = factory.createSession({
      sessionId: "session",
      operationId: parent,
      correlationId,
      mode,
      options: {
        browserChannel: "chromium",
        outputDirectory: "/tmp/protected-kernel-composition",
        environmentId: "protected-kernel-composition",
        veilAdmissionKey: "a".repeat(32),
        veilPolicySnapshot: compileDefaultVeilPolicy(policy),
        protectedTransactionStore: (() => {
          let mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown" =
            "not_attempted";
          return {
            claim: async () => ({
              id: "protected-child-operation",
              state: "planned" as const,
              version: 1,
              fencingToken: 1,
              mutationOutcome,
            }),
            transition: async ({ id, next, version, fencingToken }) => ({
              id,
              state: next,
              version: version + 1,
              fencingToken,
              mutationOutcome,
            }),
            settleMutationOutcome: async ({ id, version, fencingToken, outcome }) => ({
              id,
              state: "reconciling",
              version: version + 1,
              fencingToken,
              mutationOutcome: (mutationOutcome = outcome),
            }),
            record: async (record) => {
              await kernelRepository.recordMutation("session", parent, record);
            },
          };
        })(),
        ...(mode === "certify" ? { calibrationVerifier: vi.fn(async () => true) } : {}),
      },
    });
    const plan = mutatingPlan();
    const request = factory.request({
      sessionId: "session",
      operationId: parent,
      correlationId,
      mode,
      plan,
      policy,
      capabilities,
      idempotencyKey: `${parent}-request`,
      mutationIdentity: `${parent}-mutation`,
    });
    const kernel = new ExecutionKernel(async (options) => {
      await options.protectedTransactionStore?.record({
        operationId: "protected-child-operation",
        fencingToken: 1,
        phase: "mutation_dispatching",
        facts: { channel: mode },
      });
      return report(parent);
    });

    await expect(kernel.execute({ request, capabilities })).resolves.toMatchObject({
      outcome: { functionalResult: "succeeded" },
    });
    expect(kernelRepository.recordMutation).toHaveBeenCalledWith(
      "session",
      parent,
      expect.objectContaining({ operationId: "protected-child-operation" }),
    );
    expect(kernelRepository.appendEvent).toHaveBeenCalledWith(
      "session",
      parent,
      "mutation_dispatching",
      expect.objectContaining({ protectedOperationId: "protected-child-operation" }),
    );
  });
});

function mutatingPlan() {
  return currentPlanSchema.parse({
    name: "Protected composition",
    objective: "Exercise protected journal composition",
    preconditions: [],
    allowedOrigins: ["https://example.test"],
    budgets: { maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 },
    checkpoints: [],
    steps: [
      {
        id: "fill",
        title: "Fill",
        action: {
          type: "fill",
          target: {
            concept: "Name",
            requiredCapabilities: ["accepts_text", "focusable", "editable"],
            preferredEvidence: {
              roles: ["textbox"],
              names: ["Name"],
              labels: ["Name"],
              descriptions: [],
              placeholders: [],
              inputTypes: [],
            },
            scope: { kind: "page" },
            relations: [],
            prohibited: ["hidden", "disabled"],
            risk: "ordinary",
            confidence: { requiredFamilies: [], minimumFamilyCount: 1 },
          },
          value: "public",
        },
        assertions: [],
        onFailure: "stop",
        evidence: [],
        captureIntent: "final",
      },
    ],
  });
}

function report(operationId: string): ExecutionReport {
  const now = new Date().toISOString();
  return {
    runId: "session",
    attemptId: operationId,
    planName: "Protected composition",
    state: "passed",
    outcomeClassification: "passed",
    startedAt: now,
    completedAt: now,
    durationMs: 1,
    requiredAssertions: { passed: 0, failed: 0, unevaluated: 0 },
    artifacts: [],
    steps: [],
    diagnostics: [],
    policyViolations: [],
    artifactTimeline: [],
  };
}
