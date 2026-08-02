import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executePlan, structureFingerprint, type CalibrationStructure, type MutationLedgerState, type ProtectedTransactionStore } from "@scry/executor";
import { unzipSync } from "fflate";

import type { CalibrationCompletion, CalibrationRuntime } from "./calibration-runtime.repository.js";

export async function runCalibrationAttestation(
  runtime: CalibrationRuntime,
  browserChannel = "chromium",
  resolveCredential?: (reference: string) => Promise<string>,
  markMutation?: (state: "started" | "completed" | "unknown") => Promise<boolean>,
  onPhase?: (phase: string) => Promise<boolean>,
): Promise<CalibrationCompletion> {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-calibration-"));
  let boundary: { structure: CalibrationStructure; url: string } | undefined;
  const capturedProtectedValues: string[] = [];
  const capturedPublicValues = new Map<string, string>();
  let protectedFailure: Record<string, unknown> | undefined;
  let transactionResult: Record<string, unknown> | undefined;
  let mutationCount = 0;
  const states = new Map<string, MutationLedgerState>();
  const transactionStore: ProtectedTransactionStore = {
    claim: async ({ operationId }) => ({ state: states.get(operationId) ?? "planned", fencingToken: 1 }),
    transition: async ({ operationId, expected, next }) => {
      if ((states.get(operationId) ?? "planned") !== expected) return false;
      if (next === "dispatching") {
        mutationCount += 1;
        await onPhase?.("executing_protected_transaction");
        if (mutationCount > 1 || !(await markMutation?.("started") ?? true)) return false;
      }
      if (next === "acknowledged" && !(await markMutation?.("completed") ?? true)) return false;
      states.set(operationId, next);
      return true;
    },
    record: async () => undefined,
  };
  try {
    const targetIndex = runtime.plan.steps.findIndex((step) => step.action.type === "protectedTransaction" && step.action.operationId === runtime.operationId);
    if (targetIndex < 0) return { passed: false, mutationCount: 0, privacyVerified: false, canaryScanPassed: false, failureProvenance: "plan", diagnostics: { code: "CALIBRATION_OPERATION_MISMATCH", phase: "preparing" } };
    const calibrationSteps = runtime.plan.steps.slice(0, targetIndex + 1);
    const calibrationPlan = {
      ...runtime.plan,
      steps: calibrationSteps.map((step, index) => index === targetIndex && step.action.type === "protectedTransaction"
        ? { ...step, action: { ...step.action, continuation: { strategies: [{ mode: "terminal" as const }] } } }
        : step),
    };
    const report = await executePlan({
      plan: calibrationPlan,
      policy: runtime.policy,
      outputDirectory,
      browserChannel,
      ...(resolveCredential ? { secretResolver: resolveCredential } : {}),
      protectedTransactionStore: transactionStore,
      atomicSecretCapture: async ({ value }) => { capturedProtectedValues.push(value); return { credentialId: crypto.randomUUID() }; },
      publicValueCapture: async ({ reference, value }) => { const valueId = crypto.randomUUID(); capturedPublicValues.set(valueId, value); capturedPublicValues.set(reference, value); return { valueId }; },
      publicValueResolver: async (reference) => capturedPublicValues.get(reference) ?? reference,
      calibrationRehearsal: {
        operationId: runtime.operationId,
        stopBeforeMutation: false,
        onBoundary: async ({ structure, url }) => {
          boundary = { structure, url };
          await onPhase?.("boundary_reached");
          await onPhase?.("arming_privacy");
        },
      },
      onEvent: (event) => {
        if (event.type === "privacy.operation_failed") protectedFailure = safeProtectedFailure(event.payload);
        if (event.type === "privacy.operation_completed" && event.payload.result && typeof event.payload.result === "object") transactionResult = event.payload.result as Record<string, unknown>;
      },
    });
    const failedStep = report.steps.find((step) => step.status === "failed");
    if (report.state !== "passed" || !boundary) {
      return {
        passed: false, mutationCount, privacyVerified: false, canaryScanPassed: false,
        failureProvenance: report.state === "infrastructure_error" ? "infrastructure" : "plan",
        diagnostics: {
          code: boundary ? "CALIBRATION_TRANSACTION_FAILED" : "CALIBRATION_PREFLIGHT_STEP_FAILED",
          phase: safePhase(transactionResult, boundary),
          reasonCode: safeReason(transactionResult),
          retryClass: safeRetry(transactionResult),
          mutationDispatched: mutationCount > 0,
          candidateDiagnostics: safeCandidateDiagnostics(transactionResult),
          preparationEffects: safePreparationEffects(transactionResult),
          ...(failedStep ? { stepId: failedStep.id } : {}),
          ...(protectedFailure ? { protectedFailure } : {}),
        },
      };
    }
    if (!runtime.plan.allowedOrigins.map((value) => new URL(value).origin).includes(new URL(boundary.url).origin)) {
      return { passed: false, mutationCount, privacyVerified: false, canaryScanPassed: false, failureProvenance: "policy", diagnostics: { code: "CALIBRATION_ORIGIN_MISMATCH", phase: "boundary_reached" } };
    }
    const leakChannels = capturedProtectedValues.length
      ? [...new Set((await Promise.all(capturedProtectedValues.map((value) => canaryLeakChannels(report, outputDirectory, value)))).flat())]
      : ["capture_missing"];
    const canaryScanPassed = leakChannels.length === 0;
    await onPhase?.("scanning_channels");
    const fingerprint = structureFingerprint(boundary.structure);
    return {
      passed: mutationCount === 1 && capturedProtectedValues.length > 0 && canaryScanPassed,
      structure: boundary.structure,
      fingerprint,
      mutationCount,
      privacyVerified: report.state === "passed",
      canaryScanPassed,
      diagnostics: { code: canaryScanPassed ? "CALIBRATION_ATTESTED" : "CALIBRATION_CANARY_DETECTED", phase: "scanning_channels", mutationCount, ...(leakChannels.length ? { leakChannels } : {}) },
      protectionResult: { status: "passed", mode: "separate_browser_capsule" },
      extractionResult: { status: "passed", outputCount: runtime.operation.extraction.outputs.length },
      safeExitResult: { status: "passed", boundaryCount: 1 },
    };
  } catch (error) {
    if (mutationCount > 0) await markMutation?.("unknown").catch(() => undefined);
    return { passed: false, mutationCount, privacyVerified: false, canaryScanPassed: false, failureProvenance: "infrastructure", diagnostics: { code: safeCode(error), phase: boundary ? "executing_protected_transaction" : "executing_preflight" } };
  } finally {
    capturedProtectedValues.length = 0;
    capturedPublicValues.clear();
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function canaryLeakChannels(report: unknown, root: string, value: string) {
  const channels = new Set<string>();
  if (containsCanary(Buffer.from(JSON.stringify(report)), value)) channels.add("report");
  await scanDirectory(root, value, channels);
  return [...channels].sort();
}
async function scanDirectory(root: string, value: string, channels: Set<string>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) { await scanDirectory(target, value, channels); continue; }
    const bytes = await readFile(target);
    if (containsCanary(Buffer.from(entry.name), value) || containsCanary(bytes, value) || (entry.name.endsWith(".zip") && zipContainsCanary(bytes, value))) {
      channels.add(entry.name.endsWith(".webm") ? "video" : entry.name.endsWith(".zip") ? "trace" : entry.name.endsWith(".png") ? "screenshot" : entry.name.endsWith(".html") ? "dom" : "artifact");
    }
  }
}
function zipContainsCanary(bytes: Buffer, value: string) {
  try {
    return Object.entries(unzipSync(bytes)).some(([name, contents]) => containsCanary(Buffer.from(name), value) || containsCanary(Buffer.from(contents), value));
  } catch { return false; }
}
function containsCanary(bytes: Buffer, value: string) {
  const variants = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex")];
  return [...new Set(variants)].some((variant) => variant.length > 0 && bytes.includes(Buffer.from(variant)));
}
function safeCode(error: unknown) { const value = error instanceof Error ? error.message : String(error); return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : "CALIBRATION_EXECUTION_FAILED"; }
function safePhase(result: Record<string, unknown> | undefined, boundary: unknown) { const value = result?.failurePhase; return typeof value === "string" && /^[a-z_]+$/.test(value) ? value : boundary ? "protected_transaction" : "preflight"; }
function safeReason(result: Record<string, unknown> | undefined) { const value = result?.reasonCode; return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value) ? value : "CALIBRATION_TRANSACTION_FAILED"; }
function safeRetry(result: Record<string, unknown> | undefined) { const value = result?.retryClass; return typeof value === "string" && ["safe_to_retry", "retry_requires_reconciliation", "do_not_retry", "manual_review"].includes(value) ? value : "manual_review"; }
function safeCandidateDiagnostics(result: Record<string, unknown> | undefined) {
  const diagnostics = result?.diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.map((item) => {
    if (!item || typeof item !== "object") return undefined;
    const value = item as Record<string, unknown>;
    return {
      candidate: Number(value.candidate), attempts: Number(value.attempts), durationMs: Number(value.durationMs),
      containerResolved: Boolean(value.containerResolved), matchCount: safeEnum(value.matchCount, ["none", "one", "many", "unknown"]),
      visibility: safeEnum(value.visibility, ["visible", "hidden", "unknown"]), accessibility: safeEnum(value.accessibility, ["available", "unavailable", "unknown"]),
      ...(typeof value.lastFailureCode === "string" && /^[A-Z][A-Z0-9_]*$/.test(value.lastFailureCode) ? { lastFailureCode: value.lastFailureCode } : {}),
    };
  }).filter(Boolean);
}
function safePreparationEffects(result: Record<string, unknown> | undefined) {
  const effects = result?.preparationEffects;
  if (!Array.isArray(effects)) return [];
  return effects.map((item) => {
    if (!item || typeof item !== "object") return undefined;
    const value = item as Record<string, unknown>;
    const method = typeof value.method === "string" && ["POST", "PUT", "PATCH", "DELETE", "OTHER"].includes(value.method) ? value.method : "OTHER";
    const origin = typeof value.origin === "string" ? value.origin.slice(0, 500) : "opaque";
    const path = typeof value.path === "string" ? value.path.slice(0, 1_000) : "opaque";
    const disposition = value.disposition === "ignored" ? "ignored" : "blocked";
    const category = value.category === "telemetry" || value.category === "platform" ? value.category : undefined;
    return { method, origin, path, disposition, ...(category ? { category } : {}) };
  }).filter(Boolean);
}
function safeProtectedFailure(payload: Record<string, unknown>) {
  const diagnostics = Array.isArray(payload.diagnostics)
    ? payload.diagnostics.map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const value = item as Record<string, unknown>;
      return {
        candidate: Number(value.candidate), attempts: Number(value.attempts), durationMs: Number(value.durationMs),
        containerResolved: Boolean(value.containerResolved), matchCount: safeEnum(value.matchCount, ["none", "one", "many", "unknown"]),
        visibility: safeEnum(value.visibility, ["visible", "hidden", "unknown"]),
        accessibility: safeEnum(value.accessibility, ["available", "unavailable", "unknown"]),
        ...(typeof value.lastFailureCode === "string" && /^[A-Z][A-Z0-9_]*$/.test(value.lastFailureCode) ? { lastFailureCode: value.lastFailureCode } : {}),
      };
    }).filter(Boolean)
    : [];
  return {
    code: typeof payload.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(payload.code) ? payload.code : "PROTECTED_TRANSACTION_FAILED",
    status: typeof payload.status === "string" && /^[a-z_]+$/.test(payload.status) ? payload.status : "failed",
    ...(typeof payload.stage === "string" && /^[a-z_]+$/.test(payload.stage) ? { stage: payload.stage } : {}),
    ...(typeof payload.boundaryVerified === "boolean" ? { boundaryVerified: payload.boundaryVerified } : {}),
    ...(typeof payload.knownValueCleared === "boolean" ? { knownValueCleared: payload.knownValueCleared } : {}),
    diagnostics,
  };
}
function safeEnum(value: unknown, allowed: string[]) { return typeof value === "string" && allowed.includes(value) ? value : "unknown"; }
