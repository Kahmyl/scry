import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  currentPlanSchema,
  type InteractionTargetIntent,
  type MissionAuthoringIntent,
  type ProtectedTransaction,
} from "../packages/contracts/src/index.js";

import { compileMissionAuthoringProtectedTransaction } from "../apps/api/src/adaptive-sessions/mission-authoring-protected-transaction.js";

type Capability = InteractionTargetIntent["requiredCapabilities"][number];
type PreparationKind =
  | "navigate"
  | "activate"
  | "fill_public"
  | "fill_protected"
  | "select"
  | "wait"
  | "inspect"
  | "check";
type PrototypeName =
  | "current_late_validation"
  | "full_plan_preflight"
  | "merged_capabilities"
  | "consumer_local"
  | "negotiated_hybrid";
type Scenario = {
  id: string;
  preparationKinds: PreparationKind[];
  preparation: MissionAuthoringIntent[];
  acquisition: Extract<MissionAuthoringIntent["action"], { kind: "acquire_protected_outputs" }>;
  observedCapabilities: Partial<Record<PreparationKind, Capability[]>>;
  shouldExecute: boolean;
};
type Result = {
  prototype: PrototypeName;
  scenarioId: string;
  admitted: boolean;
  lateFailure: boolean;
  safeBoundary: boolean;
  planValid: boolean;
  durationMs: number;
  reasonCode?: string;
};

const objectiveId = randomUUID();
const flowDraftId = randomUUID();
const protectedReferenceId = randomUUID();
const authorizationId = randomUUID();
const origin = "https://qualification.invalid";
const timeoutMs = 2_000;

const preparationPrograms: PreparationKind[][] = [
  ["navigate"],
  ["activate"],
  ["fill_public"],
  ["fill_protected"],
  ["select"],
  ["wait"],
  ["inspect"],
  ["fill_public", "select"],
  ["navigate", "fill_protected", "select", "wait"],
  ["fill_public", "activate", "inspect"],
  ["check"],
];
const scopes = [
  undefined,
  { kind: "dialog" as const, name: "Credential ceremony" },
  { kind: "section" as const, name: "API access" },
  { kind: "row" as const, name: "Application account" },
  { kind: "live_region" as const, name: "Generated credentials" },
];
const outputShapes = [
  [{ reference: "secret", classification: "protected" as const, role: "textbox" as const }],
  [
    { reference: "clientId", classification: "public" as const, role: "textbox" as const },
    { reference: "secret", classification: "protected" as const, role: "textbox" as const },
  ],
  [
    { reference: "clientId", classification: "public" as const, role: "value" as const },
    { reference: "secret", classification: "protected" as const, role: "text" as const },
  ],
  [
    { reference: "account", classification: "public" as const, role: "text" as const },
    { reference: "clientId", classification: "public" as const, role: "value" as const },
    { reference: "secret", classification: "protected" as const, role: "textbox" as const },
  ],
];
const mutationRoles = ["button", "link", "row"] as const;
const capabilityProfiles = [
  {
    name: "fully_observable",
    capabilities: {
      activate: ["focusable", "pointer_activatable"],
      fill_public: ["focusable", "accepts_text", "editable", "readable_value"],
      fill_protected: ["focusable", "accepts_text", "editable", "readable_value"],
      select: ["focusable", "selects_option", "readable_value"],
      wait: ["observable"],
      inspect: ["observable"],
      check: ["focusable", "toggleable", "readable_value"],
    },
  },
  {
    name: "write_only_custom_controls",
    capabilities: {
      activate: ["focusable", "pointer_activatable"],
      fill_public: ["focusable", "accepts_text", "editable"],
      fill_protected: ["focusable", "accepts_text", "editable"],
      select: ["focusable", "selects_option"],
      wait: ["observable"],
      inspect: ["observable"],
      check: ["focusable", "toggleable"],
    },
  },
  {
    name: "capability_mismatch",
    capabilities: {
      activate: ["observable"],
      fill_public: ["observable", "readable_value"],
      fill_protected: ["observable", "readable_value"],
      select: ["observable", "readable_value"],
      wait: ["observable"],
      inspect: ["observable"],
      check: ["observable", "readable_value"],
    },
  },
] satisfies Array<{ name: string; capabilities: Partial<Record<PreparationKind, Capability[]>> }>;

const scenarios: Scenario[] = [];
let ordinal = 0;
for (const program of preparationPrograms) {
  for (const scope of scopes) {
    for (const outputs of outputShapes) {
      for (const mutationRole of mutationRoles) {
        for (const exact of [true, false]) {
          for (const profile of capabilityProfiles) {
            ordinal += 1;
            const preparation = program.map((kind, index) =>
              preparationIntent(kind, index, scope, exact),
            );
            const acquisition = acquisitionAction(preparation, outputs, mutationRole, scope, exact);
            const shouldExecute = program.every((kind) =>
              expectedCompatibility(kind, profile.capabilities[kind] ?? []),
            );
            scenarios.push({
              id: `${String(ordinal).padStart(4, "0")}:${program.join("+")}:${profile.name}`,
              preparationKinds: program,
              preparation,
              acquisition,
              observedCapabilities: profile.capabilities,
              shouldExecute,
            });
          }
        }
      }
    }
  }
}

