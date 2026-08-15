import { VeilChannelCollector } from "./channel-collector.js";

export class VeilClipboardCleanupError extends Error {
  override name = "VeilClipboardCleanupError";
  readonly code = "VEIL_CLIPBOARD_CLEANUP_FAILED";
}

/** Veil-owned lifecycle capsule for clipboard values touched during protected work. */
export class VeilClipboardCollector extends VeilChannelCollector {
  private protectedClipboardTouched = false;

  constructor(
    private readonly clearAndVerify: () => Promise<void>,
    private readonly attempts = 3,
    private readonly attemptTimeoutMs = 1_000,
  ) {
    super("clipboard");
  }

  markProtectedClipboardTouched(): void {
    this.protectedClipboardTouched = true;
  }

  override async finalize(): Promise<void> {
    if (this.protectedClipboardTouched) {
      let failure: unknown;
      for (let attempt = 0; attempt < this.attempts; attempt += 1) {
        try {
          await boundedCleanup(this.clearAndVerify(), this.attemptTimeoutMs);
          this.protectedClipboardTouched = false;
          failure = undefined;
          break;
        } catch (error) {
          failure = error;
        }
      }
      if (failure)
        throw new VeilClipboardCleanupError(
          `Veil could not verify protected clipboard destruction: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
    }
    await super.finalize();
  }
}

async function boundedCleanup<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("VEIL_CLIPBOARD_CLEANUP_TIMEOUT")), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    work.then(() => undefined, () => undefined);
  }
}
