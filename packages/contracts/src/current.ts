import { z } from "zod";

import {
  assertionSchema,
  budgetsSchema,
  readinessSchema,
} from "./plan.js";
import { acquisitionIntentSchema, acquisitionReadinessContractSchema, expectedEffectSchema, interactionTargetIntentSchema } from "./grounding.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const timeout = z.number().int().min(100).max(60_000).optional();
const nonEmptyText = z.string().trim().min(1).max(2_000);

export const privacyStateSchema = z.enum([
  "normal",
  "arming",
  "armed",
  "ready_to_reveal",
  "protected",
  "captured",
  "establishing_safe_boundary",
  "safe_to_resume",
  "sealed",
  "aborted",
  "continuing_unrecorded",
  "restarting_checkpoint",
]);

export const evidenceChannelSchema = z.enum([
  "video", "trace", "screenshot", "dom", "accessibility", "console",
  "page_error", "network", "report", "event", "metadata", "clipboard", "download",
]);

export const captureDecisionSchema = z.enum(["allow", "sanitize", "suppress", "quarantine"]);

export const privacyFailureSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  collector: z.string().min(1).optional(),
}).strict();

export const privacyModeSchema = z.enum([
  "protected_element",
  "protected_surface",
  "protected_recording_gap",
]);

export const contextProvenanceSchema = z.enum([
  "safe",
  "safe_parked",
  "protected",
  "tainted",
  "destroyed",
  "restored_pending_verification",
  "restored_safe",
]);

export const safeResumeBoundarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("known_secret_registered"), referenceType: z.enum(["vault", "captured"]) }).strict(),
  z.object({ kind: z.literal("protected_surface_closed"), verifier: interactionTargetIntentSchema }).strict(),
  z.object({
    kind: z.literal("known_safe_navigation"),
    urlPattern: z.string().trim().min(1).max(500).refine((value) => { try { new RegExp(value); return true; } catch { return false; } }, "navigation boundary pattern must be a valid regular expression"),
  }).strict(),
  z.object({ kind: z.literal("checkpoint_restored"), checkpointId: identifier }).strict(),
  z.object({ kind: z.literal("protected_page_destroyed"), pageId: identifier }).strict(),
  z.object({ kind: z.literal("protected_context_destroyed"), contextId: identifier }).strict(),
]);

const mutationActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), target: interactionTargetIntentSchema, expectedEffect: expectedEffectSchema.default({ type: "none" }), timeoutMs: timeout }).strict(),
  z.object({
    type: z.literal("press"),
    target: interactionTargetIntentSchema.optional(),
    expectedEffect: expectedEffectSchema.default({ type: "none" }),
    key: z.enum(["Enter", "Space"]),
    timeoutMs: timeout,
  }).strict(),
]);

const transactionInputSchema = z.discriminatedUnion("classification", [
  z.object({ classification: z.literal("public"), value: z.union([z.string().max(20_000), z.boolean()]) }).strict(),
  z.object({ classification: z.literal("known_secret"), credentialRef: z.string().uuid() }).strict(),
]);

const preparationActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url(), effect: z.literal("read_only"), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("clickNavigation"), target: interactionTargetIntentSchema, expectedEffect: expectedEffectSchema.default({ type: "none" }), effect: z.literal("read_only"), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("clickPublicInput"), input: identifier, exact: z.boolean().default(true), effect: z.literal("read_only"), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("fillPublicInput"), input: identifier, target: interactionTargetIntentSchema, effect: z.literal("replayable_setup"), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("fillKnownSecret"), input: identifier, target: interactionTargetIntentSchema, effect: z.literal("replayable_setup"), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("selectPublicInput"), input: identifier, target: interactionTargetIntentSchema, effect: z.literal("replayable_setup"), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("checkPublicInput"), input: identifier, target: interactionTargetIntentSchema, effect: z.literal("replayable_setup"), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("waitFor"), target: interactionTargetIntentSchema, state: z.enum(["visible", "hidden", "attached", "detached"]), effect: z.literal("read_only"), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("assertion"), assertion: assertionSchema, effect: z.literal("read_only") }).strict(),
]);