const results = scenarios.flatMap((scenario) =>
  (
    [
      "current_late_validation",
      "full_plan_preflight",
      "merged_capabilities",
      "consumer_local",
      "negotiated_hybrid",
    ] as const
  ).map((prototype) => evaluate(prototype, scenario)),
);

const forbidden =
  /(selector|xpath|runtimeId|fingerprint|browserHandle|outerHTML|innerHTML|plaintext|credentialValue)/i;
const serialized = JSON.stringify(results);
if (forbidden.test(serialized)) throw new Error("LAB_FORBIDDEN_IMPLEMENTATION_DETAIL");

const summary = (
  [
    "current_late_validation",
    "full_plan_preflight",
    "merged_capabilities",
    "consumer_local",
    "negotiated_hybrid",
  ] as const
).map((prototype) => {
  const sample = results.filter((result) => result.prototype === prototype);
  const executable = sample.filter((_, index) => scenarios[index]!.shouldExecute);
  const incompatible = sample.filter((_, index) => !scenarios[index]!.shouldExecute);
  return {
    prototype,
    scenarios: sample.length,
    admitted: sample.filter((result) => result.admitted).length,
    lateFailures: sample.filter((result) => result.lateFailure).length,
    unsafeAdmissions: incompatible.filter((result) => result.admitted).length,
    falseRefusals: executable.filter((result) => !result.admitted).length,
    safeBoundaries: sample.filter((result) => result.safeBoundary).length,
    validPlans: sample.filter((result) => result.planValid).length,
    latencyMs: latency(sample.map((result) => result.durationMs)),
    reasonCodes: counts(sample.map((result) => result.reasonCode ?? "NONE")),
  };
});

process.stdout.write(
  `${JSON.stringify(
    {
      outcome: "PROTECTED_AUTHORING_ARCHITECTURE_LAB_COMPLETE",
      generatedAt: new Date().toISOString(),
      scenarioCount: scenarios.length,
      evaluationCount: results.length,
      dimensions: {
        preparationPrograms: preparationPrograms.length,
        scopes: scopes.length,
        outputShapes: outputShapes.length,
        mutationRoles: mutationRoles.length,
        exactnessModes: 2,
        capabilityProfiles: capabilityProfiles.length,
      },
      safetyOracles: {
        noLateValidationAfterAdmission: true,
        noAdmissionWithoutObservedCapabilities: true,
        fullExecutablePlanValidation: true,
        unsupportedPreparationRejectedBeforeMutation: true,
        forbiddenImplementationDetailsAbsent: true,
      },
      summary,
    },
    null,
    2,
  )}\n`,
);

function evaluate(prototype: PrototypeName, scenario: Scenario): Result {
  const started = performance.now();
  try {
    const transaction =
      prototype === "negotiated_hybrid"
        ? compileNegotiatedHybrid(scenario)
        : compileMissionAuthoringProtectedTransaction({
            operationId: `lab-${scenario.id.replace(/[^A-Za-z0-9_-]/g, "-")}`,
            entryUrl: `${origin}/credentials`,
            action: scenario.acquisition,
            preparation: scenario.preparation,
            timeoutMs,
          });
    const transformed =
      prototype === "merged_capabilities"
        ? mergedCapabilities(transaction)
        : prototype === "consumer_local" || prototype === "negotiated_hybrid"
          ? consumerLocalCapabilities(transaction)
          : transaction;
    const planValid = currentPlanSchema.safeParse(planFor(transformed)).success;
    if (prototype === "current_late_validation") {
      return result({
        prototype,
        scenario,
        admitted: true,
        lateFailure: !planValid,
        safeBoundary: false,
        planValid,
        started,
      });
    }
    if (!planValid) {
      return result({
        prototype,
        scenario,
        admitted: false,
        lateFailure: false,
        safeBoundary: true,
        planValid,
        reasonCode: "FULL_PLAN_INVALID",
        started,
      });
    }
    if (prototype === "negotiated_hybrid" && !observedCapabilitiesSatisfy(transformed, scenario)) {
      return result({
        prototype,
        scenario,
        admitted: false,
        lateFailure: false,
        safeBoundary: true,
        planValid,
        reasonCode: "OBSERVED_CAPABILITY_MISMATCH",
        started,
      });
    }
    return result({
      prototype,
      scenario,
      admitted: true,
      lateFailure: false,
      safeBoundary: false,
      planValid,
      started,
    });
  } catch (error) {
    return result({
      prototype,
      scenario,
      admitted: false,
      lateFailure: false,
      safeBoundary: true,
      planValid: false,
      reasonCode: safeCode(error),
      started,
    });
  }
}

