import type {
  PraxisAcquisitionOutput,
  PraxisMutationOutcome,
  PraxisOperation,
  PraxisRequest,
  PraxisResolution,
  PraxisVerification,
} from "@scry/contracts";
import type { ElementHandle, Locator, Page } from "playwright";
import {
  armExpectedEffect,
  GroundingError,
  resolveTarget,
  verifyExpectedEffect as verifyObservedEffect,
  validateCandidateResume,
  type GroundingResult,
} from "./grounding.js";
import {
  PRAXIS_PROVIDER_CATALOG,
  PraxisDocumentEpoch,
  PraxisDocumentIdentity,
  PraxisObservationCache,
  PraxisStaleTargetError,
  PraxisTargetHandle,
  observationIdentity,
  type PraxisProviderTiming,
} from "./observation.js";
import { PraxisAdapterError, type PraxisDispatchBoundary } from "./transaction.js";
import { PraxisExecutionEnvelope, type PraxisPreDispatchDeadline } from "./execution-envelope.js";
import { PraxisStateObserver } from "./state-observer.js";
import { validatePraxisVeilGrants } from "./veil-bridge.js";
import { resolveSemanticPageContextControl } from "./page-context.js";

const stateObserver = new PraxisStateObserver();

export type PraxisStrategy =
  | "native_activate"
  | "native_fill"
  | "native_select"
  | "native_check"
  | "computed_activate"
  | "focus_keyboard"
  | "content_editable"
  | "verified_pointer"
  | "canvas_coordinate"
  | "scroll"
  | "inspect"
  | "application_adapter";

export class PraxisGroundedTarget {
  readonly handle: PraxisTargetHandle;
  readonly resolution: PraxisResolution;
  readonly strategy: PraxisStrategy;
  readonly beforeUrl: string;
  readonly providerTimings: readonly PraxisProviderTiming[];
  readonly escalationLevel: number;
  #grounded: GroundingResult;
  #armed: Promise<void> | undefined;

  constructor(
    page: Page,
    grounded: GroundingResult,
    epoch: number,
    documentIdentity: string,
    resolution: PraxisResolution,
    strategy: PraxisStrategy,
    providerTimings: readonly PraxisProviderTiming[],
  ) {
    this.handle = new PraxisTargetHandle(page, grounded.frame, grounded.locator, epoch, documentIdentity);
    this.resolution = resolution;
    this.strategy = strategy;
    this.beforeUrl = page.url();
    this.providerTimings = providerTimings;
    this.escalationLevel = grounded.diagnostic.escalationLevel ?? 1;
    this.#grounded = grounded;
  }
  groundingDiagnostic() {
    return this.#grounded.diagnostic;
  }
  actionPoint() {
    return this.#grounded.actionPoint;
  }
  observationLocators() {
    return this.#grounded.observationLocators ?? [this.#grounded.locator];
  }
  arm(value: Promise<void> | undefined) {
    this.#armed = value;
  }
  armed() {
    return this.#armed;
  }
  async revalidate() {
    await this.#grounded.revalidate();
  }
  toJSON() {
    return {
      handle: this.handle,
      resolution: this.resolution,
      strategy: this.strategy,
      beforeUrl: this.beforeUrl,
    };
  }
}

export class PraxisGroundingEngine {
  constructor(private readonly page: Page) {}

  async resume(
    request: PraxisRequest,
    token: import("@scry/contracts").PraxisResumeToken,
    signal: AbortSignal,
  ) {
    validatePraxisVeilGrants(request);
    checkAbort(signal);

    await validateCandidateResume(this.page, token, request.intent);

    return this.resolve(request, signal);
  }