const transactionAssertionSchema = z.union([
  assertionSchema,
  z.object({ type: z.literal("fieldValueMatchesInput"), target: interactionTargetIntentSchema, input: identifier, timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("textMatchesInput"), target: interactionTargetIntentSchema, input: identifier, exact: z.boolean().default(true), timeoutMs: timeout }).strict(),
]);

const transactionOutputSchema = z.discriminatedUnion("classification", [
  z.object({
    classification: z.literal("protected"), reference: identifier,
    acquisition: acquisitionIntentSchema,
    storage: z.object({ credentialName: z.string().trim().min(1).max(200), scope: z.enum(["run", "project"]) }).strict(),
  }).strict(),
  z.object({
    classification: z.literal("public"), reference: identifier,
    acquisition: acquisitionIntentSchema,
    storage: z.object({ name: z.string().trim().min(1).max(200), scope: z.enum(["run", "project"]) }).strict(),
  }).strict(),
]);

export const protectedTransactionSchema = z.object({
  type: z.literal("protectedTransaction"),
  operationId: identifier,
  entry: z.object({ url: z.string().url(), assertions: z.array(assertionSchema).min(1).max(20) }).strict(),
  inputs: z.record(identifier, transactionInputSchema),
  preparation: z.object({
    actions: z.array(preparationActionSchema).min(1).max(50),
    assertions: z.array(transactionAssertionSchema).min(1).max(20),
    effectPolicy: z.object({
      ignoredRequests: z.array(z.object({
        origin: z.string().url().refine((value) => new URL(value).pathname === "/", "ignored request origin must not contain a path"),
        pathPrefix: z.string().startsWith("/").max(500),
        methods: z.array(z.enum(["POST", "PUT", "PATCH", "DELETE"])).min(1).max(4),
        category: z.enum(["telemetry", "platform"]),
        justification: z.string().trim().min(20).max(500),
      }).strict()).max(20).default([]),
    }).strict().default({ ignoredRequests: [] }),
  }).strict(),
  mutation: z.object({
    action: mutationActionSchema,
    kind: z.enum(["one_time", "repeatable"]),
    reconciliation: z.discriminatedUnion("strategy", [
      z.object({ strategy: z.literal("none"), acceptUnknownOutcome: z.boolean() }).strict(),
      z.object({ strategy: z.literal("persisted_outputs"), requiredReferences: z.array(identifier).min(1).max(8) }).strict(),
      z.object({ strategy: z.literal("public_ui_state"), assertions: z.array(transactionAssertionSchema).min(1).max(20) }).strict(),
      z.object({ strategy: z.literal("public_api_state"), adapterId: identifier, configuration: z.record(z.string(), z.unknown()).default({}) }).strict(),
      z.object({ strategy: z.literal("adapter"), adapterId: identifier, configuration: z.record(z.string(), z.unknown()).default({}) }).strict(),
    ]),
  }).strict(),
  extraction: z.object({
    outputs: z.array(transactionOutputSchema).min(1).max(8),
    timeoutMs: z.number().int().min(100).max(60_000),
    scheduling: z.literal("fair_shared_timeout"),
  }).strict(),
  acquisitionReadiness: acquisitionReadinessContractSchema,
  continuation: z.object({ strategies: z.array(z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("resume_parked_context"), reentryUrl: z.string().url(), assertions: z.array(transactionAssertionSchema).min(1).max(20), continueAtStepId: identifier }).strict(),
    z.object({ mode: z.literal("recreate_clean_context"), checkpointId: identifier, reentryUrl: z.string().url(), assertions: z.array(transactionAssertionSchema).min(1).max(20), continueAtStepId: identifier }).strict(),
    z.object({ mode: z.literal("reauthenticate"), authenticationContractId: identifier, reentryUrl: z.string().url(), assertions: z.array(transactionAssertionSchema).min(1).max(20), continueAtStepId: identifier }).strict(),
    z.object({ mode: z.literal("continue_unrecorded") }).strict(),
    z.object({ mode: z.literal("terminal") }).strict(),
  ])).min(1).max(5) }).strict(),
  calibrationAttestationId: z.string().uuid().optional(),
  revocationAdapter: z.object({ adapterId: identifier, configuration: z.record(z.string(), z.unknown()).default({}) }).strict().optional(),
}).strict().superRefine((transaction, context) => {
  const usedInputs = new Set(transaction.preparation.actions.flatMap((action) => "input" in action ? [action.input] : []));
  for (const input of Object.keys(transaction.inputs)) if (!usedInputs.has(input)) context.addIssue({ code: "custom", message: `unused transaction input: ${input}`, path: ["inputs", input] });
  for (const [index, action] of transaction.preparation.actions.entries()) {
    if (!("input" in action)) continue;
    const input = transaction.inputs[action.input];
    if (!input) context.addIssue({ code: "custom", message: `undeclared transaction input: ${action.input}`, path: ["preparation", "actions", index, "input"] });
    if (action.type === "fillKnownSecret" && input?.classification !== "known_secret") context.addIssue({ code: "custom", message: "fillKnownSecret requires a known_secret input", path: ["preparation", "actions", index, "input"] });
    if (action.type !== "fillKnownSecret" && input?.classification === "known_secret") context.addIssue({ code: "custom", message: "known_secret inputs may only be used by fillKnownSecret", path: ["preparation", "actions", index, "input"] });
    if (action.type === "clickPublicInput" && input?.classification !== "public") context.addIssue({ code: "custom", message: "clickPublicInput requires a public input", path: ["preparation", "actions", index, "input"] });
  }
  const verifiedInputs = new Set(transaction.preparation.assertions.flatMap((assertion) => assertion.type === "fieldValueMatchesInput" || assertion.type === "textMatchesInput" ? [assertion.input] : []));
  const inputsRequiringValueAssertion = new Set(transaction.preparation.actions.flatMap((action) =>
    action.type === "fillPublicInput" || action.type === "fillKnownSecret" || action.type === "selectPublicInput" || action.type === "checkPublicInput" ? [action.input] : [],
  ));
  for (const input of inputsRequiringValueAssertion) {
    if (!verifiedInputs.has(input)) context.addIssue({ code: "custom", message: `transaction input lacks a post-preparation value assertion: ${input}`, path: ["preparation", "assertions"] });
  }
  if (!transaction.preparation.assertions.some((assertion) => assertion.type === "enabled" || assertion.type === "visible")) {
    context.addIssue({ code: "custom", message: "preparation requires a mutation-readiness assertion", path: ["preparation", "assertions"] });
  }
  const transactionAssertions = [
    ...transaction.preparation.assertions,
    ...(transaction.mutation.reconciliation.strategy === "public_ui_state" ? transaction.mutation.reconciliation.assertions : []),
    ...transaction.continuation.strategies.flatMap((strategy) => "assertions" in strategy ? strategy.assertions : []),
  ];
  for (const assertion of transactionAssertions) {
    if (assertion.type !== "fieldValueMatchesInput" && assertion.type !== "textMatchesInput") continue;
    const input = transaction.inputs[assertion.input];
    if (!input) context.addIssue({ code: "custom", message: `assertion references undeclared transaction input: ${assertion.input}`, path: ["preparation", "assertions"] });
    if (assertion.type === "textMatchesInput" && input?.classification !== "public") context.addIssue({ code: "custom", message: "textMatchesInput may only expose public transaction inputs", path: ["preparation", "assertions"] });
  }
  const outputRefs = new Set<string>();
  for (const [outputIndex, output] of transaction.extraction.outputs.entries()) {
    if (outputRefs.has(output.reference)) context.addIssue({ code: "custom", message: `duplicate transaction output: ${output.reference}`, path: ["extraction", "outputs", outputIndex, "reference"] });
    outputRefs.add(output.reference);
    if ((output.classification === "protected" && output.acquisition.classification !== "unknown_secret") || (output.classification === "public" && output.acquisition.classification !== "public")) context.addIssue({ code: "custom", message: "output and acquisition classifications must match", path: ["extraction", "outputs", outputIndex, "acquisition", "classification"] });
  }
  if (transaction.mutation.reconciliation.strategy === "persisted_outputs") {
    for (const [index, reference] of transaction.mutation.reconciliation.requiredReferences.entries()) {
      if (!outputRefs.has(reference)) context.addIssue({ code: "custom", message: `persisted-output reconciliation references an undeclared output: ${reference}`, path: ["mutation", "reconciliation", "requiredReferences", index] });
    }
  }
  if (transaction.mutation.kind === "one_time" && transaction.mutation.reconciliation.strategy === "none" && !transaction.mutation.reconciliation.acceptUnknownOutcome) {
    context.addIssue({ code: "custom", message: "one-time mutation requires reconciliation or explicit unknown-outcome acceptance", path: ["mutation", "reconciliation"] });
  }
});