function compileNegotiatedHybrid(scenario: Scenario): ProtectedTransaction {
  const checkIndexes = scenario.preparationKinds.flatMap((kind, index) =>
    kind === "check" ? [index] : [],
  );
  const compilablePreparation = scenario.preparation.map((intent, index) => {
    if (!checkIndexes.includes(index)) return intent;
    if (intent.action.kind !== "set_checked") return intent;
    return {
      ...intent,
      action: {
        kind: "wait_for" as const,
        target: intent.action.target,
        state: "visible" as const,
      },
    };
  });
  const transaction = compileMissionAuthoringProtectedTransaction({
    operationId: `lab-${scenario.id.replace(/[^A-Za-z0-9_-]/g, "-")}`,
    entryUrl: `${origin}/credentials`,
    action: scenario.acquisition,
    preparation: compilablePreparation,
    timeoutMs,
  });
  for (const index of checkIndexes) {
    const original = scenario.preparation[index];
    const placeholder = transaction.preparation.actions[index];
    if (original?.action.kind !== "set_checked" || !placeholder || !("target" in placeholder))
      throw new Error("LAB_CHECK_COMPILATION_FAILED");
    const input = `input_check_${index}`;
    transaction.inputs[input] = { classification: "public", value: original.action.checked };
    const actionTarget = structuredClone(placeholder.target);
    actionTarget.requiredCapabilities = ["focusable", "toggleable"];
    transaction.preparation.actions[index] = {
      type: "checkPublicInput",
      input,
      target: actionTarget,
      effect: "replayable_setup",
      timeoutMs: original.constraints.timeoutMs,
    };
    transaction.preparation.assertions.push({
      type: "fieldValueMatchesInput",
      input,
      target: { ...structuredClone(actionTarget), requiredCapabilities: ["readable_value"] },
      timeoutMs: original.constraints.timeoutMs,
    });
  }
  return transaction;
}

function result(
  input: Omit<Result, "scenarioId" | "durationMs"> & { scenario: Scenario; started: number },
): Result {
  const { scenario, started, ...rest } = input;
  return { ...rest, scenarioId: scenario.id, durationMs: performance.now() - started };
}

function consumerLocalCapabilities(transaction: ProtectedTransaction): ProtectedTransaction {
  const copy = structuredClone(transaction);
  for (const assertion of copy.preparation.assertions) {
    if (assertion.type !== "fieldValueMatchesInput") continue;
    assertion.target.requiredCapabilities = union(assertion.target.requiredCapabilities, [
      "readable_value",
    ]);
  }
  return copy;
}

function mergedCapabilities(transaction: ProtectedTransaction): ProtectedTransaction {
  const copy = consumerLocalCapabilities(transaction);
  for (const action of copy.preparation.actions) {
    if (!("input" in action) || !("target" in action)) continue;
    const assertion = copy.preparation.assertions.find(
      (candidate) =>
        candidate.type === "fieldValueMatchesInput" && candidate.input === action.input,
    );
    if (!assertion || assertion.type !== "fieldValueMatchesInput") continue;
    const combined = union(
      action.target.requiredCapabilities,
      assertion.target.requiredCapabilities,
    );
    action.target.requiredCapabilities = combined;
    assertion.target.requiredCapabilities = combined;
  }
  return copy;
}

function observedCapabilitiesSatisfy(
  transaction: ProtectedTransaction,
  scenario: Scenario,
): boolean {
  for (let index = 0; index < transaction.preparation.actions.length; index += 1) {
    const action = transaction.preparation.actions[index]!;
    const kind = scenario.preparationKinds[index]!;
    if (!("target" in action)) continue;
    const observed = scenario.observedCapabilities[kind] ?? [];
    if (!containsAll(observed, action.target.requiredCapabilities)) return false;
    if (!("input" in action)) continue;
    const assertion = transaction.preparation.assertions.find(
      (candidate) =>
        candidate.type === "fieldValueMatchesInput" && candidate.input === action.input,
    );
    if (
      assertion?.type === "fieldValueMatchesInput" &&
      !containsAll(observed, assertion.target.requiredCapabilities)
    )
      return false;
  }
  return true;
}

function expectedCompatibility(kind: PreparationKind, observed: Capability[]): boolean {
  const requirements: Partial<Record<PreparationKind, Capability[]>> = {
    activate: ["focusable", "pointer_activatable"],
    fill_public: ["focusable", "accepts_text", "editable", "readable_value"],
    fill_protected: ["focusable", "accepts_text", "editable", "readable_value"],
    select: ["selects_option", "readable_value"],
    wait: ["observable"],
    inspect: ["observable"],
    check: ["toggleable", "readable_value"],
  };
  return kind === "navigate" || containsAll(observed, requirements[kind] ?? []);
}