  async resolve(request: PraxisRequest, signal: AbortSignal) {
    validatePraxisVeilGrants(request);
    checkAbort(signal);
    const contextControl = request.intent.authoritativeReference
      ? resolveSemanticPageContextControl(this.page, request.intent.authoritativeReference)
      : undefined;
    if (
      contextControl?.valueProtected &&
      request.operation.type === "enter_text" &&
      !["known_secret", "captured_secret"].includes(request.operation.input.classification)
    )
      throw new Error("PROTECTED_INPUT_REFERENCE_REQUIRED");
    const started = performance.now();
    const observationDeadline = started + PraxisExecutionEnvelope.groundingWindow(request);
    let stablePendingSince = started;
    let pendingSignature = "";
    let grounded: GroundingResult;
    for (;;) {
      try {
        grounded = await resolveTarget(this.page, request.intent, {
          allowedOrigins: request.policy.allowedOrigins,
          ...(request.operation.type === "wait_for_state" &&
          isSetObservedState(request.operation.state)
            ? {
                cardinality: { kind: "state_observation" as const, state: request.operation.state },
              }
            : {}),
        });
        break;
      } catch (error) {
        const renderPending =
          error instanceof GroundingError &&
          (["CONTROL_INVENTORY_EMPTY", "TARGET_NOT_ACTIONABLE"].includes(error.code) ||
            (["NO_CAPABILITY_COMPATIBLE_CONTROL", "TARGET_SCOPE_NOT_FOUND"].includes(error.code) &&
              performance.now() < Math.min(observationDeadline, started + 500)));
        const waitEvidencePending =
          request.operation.type === "wait_for_state" &&
          error instanceof GroundingError &&
          ["INSUFFICIENT_EVIDENCE", "TARGET_NOT_FOUND"].includes(error.code);
        if (renderPending || waitEvidencePending) {
          const nextSignature = groundingPendingSignature(error);
          if (nextSignature !== pendingSignature) {
            pendingSignature = nextSignature;
            stablePendingSince = performance.now();
          } else if (performance.now() - stablePendingSince >= 1_000) {
            throw error;
          }
        }
        if ((!renderPending && !waitEvidencePending) || performance.now() >= observationDeadline)
          throw error;
        await abortableDelay(Math.min(50, observationDeadline - performance.now()), signal);
      }
    }
    checkAbort(signal);
    const epoch = await PraxisDocumentEpoch.current(this.page, grounded.frame);
    const documentIdentity = await PraxisDocumentIdentity.current(this.page, grounded.frame);
    const fingerprint = grounded.diagnostic.selectedFingerprint!;
    const strategy = selectPraxisStrategy(request.operation, grounded.adapter);
    const resolution: PraxisResolution = {
      target: {
        fingerprint: fingerprint.digest,
        concept: fingerprint.concept,
        scopeKind: fingerprint.scopeKind,
        capabilityDigest: fingerprint.capabilityDigest,
      },
      confidence: grounded.diagnostic.confidence,
      runnerUpMargin: grounded.diagnostic.confidenceMargin,
      evidenceFamilies: grounded.diagnostic.evidenceFamilies ?? [],
      drift: grounded.diagnostic.drift,
      strategy: grounded.adapter,
    };
    const providerTimings = [
      {
        provider: "praxis-unified-grounding",
        durationMs: performance.now() - started,
        outcome: "succeeded" as const,
      },
    ];
    const providerIds = PRAXIS_PROVIDER_CATALOG.map(
      (provider) => `${provider.id}@${provider.version}`,
    );
    const cacheKey = PraxisObservationCache.key({
      scope: request.intent.scope,
      privacyState: request.privacy.state,
      providers: providerIds,
      epoch,
      scoringPolicyVersion: 1,
      adapterVersion: grounded.adapter,
      viewport: this.page.viewportSize(),
    });
    PraxisObservationCache.set(this.page, cacheKey, {
      ...observationIdentity(
        this.page,
        request.intent.scope,
        request.privacy.state,
        epoch,
        grounded.frame,
      ),
      controls: [
        {
          runtimeId: fingerprint.digest,
          fingerprint: fingerprint.digest,
          capabilitiesDigest: fingerprint.capabilityDigest,
          evidence: [],
        },
      ],
      providerTimings,
    });
    return new PraxisGroundedTarget(
      this.page,
      grounded,
      epoch,
      documentIdentity,
      resolution,
      strategy,
      providerTimings,
    );
  }
}

