import { createHash, randomUUID } from "node:crypto";

import type { CurrentPlan, ExecutionPolicy, InteractionTargetIntent } from "@scry/contracts";
import {
  browserObservationRuntimeHealth,
  executePraxisConsumer,
  playwrightBrowserChannel,
  registerPraxisVeilAuthority,
} from "@scry/praxis";
import { VeilAuthority } from "@scry/veil";
import { chromium } from "playwright";

import { executePlan } from "./executor.js";
import { resolveVeilPolicyForExecution } from "./execution-veil-policy.js";
import type { BrowserStorageState } from "./types.js";

export type ProbeExecutionLevel = "inspection" | "reversible" | "calibration_transaction";

export type ProbeExecutionResult = {
  allResolved: boolean;
  runtimeHealthy: boolean;
  targets: Array<Record<string, unknown>>;
  readiness: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  pageFingerprint: string;
  authenticationFingerprint?: string;
  execution?: Record<string, unknown>;
};

export async function probeFlowPlan(input: {
  plan: CurrentPlan;
  level: ProbeExecutionLevel;
  policy: ExecutionPolicy;
  browserChannel: string;
  outputDirectory: string;
  privacy: {
    environmentId: string;
    veilAdmissionKey: string;
  };
  secretResolver?: (reference: string) => Promise<string>;
  captureBrowserState?: (state: BrowserStorageState) => void | Promise<void>;
}): Promise<ProbeExecutionResult> {
  if (!input.privacy.environmentId) {
    throw new Error("PROBE_ENVIRONMENT_REQUIRED");
  }

  if (!input.privacy.veilAdmissionKey) {
    throw new Error("VEIL_ADMISSION_KEY_REQUIRED");
  }

  const runtime = browserObservationRuntimeHealth();

  if (!runtime.healthy) {
    return {
      allResolved: false,
      runtimeHealthy: false,
      targets: [],
      readiness: [],
      diagnostics: runtime.diagnostics,
      pageFingerprint: hash("runtime-unhealthy"),
    };
  }

  if (input.level !== "inspection") {
    const steps =
      input.level === "reversible"
        ? input.plan.steps.filter((step) => reversible(step.action))
        : input.plan.steps;

    const options = {
      plan: {
        ...input.plan,
        steps,
      },
      policy: input.policy,
      outputDirectory: input.outputDirectory,
      browserChannel: input.browserChannel,
      environmentId: input.privacy.environmentId,
      veilAdmissionKey: input.privacy.veilAdmissionKey,
      ...(input.secretResolver
        ? {
            secretResolver: input.secretResolver,
          }
        : {}),
      ...(input.captureBrowserState
        ? {
            captureBrowserState: input.captureBrowserState,
          }
        : {}),
    };

    const report = await executePlan(options);

    const diagnostics = report.steps.flatMap((step) =>
      step.action.status === "failed" || step.readiness?.status === "failed"
        ? [
            {
              code: step.action.error ?? step.readiness?.error ?? "PROBE_STEP_FAILED",
              stepId: step.id,
              channel: step.action.status === "failed" ? "target" : "readiness",
            },
          ]
        : [],
    );

    return {
      allResolved: report.state === "passed",
      runtimeHealthy: report.state !== "infrastructure_error",
      targets: report.steps.map((step) => ({
        stepId: step.id,
        status: step.action.status,
      })),
      readiness: report.steps.map((step) => ({
        stepId: step.id,
        ...step.readiness,
      })),
      diagnostics,
      pageFingerprint: hash({
        state: report.state,
        steps: report.steps.map((step) => [step.id, step.action.status, step.readiness?.status]),
      }),
      execution: {
        state: report.state,
        outcomeClassification: report.outcomeClassification,
      },
    };
  }

  const browserChannel = playwrightBrowserChannel(input.browserChannel);

  const browser = await chromium.launch({
    headless: true,
    ...(browserChannel
      ? {
          channel: browserChannel,
        }
      : {}),
  });

  const targets: Array<Record<string, unknown>> = [];
  const readiness: Array<Record<string, unknown>> = [];
  const diagnostics: Array<Record<string, unknown>> = [];

  const page = await browser.newPage();

  const unregisterPraxisVeil = registerPraxisVeilAuthority(page, {
    authority: new VeilAuthority(resolveVeilPolicyForExecution(input.policy)),
    userId: "probe",
    environmentId: input.privacy.environmentId,
    browserContextId: `probe-${randomUUID()}`,
  });

  const pageErrors: string[] = [];

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  try {
    for (const [stepIndex, step] of input.plan.steps.entries()) {
      if (step.action.type === "navigate") {
        await page
          .goto(step.action.url, {
            waitUntil: "domcontentloaded",
          })
          .catch((error) => {
            diagnostics.push({
              code: "PROBE_NAVIGATION_FAILED",
              stepId: step.id,
              message: safe(error),
            });
          });

        continue;
      }

      const target = actionTarget(step.action);

      if (target) {
        const diagnosticStart = diagnostics.length;

        const resolved = await inspectTarget(
          page,
          step.id,
          "action",
          stepIndex,
          target,
          input.plan.allowedOrigins,
          targets,
          diagnostics,
        );

        const expectedVisibleTarget = visibilityChangeTarget(step.action);

        if (!resolved && expectedVisibleTarget) {
          const expectedEffectTargets: Array<Record<string, unknown>> = [];
          const expectedEffectDiagnostics: Array<Record<string, unknown>> = [];

          const expectedEffectAlreadySatisfied = await inspectTarget(
            page,
            step.id,
            "expected_effect",
            stepIndex,
            expectedVisibleTarget,
            input.plan.allowedOrigins,
            expectedEffectTargets,
            expectedEffectDiagnostics,
          );

          if (expectedEffectAlreadySatisfied) {
            diagnostics.splice(diagnosticStart);

            targets.push({
              stepId: step.id,
              channel: "action",
              status: "redundant",
              reason: "expected_effect_already_satisfied",
              expectedEffectTarget: expectedEffectTargets[0]?.fingerprint,
            });
          }
        }
      }

      for (const [conditionIndex, condition] of (step.after?.conditions ?? []).entries()) {
        const candidate = "target" in condition ? condition.target : undefined;

        if (candidate) {
          await inspectTarget(
            page,
            step.id,
            "readiness",
            conditionIndex,
            candidate,
            input.plan.allowedOrigins,
            readiness,
            diagnostics,
          );
        }
      }
    }

    for (const message of pageErrors) {
      diagnostics.push({
        code: message.includes("__name") ? "BROWSER_RUNTIME_UNHEALTHY" : "PAGE_RUNTIME_ERROR",
        message,
      });
    }

    return {
      allResolved: diagnostics.length === 0,
      runtimeHealthy: !pageErrors.some((item) => item.includes("__name")),
      targets,
      readiness,
      diagnostics,
      pageFingerprint: hash({
        url: page.url(),
        targets: targets.map((item) => item.fingerprint),
      }),
    };
  } finally {
    unregisterPraxisVeil();
    await browser.close();
  }
}

