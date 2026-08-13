export type ProtectedStageDispatchPosition = "pre_dispatch" | "post_dispatch" | "read_only";

export class ProtectedStageTimeoutError extends Error {
  override readonly name = "ProtectedStageTimeoutError";

  constructor(
    readonly stage: string,
    readonly code: string,
    readonly dispatchPosition: ProtectedStageDispatchPosition,
  ) {
    super(code);
  }
}

export class ProtectedStageAbortedError extends Error {
  override readonly name = "ProtectedStageAbortedError";

  constructor(readonly stage: string, readonly reason: unknown) {
    super("PROTECTED_STAGE_ABORTED");
  }
}

/**
 * Gives one externally controlled protected stage a finite owner. This does not
 * pretend to cancel work: callers must still fence every durable late effect.
 */
export async function runProtectedStage<T>(input: {
  stage: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  timeoutCode: string;
  dispatchPosition: ProtectedStageDispatchPosition;
  work: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ProtectedStageTimeoutError(
        input.stage,
        input.timeoutCode,
        input.dispatchPosition,
      );
      controller.abort(error);
      reject(error);
    }, Math.max(0, input.timeoutMs));
    timer.unref?.();
  });

  const aborted = new Promise<never>((_, reject) => {
    if (!input.signal) return;
    const abort = () => {
      const error = new ProtectedStageAbortedError(input.stage, input.signal?.reason);
      controller.abort(error);
      reject(error);
    };
    if (input.signal.aborted) abort();
    else {
      input.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => input.signal?.removeEventListener("abort", abort);
    }
  });

  try {
    // Attaching both handlers contains late rejection without granting late
    // completion any authority after this owner has returned.
    const work = Promise.resolve().then(() => input.work(controller.signal));
    work.then(() => undefined, () => undefined);
    return await Promise.race([work, deadline, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}