function groundingPendingSignature(error: GroundingError) {
  const diagnostic = error.diagnostic;
  return JSON.stringify({
    code: error.code,
    candidateCount: diagnostic.candidateCount,
    eligibleCount: diagnostic.eligibleCount,
    confidence: diagnostic.confidence,
    confidenceMargin: diagnostic.confidenceMargin,
    selectedFingerprint: diagnostic.selectedFingerprint?.digest,
    distinctions: diagnostic.candidateDistinctions,
    rejectedConstraints: diagnostic.rejectedConstraints,
  });
}

export function selectPraxisStrategy(
  operation: PraxisOperation,
  adapter: GroundingResult["adapter"],
): PraxisStrategy {
  if (
    operation.type === "inspect" ||
    operation.type === "read_value" ||
    operation.type === "wait_for_state"
  )
    return "inspect";
  if (operation.type === "scroll") return "scroll";
  if (adapter === "native_fill") return "native_fill";
  if (adapter === "native_select") return "native_select";
  if (adapter === "native_check") return "native_check";
  if (adapter === "focus_keyboard") return "focus_keyboard";
  if (adapter === "content_editable") return "content_editable";
  if (adapter === "canvas_coordinate") return "canvas_coordinate";
  if (adapter === "application_adapter") return "application_adapter";
  return operation.type === "activate" ? "native_activate" : "computed_activate";
}

type Release = () => void;
const pageMutationTails = new WeakMap<Page, Promise<void>>();
export class PraxisMutationLease {
  static acquireFor(operation: PraxisOperation, page: Page, signal: AbortSignal): Promise<Release> {
    return isMutating(operation) ? this.acquire(page, signal) : Promise.resolve(() => undefined);
  }
  static async acquire(page: Page, signal: AbortSignal): Promise<Release> {
    const previous = pageMutationTails.get(page) ?? Promise.resolve();
    let release!: Release;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    pageMutationTails.set(
      page,
      previous.then(() => current),
    );
    await Promise.race([previous, abortPromise(signal)]);
    if (signal.aborted) {
      release();
      throw new PraxisDispatchCancellation();
    }
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      release();
    };
  }
}

