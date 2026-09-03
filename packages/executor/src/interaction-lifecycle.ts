import type { OperationOutcome } from "@scry/contracts";

export type InteractionPrivacyPhase = "not_started" | "entered" | "verified" | "sealed";

/**
 * Authoritative, per-interaction lifecycle facts.
 *
 * Resolution engines may explain why they failed, but they do not decide
 * whether a mutation crossed dispatch or whether a protected interval was
 * sealed. Those outcomes are derived from phase transitions recorded here.
 */
export class InteractionLifecycleTracker {
  private dispatchStarted = false;
  private dispatchTransition: Promise<void> | undefined;
  private privacyPhase: InteractionPrivacyPhase = "not_started";

  async beforeDispatch(delegate?: () => void | Promise<void>) {
    if (this.dispatchStarted) return;
    if (!this.dispatchTransition) {
      this.dispatchTransition = Promise.resolve()
        .then(() => delegate?.())
        .then(() => {
          this.dispatchStarted = true;
        })
        .catch((error) => {
          this.dispatchTransition = undefined;
          throw error;
        });
    }
    await this.dispatchTransition;
  }

  recordPrivacy(phase: Exclude<InteractionPrivacyPhase, "not_started">) {
    if (this.privacyPhase === "verified" || this.privacyPhase === "sealed") return;
    this.privacyPhase = phase;
  }

  mutationFailure(
    mutating: boolean,
    observed: OperationOutcome["mutationOutcome"],
  ): OperationOutcome["mutationOutcome"] {
    if (!mutating) return "not_applied";
    if (!this.dispatchStarted) return "not_applied";
    if (observed === "applied" || observed === "unknown") return observed;
    return "unknown";
  }

  privacyFailure(fallback: OperationOutcome["privacyResult"]): OperationOutcome["privacyResult"] {
    if (this.privacyPhase === "sealed" || this.privacyPhase === "verified")
      return this.privacyPhase;
    return fallback;
  }

  get facts() {
    return { dispatchStarted: this.dispatchStarted, privacyPhase: this.privacyPhase } as const;
  }
}

/** Typed resolution rejection shared by native drivers and the executor adapter. */
export class NativeControlResolutionError extends Error {
  override readonly name = "NativeControlResolutionError";

  constructor(readonly code: string) {
    super(code);
  }
}

export function isNativeControlResolutionError(
  error: unknown,
): error is NativeControlResolutionError {
  return (
    error instanceof NativeControlResolutionError ||
    (error instanceof Error && error.name === "NativeControlResolutionError")
  );
}
