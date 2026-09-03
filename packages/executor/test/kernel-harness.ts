import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { CurrentAction, ExecutionPolicy, ExpectedEffect } from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";
import { chromium, type Page } from "playwright";

import { createExecutionCapabilityManifest, ExecutionKernel } from "../src/execution-kernel.js";

export async function openTestBrowser() {
  const channel = process.env.SCRY_BROWSER_CHANNEL ?? "chrome";
  const browser = await chromium.launch({
    headless: true,
    ...(channel === "chromium" ? {} : { channel }),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, context, page };
}

export function kernelInteractionExecutor(input: {
  sessionId: string;
  environmentId: string;
  policy: ExecutionPolicy;
  secretResolver?: (reference: string) => Promise<string>;
  secretRedactor?: SecretRedactor;
  executeSameOriginRequest?: NonNullable<
    import("../src/types.js").ExecuteOptions["executeSameOriginRequest"]
  >;
}) {
  const kernel = new ExecutionKernel();
  const mutationStates = new Map<string, string>();
  return async (operation: {
    page: Page;
    action: CurrentAction;
    ordinal: number;
    operationId: string;
    expectedEffect?: ExpectedEffect;
    resolveEffectPage?: () => Promise<Page | undefined>;
    objectiveDelta?: string;
    signal?: AbortSignal;
    privacyGate?: import("@scry/veil").VeilRuntimeCoordinator;
  }) => {
    const correlationId = randomUUID();
    const operationId = operation.operationId ?? `test-${operation.ordinal}`;
    const manifest = createExecutionCapabilityManifest({ mode: "rehearse", correlationId });
    return kernel.interact({
      request: {
        sessionId: input.sessionId,
        operationId,
        correlationId,
        mode: "rehearse",
        policy: input.policy,
        mutationIdentity: `test-mutation-${operationId}`,
        ...(operation.objectiveDelta ? { semanticContext: operation.objectiveDelta } : {}),
      },
      capabilities: {
        manifest,
        journal: {
          begin: async () => undefined,
          complete: async () => undefined,
          fail: async () => undefined,
          settle: async ({ mutation }) => {
            if (mutation) mutationStates.set(mutation.mutationIdentity, mutation.next);
          },
        },
        mutationFence: {
          claim: async ({ mutationIdentity }) => ({
            state: mutationStates.get(mutationIdentity) ?? "planned",
            fencingToken: 1,
          }),
          transition: async ({ mutationIdentity, expected, next }) => {
            const state = mutationStates.get(mutationIdentity) ?? "planned";
            if (state !== expected) return false;
            mutationStates.set(mutationIdentity, next);
            return true;
          },
        },
        options: {
          outputDirectory: path.join(os.tmpdir(), "scry-kernel-test"),
          environmentId: input.environmentId,
          veilAdmissionKey: "test-kernel-admission-key",
          ...(input.secretResolver ? { secretResolver: input.secretResolver } : {}),
          ...(input.secretRedactor ? { secretRedactor: input.secretRedactor } : {}),
          ...(input.executeSameOriginRequest
            ? { executeSameOriginRequest: input.executeSameOriginRequest }
            : {}),
          ...(operation.signal ? { signal: operation.signal } : {}),
        },
      },
      ...operation,
      ...(operation.privacyGate ? { privacyGate: operation.privacyGate } : {}),
    });
  };
}