export class PraxisDispatcher {
  constructor(
    private readonly page: Page,
    private readonly resolveInput: (
      reference: string,
      classification: "public" | "known_secret" | "captured_secret" | "captured_public",
    ) => Promise<string>,
    private readonly deadline?: PraxisPreDispatchDeadline,
  ) {}
  async dispatch(
    target: PraxisGroundedTarget,
    request: PraxisRequest,
    signal: AbortSignal,
    boundary: PraxisDispatchBoundary,
  ): Promise<{ mutationOutcome: PraxisMutationOutcome; output?: PraxisAcquisitionOutput }> {
    checkAbort(signal);
    const mutating = isMutating(request.operation);
    let output: PraxisAcquisitionOutput | undefined;
    try {
      const preparedInput = await prepareInput(request, this.resolveInput);
      this.assertBeforeDispatch();
      if (request.operation.type === "wait_for_state") {
        output = await dispatchOperation(
          this.page,
          target.observationLocators()[0]!,
          target,
          request,
          preparedInput,
          signal,
          undefined,
          this.timeout(request.policy.actionTimeoutMs),
        );
        return { mutationOutcome: "not_applied", ...(output ? { output } : {}) };
      }
      await target.handle.reconcile(async (locator) => {
        checkAbort(signal);
        await target.revalidate();
        let activationTarget: ElementHandle<HTMLElement | SVGElement> | undefined;
        if (request.operation.type === "activate") {
          await assertActivationReady(locator, this.timeout(request.policy.actionTimeoutMs));
          await target.revalidate();
          activationTarget =
            (await locator.elementHandle({
              timeout: this.timeout(request.policy.actionTimeoutMs),
            })) ?? undefined;
          if (!activationTarget)
            throw new PraxisAdapterError("PRAXIS_TARGET_CHANGED_BEFORE_ACTION", {
              provenance: "application",
              mutationOutcome: "not_applied",
              retry: "requires_reobservation",
              safeActions: ["reobserve"],
            });
        }
        checkAbort(signal);
        this.assertBeforeDispatch();
        if (mutating) await boundary.beginMutation();
        output = await dispatchOperation(
          this.page,
          locator,
          target,
          request,
          preparedInput,
          signal,
          activationTarget,
          this.timeout(request.policy.actionTimeoutMs),
        );
      });
      return {
        mutationOutcome: mutating ? "applied" : "not_applied",
        ...(output ? { output } : {}),
      };
    } catch (error) {
      if (!boundary.mutationStarted()) {
        try {
          await target.handle.reconcile(async () => target.revalidate());
        } catch (freshnessError) {
          if (
            freshnessError instanceof PraxisStaleTargetError ||
            (freshnessError instanceof GroundingError &&
              freshnessError.code === "TARGET_CHANGED_BEFORE_ACTION")
          )
            throw new PraxisAdapterError("PRAXIS_TARGET_CHANGED_BEFORE_ACTION", {
              provenance: "application",
              retry: "requires_reobservation",
              safeActions: ["reobserve"],
            });
        }
      }
      if (error instanceof PraxisStaleTargetError)
        throw new PraxisAdapterError("PRAXIS_TARGET_CHANGED_BEFORE_ACTION", {
          provenance: "application",
          retry: "requires_reobservation",
          safeActions: ["reobserve"],
        });
      if (signal.aborted || error instanceof PraxisDispatchCancellation)
        throw new PraxisAdapterError("PRAXIS_CANCELLED", { provenance: "cancelled" });
      if (error instanceof PraxisAdapterError) throw error;
      throw new PraxisAdapterError("PRAXIS_DISPATCH_FAILED", { provenance: "application" });
    }
  }

  private timeout(maximum: number) {
    return this.deadline?.timeout(maximum) ?? maximum;
  }

  private assertBeforeDispatch() {
    if (this.deadline?.expired())
      throw new PraxisAdapterError("PRAXIS_PRE_DISPATCH_TIMED_OUT", {
        provenance: "policy",
        retry: "requires_revision",
        mutationOutcome: "not_started",
      });
  }
}

export class PraxisVerifier {
  constructor(
    private readonly page: Page,
    private readonly resolveInput: (
      reference: string,
      classification: "public" | "known_secret" | "captured_secret" | "captured_public",
    ) => Promise<string>,
  ) {}
  armEffect(target: PraxisGroundedTarget, request: PraxisRequest) {
    target.arm(
      armExpectedEffect(this.page, request.expectedEffect, request.policy.actionTimeoutMs),
    );
  }
  async local(
    target: PraxisGroundedTarget,
    request: PraxisRequest,
  ): Promise<PraxisVerification["local"]> {
    if (request.operation.type === "wait_for_state")
      return (await observationSetMatches(target.observationLocators(), request.operation.state))
        ? "passed"
        : "failed";
    if (["inspect", "read_value", "scroll"].includes(request.operation.type)) {
      try {
        await target.handle.readAfterDispatch(async () => target.revalidate());
        return "passed";
      } catch {
        return "failed";
      }
    }
    if (
      !["enter_text", "select_option", "set_checked", "wait_for_state"].includes(
        request.operation.type,
      )
    )
      return "not_required";
    return target.handle.readAfterDispatch(async (locator) => {
      if (request.operation.type === "enter_text")
        return (await stateObserver.readValue(locator)) ===
          (await this.resolveInput(
            request.operation.input.reference,
            request.operation.input.classification,
          ))
          ? "passed"
          : "failed";
      if (request.operation.type === "select_option")
        return (await locator.inputValue()) ===
          (await this.resolveInput(
            request.operation.input.reference,
            request.operation.input.classification,
          ))
          ? "passed"
          : "failed";
      if (request.operation.type === "set_checked")
        return (await stateObserver.checked(locator)) === request.operation.checked
          ? "passed"
          : "failed";
      return "not_required";
    });
  }
  async effect(
    target: PraxisGroundedTarget,
    request: PraxisRequest,
    signal: AbortSignal,
    budgetMs: number,
  ): Promise<PraxisVerification["effect"]> {
    if (request.expectedEffect.type === "none") return "not_required";
    await verifyObservedEffect(
      this.page,
      request.expectedEffect,
      target.beforeUrl,
      budgetMs,
      target.armed(),
      { signal, allowedOrigins: request.policy.allowedOrigins },
    );
    return "passed";
  }
}

