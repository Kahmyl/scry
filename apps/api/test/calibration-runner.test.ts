import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  executePlan,
  protectedTransactionDigest,
  transactionInputDigest,
  transactionInputSchemaDigest,
} from "@scry/executor";
import type { ProtectedTransaction } from "@scry/contracts";

import { runCalibrationAttestation } from "../src/calibration/index.js";
import type { CalibrationRuntime } from "../src/calibration/index.js";
import {
  ProtectedTransactionKernel,
  type MutationLedgerState,
} from "../src/runtime/protected-transactions/protected-transaction-coordinator.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const intent = (
  concept: string,
  role: "button" | "text" | "value" = "text",
): import("@scry/contracts").InteractionTargetIntent => ({
  concept,
  requiredCapabilities: role === "button" ? ["pointer_activatable"] : ["readable_value"],
  preferredEvidence: {
    roles: [role],
    names: [concept],
    labels: [],
    descriptions: [],
    placeholders: [],
    inputTypes: [],
  },
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "ordinary",
  confidence: { requiredFamilies: [], minimum: 0.45, minimumMargin: 0, minimumFamilyCount: 1 },
});
const acquisition = (concept: string) => ({
  target: intent(concept, "value"),
  classification: "unknown_secret" as const,
  permittedMethods: ["semantic_field_value" as const],
  validation: { minimumLength: 1, maximumLength: 100 },
});
const readiness = (ceremony: string, value: string) => ({
  ceremonyIntent: intent(ceremony, "button"),
  expectedContainerModel: {
    version: 2 as const,
    digest: "a".repeat(64),
    concept: ceremony,
    scopeKind: "page" as const,
    capabilityDigest: "b".repeat(64),
    structuralPath: [],
  },
  valueIntent: intent(value, "value"),
  approvedMethods: ["semantic_field_value" as const],
  minimumConfidence: 0.45,
  minimumConfidenceMargin: 0,
  recoveryPolicy: "abandon" as const,
  recoveryWindowMs: 1_000,
});
afterEach(async () =>
  Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  ),
);