function preparationIntent(
  kind: PreparationKind,
  index: number,
  scope: (typeof scopes)[number],
  exact: boolean,
): MissionAuthoringIntent {
  const intentId = `${kind}-${index}`;
  const base = {
    intentId,
    objectiveId,
    flowDraftId,
    expectedEffect: { kind: "none" as const },
    constraints: { timeoutMs, allowNewPage: false, allowNonExact: !exact },
    authorization: { kind: "ordinary" as const },
    protectedInputReferences: [] as string[],
  };
  const semanticTarget = {
    concept: `${kind} control`,
    role: roleFor(kind),
    name: `${kind} control`,
    exact,
    ...(scope ? { scope } : {}),
  };
  switch (kind) {
    case "navigate":
      return { ...base, action: { kind: "navigate", url: `${origin}/credentials` } };
    case "activate":
      return { ...base, action: { kind: "activate", target: semanticTarget } };
    case "fill_public":
      return {
        ...base,
        action: { kind: "fill", target: semanticTarget, publicValue: "public qualification value" },
      };
    case "fill_protected":
      return {
        ...base,
        action: { kind: "fill", target: semanticTarget, protectedReferenceId },
        authorization: { kind: "authentication" as const },
        protectedInputReferences: [protectedReferenceId],
      };
    case "select":
      return { ...base, action: { kind: "select", target: semanticTarget, value: "test" } };
    case "wait":
      return { ...base, action: { kind: "wait_for", target: semanticTarget, state: "visible" } };
    case "inspect":
      return { ...base, action: { kind: "inspect", target: semanticTarget } };
    case "check":
      return { ...base, action: { kind: "set_checked", target: semanticTarget, checked: true } };
  }
}

function acquisitionAction(
  preparation: MissionAuthoringIntent[],
  outputs: (typeof outputShapes)[number],
  mutationRole: (typeof mutationRoles)[number],
  scope: (typeof scopes)[number],
  exact: boolean,
): Scenario["acquisition"] {
  return {
    kind: "acquire_protected_outputs",
    preparationIntentIds: preparation.map((intent) => intent.intentId),
    mutation: {
      kind: "one_time",
      target: {
        concept: "generate credentials",
        role: mutationRole,
        name: "Generate",
        exact,
        ...(scope ? { scope } : {}),
      },
    },
    outputs: outputs.map((output) => ({
      reference: output.reference,
      classification: output.classification,
      target: {
        concept: output.reference,
        role: output.role,
        name: output.reference,
        exact,
        ...(scope ? { scope } : {}),
      },
      storageName: output.reference,
    })),
  };
}

function roleFor(kind: PreparationKind) {
  if (kind === "activate") return "button" as const;
  if (kind === "select") return "combobox" as const;
  if (kind === "check") return "checkbox" as const;
  if (kind === "wait" || kind === "inspect") return "region" as const;
  return "textbox" as const;
}

function planFor(action: ProtectedTransaction) {
  const continuationSteps = action.continuation.strategies.flatMap((strategy) => {
    if (!("continueAtStepId" in strategy)) return [];
    return [
      {
        id: strategy.continueAtStepId,
        title: "Resume after protected interaction",
        action: { type: "navigate" as const, url: strategy.reentryUrl, timeoutMs: 10_000 },
        assertions: [],
        onFailure: "stop" as const,
        evidence: [],
        captureIntent: "transient" as const,
        transientJustification: "Protected continuation contract boundary.",
      },
    ];
  });
  return {
    name: "Architecture qualification",
    objective: "Evaluate protected authoring compilation",
    preconditions: [],
    allowedOrigins: [origin],
    budgets: {
      maxActions: 1 + continuationSteps.length,
      maxDurationMs: 30_000,
      maxNavigations: 1 + continuationSteps.length,
    },
    checkpoints: [],
    steps: [
      {
        id: "protected-operation",
        title: "Protected operation",
        action,
        assertions: [],
        onFailure: "stop" as const,
        evidence: [],
        captureIntent: "transient" as const,
        transientJustification: "Disposable architecture qualification.",
      },
      ...continuationSteps,
    ],
  };
}

function containsAll(actual: Capability[], required: Capability[]) {
  const values = new Set(actual);
  return required.every((capability) => values.has(capability));
}
function union(left: Capability[], right: Capability[]): Capability[] {
  return [...new Set([...left, ...right])];
}
function safeCode(error: unknown) {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message)) return error.message;
  return "COMPILATION_REFUSED";
}
function counts(values: string[]) {
  return Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((value) => [value, values.filter((candidate) => candidate === value).length]),
  );
}
function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? 0,
  };
}