async function inspectTarget(
  page: import("playwright").Page,
  stepId: string,
  channel: string,
  ordinal: number,
  target: InteractionTargetIntent,
  allowedOrigins: string[],
  output: Array<Record<string, unknown>>,
  diagnostics: Array<Record<string, unknown>>,
): Promise<boolean> {
  const result = await executePraxisConsumer({
    page,
    intent: target,
    operation: {
      type: "inspect",
    },
    context: {
      stepId,
      channel: "probe",
      ordinal,
      allowedOrigins,
      timeoutMs: 10_000,
    },
    signal: new AbortController().signal,
  });

  if (result.status === "succeeded") {
    output.push({
      stepId,
      channel,
      status: "resolved",
      confidence: result.resolution.confidence,
      confidenceMargin: result.resolution.runnerUpMargin,
      fingerprint: result.resolution.target,
      strategy: result.resolution.strategy,
    });

    return true;
  }

  diagnostics.push({
    code: result.code,
    stepId,
    channel,
    provenance: result.provenance,
    retry: result.retry,
    mutationOutcome: result.mutationOutcome,
    safeActions: result.safeActions,
  });

  return false;
}

function actionTarget(
  action: CurrentPlan["steps"][number]["action"],
): InteractionTargetIntent | undefined {
  return "target" in action ? (action.target as InteractionTargetIntent) : undefined;
}

function visibilityChangeTarget(
  action: CurrentPlan["steps"][number]["action"],
): InteractionTargetIntent | undefined {
  if (action.type !== "click") {
    return undefined;
  }

  if (action.expectedEffect.type !== "visibility_change" || !action.expectedEffect.visible) {
    return undefined;
  }

  return action.expectedEffect.target;
}

function reversible(action: CurrentPlan["steps"][number]["action"]) {
  if (
    [
      "navigate",
      "fill",
      "select",
      "check",
      "press",
      "scroll",
      "waitFor",
      "screenshot",
      "capturePublicValue",
    ].includes(action.type)
  ) {
    return true;
  }

  if (action.type === "click") {
    return (
      action.target.risk === "read_only" ||
      action.expectedEffect.type === "none" ||
      action.expectedEffect.type === "visibility_change" ||
      action.expectedEffect.type === "state_change"
    );
  }

  return false;
}

function safe(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);

  return /^[A-Z][A-Z0-9_:-]*$/.test(value) ? value : "PROBE_DEPENDENCY_FAILURE";
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