describe("worker calibration attestation", () => {
  it("executes a disposable protected mutation once and produces privacy proof", async () => {
    let mutations = 0;
    let postTargetActions = 0;
    const secret = "calibration-canary-value";
    const server = createServer((request, response) => {
      if (request.url === "/mutate") {
        mutations += 1;
        response.end(secret);
        return;
      }
      if (request.url === "/after") {
        postTargetActions += 1;
        response.end("after");
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        `<button data-testid="reveal" onclick="fetch('/mutate').then(response=>response.text()).then(value=>document.querySelector('[data-testid=secret]').textContent=value)">Reveal</button><div><div>Client secret</div><output aria-label="Client secret" data-testid="secret"></output></div><button data-testid="close" onclick="location.href='/safe'">Close</button>`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const action: ProtectedTransaction = {
      type: "protectedTransaction",
      operationId: "generate-secret",
      entry: { url: origin, assertions: [{ type: "visible", target: intent("Reveal", "button") }] },
      inputs: {},
      preparation: {
        effectPolicy: { ignoredRequests: [] },
        actions: [
          {
            type: "assertion",
            assertion: { type: "visible", target: intent("Reveal", "button") },
            effect: "read_only",
          },
        ],
        assertions: [{ type: "visible", target: intent("Reveal", "button") }],
      },
      mutation: {
        action: {
          type: "click",
          target: intent("Reveal", "button"),
          expectedEffect: { type: "new_region", target: intent("Client secret", "value") },
        },
        kind: "one_time",
        reconciliation: { strategy: "none", acceptUnknownOutcome: true },
      },
      extraction: {
        outputs: [
          {
            classification: "protected",
            reference: "generated-secret",
            acquisition: acquisition("Client secret"),
            storage: { credentialName: "Generated secret", scope: "run" },
          },
        ],
        timeoutMs: 2_000,
        scheduling: "fair_shared_timeout",
      },
      acquisitionReadiness: readiness("Reveal", "Client secret"),
      continuation: {
        strategies: [
          {
            mode: "resume_parked_context",
            reentryUrl: `${origin}/safe`,
            assertions: [{ type: "url", expected: "/safe", match: "path" }],
            continueAtStepId: "after",
          },
        ],
      },
    };
    const runtime: CalibrationRuntime = {
      sessionId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      claimToken: crypto.randomUUID(),
      contractRevisionId: crypto.randomUUID(),
      operationDigest: protectedTransactionDigest(action, [origin]),
      inputSchemaDigest: transactionInputSchemaDigest(action),
      inputDigest: transactionInputDigest(action),
      operationId: action.operationId,
      operation: action,
      environmentId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      policy: {
        allowedOrigins: [origin],
        allowPrivateNetwork: true,
        allowDownloads: false,
        allowPopups: false,
        maxActions: 10,
        maxDurationMs: 10_000,
        maxNavigations: 2,
      },
      plan: {
        name: "Calibration",
        objective: "Attest protected operation",
        preconditions: [],
        allowedOrigins: [origin],
        budgets: { maxActions: 10, maxDurationMs: 10_000, maxNavigations: 2 },
        checkpoints: [],
        steps: [
          {
            id: "open",
            title: "Open",
            action: { type: "navigate", url: origin },
            assertions: [],
            onFailure: "stop",
            evidence: [],
            captureIntent: "final",
          },
          {
            id: "protect",
            title: "Generate",
            action,
            assertions: [],
            onFailure: "stop",
            evidence: [],
            captureIntent: "final",
          },
          {
            id: "after",
            title: "Must not run during calibration",
            action: { type: "navigate", url: `${origin}/after` },
            assertions: [],
            onFailure: "stop",
            evidence: [],
            captureIntent: "final",
          },
        ],
      },
    };
    const mutationStates: string[] = [];
    const result = await runCalibrationAttestation(
      runtime,
      process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      undefined,
      async (state) => {
        mutationStates.push(state);
        return true;
      },
      undefined,
      undefined,
      calibrationExecutor(),
    );
    expect(result.passed, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({
      mutationCount: 1,
      privacyVerified: true,
      canaryScanPassed: true,
      diagnostics: { code: "CALIBRATION_ATTESTED" },
    });
    expect(mutations).toBe(1);
    expect(postTargetActions).toBe(0);
    expect(mutationStates).toEqual(["started", "completed"]);
  }, 30_000);

  it("preserves the safe failing preflight step instead of collapsing it to boundary not reached", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<main>ready</main>");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const action: ProtectedTransaction = {
      type: "protectedTransaction",
      operationId: "never-reached",
      entry: { url: origin, assertions: [{ type: "visible", target: intent("ready") }] },
      inputs: {},
      preparation: {
        effectPolicy: { ignoredRequests: [] },
        actions: [
          {
            type: "assertion",
            assertion: { type: "visible", target: intent("ready") },
            effect: "read_only",
          },
        ],
        assertions: [{ type: "visible", target: intent("ready") }],
      },
      mutation: {
        action: {
          type: "click",
          target: intent("Reveal", "button"),
          expectedEffect: { type: "none" },
        },
        kind: "one_time",
        reconciliation: { strategy: "none", acceptUnknownOutcome: true },
      },
      extraction: {
        outputs: [
          {
            classification: "protected",
            reference: "secret",
            acquisition: acquisition("Secret"),
            storage: { credentialName: "Secret", scope: "run" },
          },
        ],
        timeoutMs: 100,
        scheduling: "fair_shared_timeout",
      },
      acquisitionReadiness: readiness("Reveal", "Secret"),
      continuation: { strategies: [{ mode: "terminal" }] },
    };
    const result = await runCalibrationAttestation(
      {
        sessionId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        claimToken: crypto.randomUUID(),
        contractRevisionId: crypto.randomUUID(),
        operationDigest: protectedTransactionDigest(action, [origin]),
        inputSchemaDigest: transactionInputSchemaDigest(action),
        inputDigest: transactionInputDigest(action),
        operationId: action.operationId,
        operation: action,
        environmentId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        policy: {
          allowedOrigins: [origin],
          allowPrivateNetwork: true,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 5,
          maxDurationMs: 3_000,
          maxNavigations: 1,
        },
        plan: {
          name: "Failure",
          objective: "Preserve failure",
          preconditions: [],
          allowedOrigins: [origin],
          budgets: { maxActions: 5, maxDurationMs: 3_000, maxNavigations: 1 },
          checkpoints: [],
          steps: [
            {
              id: "open",
              title: "Open",
              action: { type: "navigate", url: origin },
              assertions: [],
              onFailure: "stop",
              evidence: [],
              captureIntent: "final",
            },
            {
              id: "missing-step",
              title: "Missing",
              action: {
                type: "click",
                target: intent("Missing", "button"),
                expectedEffect: { type: "none" },
                timeoutMs: 100,
              },
              assertions: [],
              onFailure: "stop",
              evidence: [],
              captureIntent: "final",
            },
            {
              id: "protected",
              title: "Protected",
              action,
              assertions: [],
              onFailure: "stop",
              evidence: [],
              captureIntent: "final",
            },
          ],
        },
      },
      process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      undefined,
      undefined,
      undefined,
      undefined,
      calibrationExecutor(),
    );
    expect(result).toMatchObject({
      passed: false,
      mutationCount: 0,
      diagnostics: {
        code: "CALIBRATION_PREFLIGHT_STEP_FAILED",
        stepId: "missing-step",
        phase: "preflight",
      },
    });
  }, 20_000);
});

function calibrationExecutor() {
  const states = new Map<string, MutationLedgerState>();
  const mutationOutcomes = new Map<
    string,
    "not_attempted" | "not_applied" | "applied" | "unknown"
  >();
  return async (input: {
    plan: Parameters<typeof executePlan>[0]["plan"];
    policy: Parameters<typeof executePlan>[0]["policy"];
    options: Omit<Parameters<typeof executePlan>[0], "plan" | "policy">;
    beforeMutationTransition(value: { expected: string; next: string }): Promise<boolean>;
  }) =>
    executePlan({
      ...input.options,
      plan: input.plan,
      policy: input.policy,
      executeNativeNavigation: async (page, url, _allowedOrigins, timeoutMs) => {
        const timeout = timeoutMs === undefined ? {} : { timeout: timeoutMs };
        await page.goto(url, { waitUntil: "domcontentloaded", ...timeout });
        await page.locator("body").waitFor({ state: "visible", ...timeout });
      },
      protectedTransactionExecutor: ({ transaction, dependencies }) =>
        new ProtectedTransactionKernel(dependencies).execute(transaction),
      protectedTransactionStore: {
        claim: async ({ operationId }) => ({
          id: operationId,
          state: states.get(operationId) ?? "planned",
          version: 1,
          fencingToken: 1,
          mutationOutcome: mutationOutcomes.get(operationId) ?? "not_attempted",
        }),
        transition: async ({ operationId, expected, next }) => {
          if ((states.get(operationId) ?? "planned") !== expected)
            throw new Error("PROTECTED_OPERATION_TRANSITION_FENCED");
          if (!(await input.beforeMutationTransition({ expected, next })))
            throw new Error("PROTECTED_OPERATION_TRANSITION_FENCED");
          states.set(operationId, next);
          return {
            id: operationId,
            state: next,
            version: 2,
            fencingToken: 1,
            mutationOutcome: mutationOutcomes.get(operationId) ?? "not_attempted",
          };
        },
        settleMutationOutcome: async ({ id, version, fencingToken, outcome }) => {
          const current = mutationOutcomes.get(id);
          if ((current === "applied" || current === "not_applied") && current !== outcome)
            throw new Error("PROTECTED_MUTATION_OUTCOME_SETTLEMENT_CONTRADICTION");
          mutationOutcomes.set(id, outcome);
          return {
            id,
            state: states.get(id) ?? "reconciling",
            version: version + 1,
            fencingToken,
            mutationOutcome: outcome,
          };
        },
        record: async () => undefined,
      },
      atomicOutputCapture: async ({ claim, outputs }) => {
        const references: Record<
          string,
          {
            classification: "public" | "protected";
            credentialId?: string;
            valueId?: string;
            scope: "run" | "project";
          }
        > = {};
        for (const output of outputs) {
          references[output.reference] =
            output.classification === "protected"
              ? {
                  classification: "protected",
                  ...(await input.options.atomicSecretCapture!({
                    operationId: claim.id,
                    reference: output.reference,
                    name: output.name,
                    value: output.value,
                    scope: output.scope,
                  })),
                  scope: output.scope,
                }
              : {
                  classification: "public",
                  ...(await input.options.publicValueCapture!({
                    operationId: claim.id,
                    reference: output.reference,
                    name: output.name,
                    value: output.value,
                    scope: output.scope,
                  })),
                  scope: output.scope,
                };
          output.value = "";
        }
        states.set(claim.id, "persisted");
        return { claim: { ...claim, state: "persisted", version: claim.version + 1 }, references };
      },
    });
}
