import { describe, expect, it } from "vitest";

import * as chronicle from "../src/index.js";

import {
  artifactSha256,
  chronicleEvent,
  prefixedStorageKey,
  requireSafeStorageKey,
} from "../src/index.js";

describe("Chronicle root boundary", () => {
  it("constructs a factual event without requiring a closed event ontology", () => {
    const event = chronicleEvent({
      type: "action.dispatched",

      occurredAt: "2026-08-15T12:00:00.000Z",

      correlation: {
        runId: "run-1",
        operationId: "operation-1",
      },

      payload: {
        dispatchCount: 1,
      },

      artifactRefs: ["scry://artifact/example"],
    });

    expect(event.type).toBe("action.dispatched");

    expect(event.correlation).toEqual({
      runId: "run-1",
      operationId: "operation-1",
    });

    expect(event.artifactRefs).toEqual(["scry://artifact/example"]);
  });

  it("rejects missing event identity", () => {
    expect(() =>
      chronicleEvent({
        type: "   ",
        occurredAt: "2026-08-15T12:00:00.000Z",
      }),
    ).toThrow("CHRONICLE_EVENT_TYPE_REQUIRED");
  });

  it("rejects invalid event time", () => {
    expect(() =>
      chronicleEvent({
        type: "action.dispatched",
        occurredAt: "not-a-time",
      }),
    ).toThrow("CHRONICLE_EVENT_TIME_INVALID");
  });

  it("retains safe artifact storage-key mechanics", () => {
    expect(requireSafeStorageKey("runs/a/trace.zip")).toBe("runs/a/trace.zip");

    expect(() => requireSafeStorageKey("../secret")).toThrow();

    expect(prefixedStorageKey("tenant", "runs/a/trace.zip")).toBe("tenant/runs/a/trace.zip");
  });

  it("provides policy-neutral integrity hashing", () => {
    expect(artifactSha256(new TextEncoder().encode("evidence"))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not expose legacy Veil admission through the root API", () => {
    expect("signVeilEvidenceAdmission" in chronicle).toBe(false);

    expect("requireAdmission" in chronicle).toBe(false);

    expect("VeilEvidenceAdmissionError" in chronicle).toBe(false);
  });
});
