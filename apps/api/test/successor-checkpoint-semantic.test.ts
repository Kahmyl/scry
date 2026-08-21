import { afterEach, describe, expect, it, vi } from "vitest";

import {
  waitForSuccessorCheckpointSemanticMatch,
  type SuccessorCheckpointSemanticObservation,
} from "../src/adaptive-sessions/successor-checkpoint-semantic.js";

const restorationUrl = "https://preview.vitract.com/login";

const expected = {
  title: "Vitract",
  controls: [
    { role: "link", name: "Login" },
    { role: "heading", name: "Log in to Vitract" },
    { role: "textbox", name: "Enter your email" },
    { role: "button", name: "Login" },
  ],
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("successor checkpoint semantic readiness", () => {
  it("waits through transient pre-hydration semantics until the exact committed context appears", async () => {
    vi.useFakeTimers();

    const observations: SuccessorCheckpointSemanticObservation[] = [
      {
        url: restorationUrl,
        title: "Vitract",
        controls: [],
      },
      {
        url: restorationUrl,
        title: "Vitract",
        controls: [],
      },
      {
        url: restorationUrl,
        title: "Vitract",
        controls: [...expected.controls],
      },
    ];

    let index = 0;

    const verification = waitForSuccessorCheckpointSemanticMatch({
      restorationUrl,
      expected,
      maximumWaitMs: 5_000,
      pollIntervalMs: 75,

      observe: async () => {
        const value = observations[Math.min(index, observations.length - 1)]!;

        index += 1;

        return value;
      },
    });

    await vi.runAllTimersAsync();

    await expect(verification).resolves.toBeUndefined();

    expect(index).toBe(3);
  });

  it("fails closed when the exact semantic context never appears", async () => {
    await expect(
      waitForSuccessorCheckpointSemanticMatch({
        restorationUrl,
        expected,
        maximumWaitMs: 0,

        observe: async () => ({
          url: restorationUrl,
          title: "Vitract",
          controls: [],
        }),
      }),
    ).rejects.toThrow("SUCCESSOR_CHECKPOINT_SEMANTIC_MISMATCH");
  });

  it("preserves exact ordered-control equality", async () => {
    await expect(
      waitForSuccessorCheckpointSemanticMatch({
        restorationUrl,
        expected,
        maximumWaitMs: 0,

        observe: async () => ({
          url: restorationUrl,
          title: "Vitract",
          controls: [...expected.controls].reverse(),
        }),
      }),
    ).rejects.toThrow("SUCCESSOR_CHECKPOINT_SEMANTIC_MISMATCH");
  });

  it("fails immediately if location changes during readiness", async () => {
    await expect(
      waitForSuccessorCheckpointSemanticMatch({
        restorationUrl,
        expected,
        maximumWaitMs: 5_000,

        observe: async () => ({
          url: "https://preview.vitract.com/",
          title: "Vitract",
          controls: [],
        }),
      }),
    ).rejects.toThrow("SUCCESSOR_CHECKPOINT_LOCATION_MISMATCH");
  });

  it("preserves the previous empty-controls checkpoint semantics", async () => {
    await expect(
      waitForSuccessorCheckpointSemanticMatch({
        restorationUrl,

        expected: {
          title: "Vitract",
          controls: [],
        },

        maximumWaitMs: 0,

        observe: async () => ({
          url: restorationUrl,
          title: "Vitract",
          controls: [],
        }),
      }),
    ).resolves.toBeUndefined();
  });
});
