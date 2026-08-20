export interface SuccessorCheckpointSemanticContext {
  readonly title: string;
  readonly controls: readonly {
    readonly role: string;
    readonly name: string;
  }[];
}

export interface SuccessorCheckpointSemanticObservation {
  readonly url: string;
  readonly title: string;
  readonly controls: readonly {
    readonly role: string;
    readonly name: string;
  }[];
}

export async function waitForSuccessorCheckpointSemanticMatch(input: {
  readonly restorationUrl: string;
  readonly expected: SuccessorCheckpointSemanticContext;
  readonly observe: () => Promise<SuccessorCheckpointSemanticObservation>;
  readonly maximumWaitMs?: number;
  readonly pollIntervalMs?: number;
}): Promise<void> {
  const maximumWaitMs = input.maximumWaitMs ?? 5_000;
  const pollIntervalMs = input.pollIntervalMs ?? 75;

  if (!Number.isFinite(maximumWaitMs) || maximumWaitMs < 0)
    throw new Error("SUCCESSOR_CHECKPOINT_SEMANTIC_WAIT_INVALID");

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0)
    throw new Error("SUCCESSOR_CHECKPOINT_SEMANTIC_WAIT_INVALID");

  const deadline = performance.now() + maximumWaitMs;

  while (true) {
    const actual = await input.observe();

    if (actual.url !== input.restorationUrl)
      throw new Error("SUCCESSOR_CHECKPOINT_LOCATION_MISMATCH");

    const titleMatches = !input.expected.title || actual.title === input.expected.title;

    const controlsMatch =
      input.expected.controls.length === 0 ||
      JSON.stringify(actual.controls) === JSON.stringify(input.expected.controls);

    if (titleMatches && controlsMatch) return;

    const remainingMs = deadline - performance.now();

    if (remainingMs <= 0) throw new Error("SUCCESSOR_CHECKPOINT_SEMANTIC_MISMATCH");

    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
