import { createHash } from "node:crypto";
import type { ExpectedEffect, InteractionTargetIntent, PraxisLifecycleEvent, PraxisOperation, PraxisRequest, PraxisResult } from "@scry/contracts";
import type { Page } from "playwright";
import { LegacyPraxisAdapter, type PraxisInputResolver } from "./praxis-legacy-adapter.js";
import { PraxisDocumentEpoch } from "./praxis-observation.js";
import { PraxisTransactionCoordinator } from "./praxis-transaction.js";

export type PraxisConsumerContext = {
  runId?: string;
  attemptId?: string;
  stepId?: string;
  channel: "action" | "assertion" | "readiness" | "probe" | "calibration" | "protected" | "acquisition" | "recovery";
  ordinal: number;
  allowedOrigins: string[];
  timeoutMs: number;
  privacy?: PraxisRequest["privacy"];
  emit?: (event: PraxisLifecycleEvent) => void | Promise<void>;
  record?: (result: PraxisResult) => void | Promise<void>;
};

export type PraxisConsumerInput = {
  page: Page;
  intent: InteractionTargetIntent;
  operation: PraxisOperation;
  expectedEffect?: ExpectedEffect;
  context: PraxisConsumerContext;
  signal: AbortSignal;
  resolveInput?: PraxisInputResolver;
};

export async function executePraxisConsumer(input: PraxisConsumerInput): Promise<PraxisResult> {
  const request = await buildPraxisRequest(input);
  const result = await new PraxisTransactionCoordinator(new LegacyPraxisAdapter(input.page, input.resolveInput), input.context.emit).execute(request, input.signal);
  await input.context.record?.(result);
  return result;
}

export async function requirePraxisSuccess(input: PraxisConsumerInput) {
  const result = await executePraxisConsumer(input);
  if (result.status !== "succeeded") throw new PraxisConsumerError(result);
  return result;
}

export class PraxisConsumerError extends Error {
  constructor(readonly result: Exclude<PraxisResult, { status: "succeeded" }>) { super(result.code); this.name = "PraxisConsumerError"; }
}

async function buildPraxisRequest(input: PraxisConsumerInput): Promise<PraxisRequest> {
  const epoch = await PraxisDocumentEpoch.current(input.page);
  const seed = [input.context.runId ?? "standalone", input.context.attemptId ?? "attempt", input.context.stepId ?? "step", input.context.channel, input.context.ordinal, input.operation.type].join(":");
  const transactionId = `praxis-${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
  const operationId = `${input.context.channel}-${input.context.ordinal}-${input.operation.type}`;
  const origin = safeOrigin(input.page.url(), input.context.allowedOrigins[0]);
  return {
    schemaVersion: 1,
    transactionId,
    operationId,
    ...(input.context.stepId ? { stepId: input.context.stepId } : {}),
    intent: input.intent,
    operation: input.operation,
    expectedEffect: input.expectedEffect ?? { type: "none" },
    risk: input.intent.risk,
    policy: { allowedOrigins: input.context.allowedOrigins, actionTimeoutMs: bounded(input.context.timeoutMs, 100, 60_000), totalTimeoutMs: bounded(input.context.timeoutMs, 100, 120_000) },
    privacy: input.context.privacy ?? { state: "normal", allowedChannels: ["public_dom", "accessibility", "visual"], suppressedChannels: [] },
    context: { ...(input.context.runId ? { runId: input.context.runId } : {}), ...(input.context.attemptId ? { attemptId: input.context.attemptId } : {}), pageId: `page-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`, origin, documentEpoch: epoch },
  };
}

function safeOrigin(url: string, fallback?: string) { try { return new URL(url).origin; } catch { return new URL(fallback ?? "https://scry.invalid").origin; } }
function bounded(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, Math.round(value))); }