async function prepareInput(
  request: PraxisRequest,
  resolveInput: PraxisDispatcher["resolveInput"],
): Promise<string | undefined> {
  if (request.operation.type === "enter_text" || request.operation.type === "select_option")
    return resolveInput(request.operation.input.reference, request.operation.input.classification);
  return undefined;
}
async function dispatchOperation(
  page: Page,
  locator: Locator,
  target: PraxisGroundedTarget,
  request: PraxisRequest,
  preparedInput: string | undefined,
  signal: AbortSignal,
  activationTarget?: ElementHandle<HTMLElement | SVGElement>,
  timeoutMs = request.policy.actionTimeoutMs,
): Promise<PraxisAcquisitionOutput | undefined> {
  const options = { timeout: timeoutMs };
  switch (request.operation.type) {
    case "activate": {
      const point = target.actionPoint();
      if (!activationTarget)
        throw new PraxisAdapterError("PRAXIS_TARGET_CHANGED_BEFORE_ACTION", {
          provenance: "application",
        });
      const receipt = `${request.transactionId}:${request.operationId}`;
      const activationObserved = await armActivationReceipt(page, activationTarget, receipt);
      await activationTarget.click(
        target.strategy === "canvas_coordinate" && point
          ? { ...options, position: point }
          : options,
      );
      if (!(await activationObserved()))
        throw new PraxisAdapterError("PRAXIS_DISPATCH_FAILED", { provenance: "application" });
      break;
    }
    case "enter_text": {
      const value = preparedInput!;
      if (target.strategy === "native_fill") await locator.fill(value, options);
      else {
        await locator.focus(options);
        if (target.strategy === "content_editable")
          await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A", options);
        await page.keyboard.insertText(value);
      }
      break;
    }
    case "select_option":
      await locator.selectOption(preparedInput!, options);
      break;
    case "set_checked":
      await locator.setChecked(request.operation.checked, options);
      break;
    case "press_key":
      await locator.press(request.operation.key, options);
      break;
    case "wait_for_state":
      if (
        !(await waitForObservationSet(
          target.observationLocators(),
          request.operation.state,
          timeoutMs,
          signal,
        ))
      )
        throw new PraxisAdapterError("PRAXIS_LOCAL_STATE_NOT_OBSERVED", {
          provenance: "application",
          mutationOutcome: "not_applied",
          retry: "requires_reobservation",
          safeActions: ["reobserve"],
        });
      break;
    case "scroll":
      if (request.operation.direction === "into_view")
        await locator.scrollIntoViewIfNeeded(options);
      else
        await locator.evaluate(
          (element, direction) =>
            element.scrollBy({
              top:
                direction === "down"
                  ? element.clientHeight
                  : direction === "up"
                    ? -element.clientHeight
                    : 0,
              left:
                direction === "right"
                  ? element.clientWidth
                  : direction === "left"
                    ? -element.clientWidth
                    : 0,
            }),
          request.operation.direction,
        );
      break;
    case "read_value":
      if (request.operation.classification === "public")
        return { classification: "public", value: await stateObserver.readValue(locator) };
      break;
    case "inspect":
      break;
  }
  return undefined;
}