export const capturePublicValueSchema = z.object({
  type: z.literal("capturePublicValue"),
  operationId: identifier,
  capture: z.object({
    acquisition: acquisitionIntentSchema,
    timeoutMs: z.number().int().min(100).max(60_000),
    scheduling: z.literal("fair_shared_timeout"),
  }).strict(),
  reference: identifier,
  storage: z.object({ name: z.string().trim().min(1).max(200), scope: z.enum(["run", "project"]) }).strict(),
}).strict().superRefine((operation, context) => {
  if (operation.capture.acquisition.classification !== "public") context.addIssue({ code: "custom", message: "public-value capture requires public acquisition", path: ["capture", "acquisition", "classification"] });
});

export const currentActionSchema = z.union([
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(2_048), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("click"), target: interactionTargetIntentSchema, expectedEffect: expectedEffectSchema.default({ type: "none" }), timeoutMs: timeout }).strict(),
  z.object({
    type: z.literal("fill"),
    target: interactionTargetIntentSchema,
    value: z.string().max(20_000).optional(),
    secretRef: z.string().uuid().optional(),
    capturedSecretRef: identifier.optional(),
    capturedValueRef: identifier.optional(),
    generatedValueRef: z.string().uuid().optional(),
    timeoutMs: timeout,
  }).strict().refine(
    (value) => [value.value, value.secretRef, value.capturedSecretRef, value.capturedValueRef, value.generatedValueRef]
      .filter((item) => item !== undefined).length === 1,
    "fill requires exactly one value source",
  ),
  z.object({ type: z.literal("select"), target: interactionTargetIntentSchema, value: nonEmptyText, timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("check"), target: interactionTargetIntentSchema, checked: z.boolean(), timeoutMs: timeout }).strict(),
  z.object({
    type: z.literal("press"),
    target: interactionTargetIntentSchema.optional(),
    key: z.enum(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]),
    timeoutMs: timeout,
  }).strict(),
  z.object({ type: z.literal("scroll"), target: interactionTargetIntentSchema.optional(), deltaY: z.number().int().min(-10_000).max(10_000) }).strict(),
  z.object({ type: z.literal("waitFor"), target: interactionTargetIntentSchema, state: z.enum(["visible", "hidden", "attached", "detached"]), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("screenshot"), name: identifier, fullPage: z.boolean().default(false) }).strict(),
  protectedTransactionSchema,
  capturePublicValueSchema,
]);

