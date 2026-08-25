export type ObservationRuntimeReadinessOptions = {
  timeoutMs: number;
  retryIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export async function waitForHealthyObservationRuntime<T extends { healthy: boolean }>(
  verify: () => Promise<T>,
  options: ObservationRuntimeReadinessOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 0;
  const retryIntervalMs = Number.isFinite(options.retryIntervalMs)
    ? Math.max(1, options.retryIntervalMs)
    : 1;

  const startedAt = now();

  while (true) {
    const attestation = await verify();

    if (attestation.healthy) {
      return attestation;
    }

    const elapsedMs = Math.max(0, now() - startedAt);
    const remainingMs = timeoutMs - elapsedMs;

    if (remainingMs <= 0) {
      return attestation;
    }

    await sleep(Math.min(retryIntervalMs, remainingMs));
  }
}