async function observationSetMatches(
  locators: readonly Locator[],
  state: "visible" | "hidden" | "attached" | "detached" | "enabled" | "disabled",
) {
  const attached = await Promise.all(locators.map(async (locator) => (await locator.count()) > 0));
  if (state === "attached") return attached.some(Boolean);
  if (state === "detached") return !attached.some(Boolean);
  const visible = await Promise.all(locators.map((locator) => locator.isVisible()));
  if (state === "visible") return visible.some(Boolean);
  if (state === "hidden") return !visible.some(Boolean);
  const enabled = await Promise.all(locators.map((locator) => locator.isEnabled()));
  return state === "enabled" ? enabled.some(Boolean) : !enabled.some(Boolean);
}

async function waitForObservationSet(
  locators: readonly Locator[],
  state: "visible" | "hidden" | "attached" | "detached" | "enabled" | "disabled",
  timeoutMs: number,
  signal: AbortSignal,
) {
  const deadline = performance.now() + timeoutMs;
  do {
    checkAbort(signal);
    if (await observationSetMatches(locators, state)) return true;
    await abortableDelay(Math.min(25, Math.max(1, deadline - performance.now())), signal);
  } while (performance.now() < deadline);
  return observationSetMatches(locators, state);
}
function isSetObservedState(
  state: "visible" | "hidden" | "attached" | "detached" | "enabled" | "disabled",
): state is "visible" | "attached" {
  return state === "visible" || state === "attached";
}
async function assertActivationReady(locator: Locator, timeoutMs: number) {
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  if (!(await locator.isEnabled()))
    throw new PraxisAdapterError("PRAXIS_TARGET_NOT_ACTIONABLE", {
      provenance: "application",
      mutationOutcome: "not_applied",
      retry: "requires_reobservation",
      safeActions: ["reobserve"],
    });
}
type ActivationReceiptState = { ready: Promise<void>; waiters: Map<string, () => void> };
const activationReceiptStates = new WeakMap<Page, ActivationReceiptState>();
function activationReceiptState(page: Page): ActivationReceiptState {
  const existing = activationReceiptStates.get(page);
  if (existing) return existing;
  const waiters = new Map<string, () => void>();
  const state: ActivationReceiptState = {
    waiters,
    ready: page
      .exposeBinding("__scryPraxisRecordActivation", (_source, key: unknown) => {
        if (typeof key !== "string") return;
        waiters.get(key)?.();
      })
      .then(() => undefined),
  };
  activationReceiptStates.set(page, state);
  return state;
}
async function armActivationReceipt(
  page: Page,
  target: ElementHandle<HTMLElement | SVGElement>,
  receipt: string,
) {
  const state = activationReceiptState(page);
  await state.ready;
  let observed = false;
  let resolveObserved!: () => void;
  const observation = new Promise<void>((resolve) => {
    resolveObserved = resolve;
  });
  state.waiters.set(receipt, () => {
    observed = true;
    resolveObserved();
  });
  try {
    await target.evaluate((element, key) => {
      element.addEventListener(
        "click",
        () => {
          const binding = (
            window as typeof window & {
              __scryPraxisRecordActivation?: (receipt: string) => Promise<void>;
            }
          ).__scryPraxisRecordActivation;
          void binding?.(key);
        },
        { capture: true, once: true },
      );
    }, receipt);
  } catch (error) {
    state.waiters.delete(receipt);
    throw error;
  }
  return async () => {
    if (!observed)
      await Promise.race([observation, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    state.waiters.delete(receipt);
    return observed;
  };
}
function isMutating(operation: PraxisOperation) {
  return ["activate", "enter_text", "select_option", "set_checked", "press_key"].includes(
    operation.type,
  );
}
function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new PraxisDispatchCancellation();
}
function abortPromise(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new PraxisDispatchCancellation());
    else
      signal.addEventListener("abort", () => reject(new PraxisDispatchCancellation()), {
        once: true,
      });
  });
}
class PraxisDispatchCancellation extends Error {}
async function abortableDelay(ms: number, signal: AbortSignal) {
  if (ms <= 0) return;
  await Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
    abortPromise(signal),
  ]);
}