export const currentStepSchema = z.object({
  id: identifier,
  title: z.string().trim().min(1).max(500),
  action: currentActionSchema,
  after: readinessSchema.optional(),
  assertions: z.array(assertionSchema).max(20).default([]),
  onFailure: z.enum(["stop", "continue"]).default("stop"),
  evidence: z.array(z.enum(["screenshot", "dom", "network"])).max(3).default([]),
  captureIntent: z.enum(["final", "transient"]).default("final"),
  transientJustification: z.string().trim().min(10).max(500).optional(),
}).strict();

export const checkpointSchema = z.object({
  id: identifier,
  beforeStepId: identifier,
  restorationUrl: z.string().url(),
  verificationAssertions: z.array(assertionSchema).min(1).max(20),
  continueAtStepId: identifier,
  maxRestorations: z.literal(1),
  state: z.object({ cookies: z.literal(true), localStorage: z.literal(true), indexedDb: z.boolean().default(true) }).strict(),
}).strict();

export const currentPlanSchema = z.object({
  name: z.string().trim().min(1).max(200),
  objective: nonEmptyText,
  preconditions: z.array(nonEmptyText).max(20).default([]),
  allowedOrigins: z.array(z.string().url()).min(1).max(5),
  budgets: budgetsSchema,
  checkpoints: z.array(checkpointSchema).max(20).default([]),
  steps: z.array(currentStepSchema).min(1).max(500),
}).strict().superRefine((plan, context) => {
  validateCapabilityRequirements(plan, [], context);
  if (plan.steps.length > plan.budgets.maxActions) {
    context.addIssue({ code: "custom", message: "step count exceeds the action budget", path: ["budgets", "maxActions"] });
  }
  const ids = new Set<string>();
  const references = new Set<string>();
  const checkpoints = new Map(plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const stepIndexes = new Map(plan.steps.map((step, index) => [step.id, index]));
  let navigationCount = 0;
  for (const [index, step] of plan.steps.entries()) {
    if (ids.has(step.id)) context.addIssue({ code: "custom", message: `duplicate step id: ${step.id}`, path: ["steps", index, "id"] });
    ids.add(step.id);
    if (step.action.type === "navigate") navigationCount += 1;
    if (step.action.type === "protectedTransaction") {
      for (const output of step.action.extraction.outputs) {
        if (references.has(output.reference)) context.addIssue({ code: "custom", message: `duplicate captured reference: ${output.reference}`, path: ["steps", index, "action", "extraction", "outputs"] });
        references.add(output.reference);
      }
    } else if (step.action.type === "capturePublicValue") {
      if (references.has(step.action.reference)) context.addIssue({ code: "custom", message: `duplicate captured reference: ${step.action.reference}`, path: ["steps", index, "action", "reference"] });
      references.add(step.action.reference);
    }
    if (step.action.type === "protectedTransaction" && step.onFailure === "continue") {
      context.addIssue({ code: "custom", message: "protected transactions use their continuation contract, not onFailure continue", path: ["steps", index, "onFailure"] });
    }
    if (step.action.type === "protectedTransaction") {
      if (!plan.allowedOrigins.includes(new URL(step.action.entry.url).origin)) context.addIssue({ code: "custom", message: "transaction entry origin must be allowed", path: ["steps", index, "action", "entry", "url"] });
      for (const [outputIndex, output] of step.action.extraction.outputs.entries()) {
        if (output.acquisition.permittedMethods.includes("protected_visual_reading") && !output.acquisition.target.preferredEvidence.visual?.protectedUse) context.addIssue({ code: "custom", message: "protected visual acquisition requires an explicitly protected visual target", path: ["steps", index, "action", "extraction", "outputs", outputIndex, "acquisition", "target", "preferredEvidence", "visual", "protectedUse"] });
      }
      const strategies = step.action.continuation.strategies;
      const terminalIndex = strategies.findIndex(({ mode }) => mode === "terminal" || mode === "continue_unrecorded");
      if (terminalIndex >= 0 && terminalIndex !== strategies.length - 1) {
        context.addIssue({ code: "custom", message: "terminal and unrecorded continuation strategies must be last", path: ["steps", index, "action", "continuation", "strategies", terminalIndex] });
      }
      for (const [strategyIndex, strategy] of strategies.entries()) {
        if (!("reentryUrl" in strategy)) continue;
        if (!plan.allowedOrigins.includes(new URL(strategy.reentryUrl).origin)) {
          context.addIssue({ code: "custom", message: "continuation re-entry origin must be allowed", path: ["steps", index, "action", "continuation", "strategies", strategyIndex, "reentryUrl"] });
        }
        const continuationIndex = stepIndexes.get(strategy.continueAtStepId);
        if (continuationIndex === undefined || continuationIndex <= index) {
          context.addIssue({ code: "custom", message: "continuation must target a later step", path: ["steps", index, "action", "continuation", "strategies", strategyIndex, "continueAtStepId"] });
        }
        if (strategy.mode === "recreate_clean_context") {
          const checkpoint = checkpoints.get(strategy.checkpointId);
          if (!checkpoint || checkpoint.beforeStepId !== step.id) context.addIssue({ code: "custom", message: "clean recreation requires a checkpoint immediately before this operation", path: ["steps", index, "action", "continuation", "strategies", strategyIndex, "checkpointId"] });
        }
      }
      if (strategies.some(({ mode }) => mode === "continue_unrecorded")) {
        for (let laterIndex = index + 1; laterIndex < plan.steps.length; laterIndex += 1) {
          const later = plan.steps[laterIndex]!;
          if (later.action.type === "screenshot" || later.evidence.length > 0) context.addIssue({ code: "custom", message: "steps reachable by unrecorded continuation cannot require evidence", path: ["steps", laterIndex, "evidence"] });
        }
      }
    }
  }
  if (navigationCount > plan.budgets.maxNavigations) {
    context.addIssue({ code: "custom", message: "navigation count exceeds the navigation budget", path: ["budgets", "maxNavigations"] });
  }
  for (const [checkpointIndex, checkpoint] of plan.checkpoints.entries()) {
    const before = stepIndexes.get(checkpoint.beforeStepId);
    if (before === undefined || plan.steps[before]?.action.type !== "protectedTransaction") context.addIssue({ code: "custom", message: "checkpoint beforeStepId must identify a protected transaction", path: ["checkpoints", checkpointIndex, "beforeStepId"] });
    if (!plan.allowedOrigins.includes(new URL(checkpoint.restorationUrl).origin)) context.addIssue({ code: "custom", message: "checkpoint restoration origin must be allowed", path: ["checkpoints", checkpointIndex, "restorationUrl"] });
  }
});

function validateCapabilityRequirements(value: unknown, path: Array<string | number>, context: z.RefinementCtx): void {
  if (Array.isArray(value)) { value.forEach((item, index) => validateCapabilityRequirements(item, [...path, index], context)); return; }
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  const target = item.target as { requiredCapabilities?: string[] } | undefined;
  const required = target?.requiredCapabilities ?? [];
  const requireAll = (capabilities: string[]) => {
    for (const capability of capabilities) if (!required.includes(capability)) context.addIssue({ code: "custom", message: `${String(item.type)} requires target capability ${capability}`, path: [...path, "target", "requiredCapabilities"] });
  };
  if (["fill", "fillPublicInput", "fillKnownSecret"].includes(String(item.type))) requireAll(["focusable", "accepts_text", "editable"]);
  if (["select", "selectPublicInput"].includes(String(item.type))) requireAll(["selects_option"]);
  if (["check", "checkPublicInput"].includes(String(item.type))) requireAll(["toggleable"]);
  if (["fieldValueMatchesInput", "value"].includes(String(item.type))) requireAll(["readable_value"]);
  if (String(item.type) === "checked") requireAll(["toggleable"]);
  if (["click", "clickNavigation"].includes(String(item.type)) && target && !required.includes("pointer_activatable") && !required.includes("keyboard_activatable")) context.addIssue({ code: "custom", message: `${String(item.type)} requires pointer_activatable or keyboard_activatable`, path: [...path, "target", "requiredCapabilities"] });
  for (const [key, child] of Object.entries(item)) validateCapabilityRequirements(child, [...path, key], context);
}

const channelResultSchema = z.object({
  status: z.enum(["passed", "failed", "not_configured"]),
  code: identifier.optional(),
}).strict();

export const evidenceResultSchema = z.object({
  kind: z.enum(["screenshot", "dom", "network", "recording", "trace"]),
  status: z.enum(["available", "degraded", "failed", "withheld"]),
  artifactId: z.string().uuid().optional(),
  code: identifier.optional(),
}).strict();

const safeActionSchema = z.enum(["abort", "continue_unrecorded", "retry_transaction", "retry_continuation", "request_calibration", "manual_reconciliation", "retry_acquisition", "request_secure_assistance", "revoke_credential", "abandon_credential"]);
export const extractionDiagnosticSchema = z.object({
  candidate: z.number().int().min(0), attempts: z.number().int().min(0), firstAttemptedAt: z.string().datetime().optional(),
  durationMs: z.number().int().min(0), containerResolved: z.boolean(), matchCount: z.enum(["none", "one", "many", "unknown"]),
  visibility: z.enum(["visible", "hidden", "unknown"]), accessibility: z.enum(["available", "unavailable", "unknown"]),
  lastFailureCode: identifier.optional(),
}).strict();
const phaseResultSchema = z.object({ status: z.enum(["not_started", "running", "succeeded", "failed", "incomplete"]), code: identifier.optional() }).strict();
export const protectedTransactionResultSchema = z.object({
  status: z.enum(["completed", "aborted", "continuing_unrecorded", "terminal", "outcome_unknown"]),
  bootstrap: phaseResultSchema,
  preparation: phaseResultSchema,
  mutation: z.object({ dispatch: z.enum(["not_started", "authorized", "started", "acknowledged"]), outcome: z.enum(["not_attempted", "confirmed_succeeded", "confirmed_not_applied", "unknown"]) }).strict(),
  protectedExtraction: z.enum(["not_attempted", "captured", "not_found", "failed"]),
  publicExtraction: z.enum(["not_attempted", "captured", "not_found", "failed"]),
  protectedPersistence: z.enum(["not_attempted", "confirmed", "uncertain", "failed"]),
  publicPersistence: z.enum(["not_attempted", "confirmed", "uncertain", "failed"]),
  capsule: z.enum(["not_created", "active", "destroyed", "force_terminated", "destruction_failed"]),
  reconciliation: z.enum(["not_configured", "succeeded", "not_applied", "unknown", "failed"]),
  continuation: z.enum(["not_attempted", "parked_resumed", "clean_recreated", "reauthenticated", "continuing_unrecorded", "terminal", "failed"]),
  evidence: z.enum(["stopped", "resumed", "permanently_suppressed"]),
  credentialSecurity: z.enum(["none", "active", "compromised", "revoked", "unusable"]),
  credentialReferences: z.record(identifier, z.string().uuid()).default({}),
  publicValueReferences: z.record(identifier, z.string().uuid()).default({}),
  continuedAtStepId: identifier.optional(),
  reasonCode: identifier.optional(),
  failurePhase: z.enum(["bootstrap", "preparation", "mutation_dispatch", "mutation_reconciliation", "extraction", "acquisition", "recovery", "persistence", "capsule_destruction", "continuation"]).optional(),
  retryClass: z.enum(["safe_to_retry", "retry_requires_reconciliation", "do_not_retry", "manual_review"]).optional(),
  safeActions: z.array(safeActionSchema),
  preparationEffects: z.array(z.object({
    method: z.enum(["POST", "PUT", "PATCH", "DELETE", "OTHER"]),
    origin: z.string().max(500),
    path: z.string().max(1_000),
    disposition: z.enum(["ignored", "blocked"]),
    category: z.enum(["telemetry", "platform"]).optional(),
  }).strict()).default([]),
  diagnostics: z.array(extractionDiagnosticSchema).default([]),
}).strict();

export type CurrentPlan = z.infer<typeof currentPlanSchema>;
export type CurrentStep = z.infer<typeof currentStepSchema>;
export type CurrentAction = z.infer<typeof currentActionSchema>;
export type ProtectedTransaction = z.infer<typeof protectedTransactionSchema>;
export type ProtectedTransactionResult = z.infer<typeof protectedTransactionResultSchema>;
export type ExtractionDiagnostic = z.infer<typeof extractionDiagnosticSchema>;
export type PrivacyMode = z.infer<typeof privacyModeSchema>;
export type PrivacyState = z.infer<typeof privacyStateSchema>;
export type EvidenceChannel = z.infer<typeof evidenceChannelSchema>;
export type CaptureDecision = z.infer<typeof captureDecisionSchema>;
export type PrivacyFailure = z.infer<typeof privacyFailureSchema>;
export type SafeResumeBoundary = z.infer<typeof safeResumeBoundarySchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type ContextProvenance = z.infer<typeof contextProvenanceSchema>;
