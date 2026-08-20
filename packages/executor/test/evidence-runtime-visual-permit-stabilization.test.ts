import { describe, expect, it, vi } from "vitest";

import { VeilVisualCaptureAuthority, VeilVisualCaptureError } from "@scry/veil";

import { captureWithStableVisualPermit } from "../src/evidence-runtime.js";

const policyDigest = "a".repeat(64);

const binding = {
  browserContextId: "context-1",
  pageId: "page-1",
  frameId: "main-frame",
  documentEpoch: 1,
} as const;

const firstObservation = {
  documentIdentity: "https://example.test/page",
  revision: 1,
  regions: [
    {
      regionId: "region-1",
      classification: "sensitive",
      surface: "editable",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      masked: true,
    },
  ],
} as const;

const changedObservation = {
  ...firstObservation,
  revision: 2,
  regions: [
    {
      ...firstObservation.regions[0],
      width: 101,
    },
  ],
} as const;

describe("captureWithStableVisualPermit", () => {
  it("reacquires a fresh permit after one document-change rejection and captures once", async () => {
    const authority = new VeilVisualCaptureAuthority(policyDigest);
    const observe = vi
      .fn()
      .mockResolvedValueOnce(firstObservation)
      .mockResolvedValueOnce(changedObservation)
      .mockResolvedValueOnce(changedObservation)
      .mockResolvedValueOnce(changedObservation);

    const capture = vi.fn(async () => "captured");

    const result = await captureWithStableVisualPermit({
      visualCapture: authority,
      captureBinding: () => binding,
      observe,
      capture,
    });

    expect(result.result).toBe("captured");
    expect(result.stabilizationAttempts).toBe(2);
    expect(result.observation).toEqual(changedObservation);
    expect(observe).toHaveBeenCalledTimes(4);
    expect(capture).toHaveBeenCalledOnce();

    expect(authority.admissionBinding(result.permit)).toMatchObject({
      documentEpoch: binding.documentEpoch,
      maskDigest: result.permit.maskDigest,
    });
  });

  it("fails closed after three consecutive changed-document observations", async () => {
    const authority = new VeilVisualCaptureAuthority(policyDigest);

    const observations = [
      firstObservation,
      changedObservation,
      changedObservation,
      firstObservation,
      firstObservation,
      changedObservation,
    ];

    const observe = vi.fn(async () => {
      const next = observations.shift();
      if (!next) throw new Error("unexpected extra observation");
      return next;
    });

    const capture = vi.fn(async () => "must-not-run");

    await expect(
      captureWithStableVisualPermit({
        visualCapture: authority,
        captureBinding: () => binding,
        observe,
        capture,
      }),
    ).rejects.toMatchObject({
      name: "VeilVisualCaptureError",
      code: "VEIL_CAPTURE_DOCUMENT_CHANGED",
    });

    expect(observe).toHaveBeenCalledTimes(6);
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not retry non-document Veil failures", async () => {
    const authority = {
      issue: vi.fn(() => ({
        permit: { token: "permit-1" },
        regions: [],
      })),
      capture: vi.fn(async () => {
        throw new VeilVisualCaptureError("VEIL_CAPTURE_CONTEXT_MISMATCH", "context mismatch");
      }),
    } as unknown as VeilVisualCaptureAuthority;

    const observe = vi.fn(async () => firstObservation);
    const capture = vi.fn(async () => "must-not-run");

    await expect(
      captureWithStableVisualPermit({
        visualCapture: authority,
        captureBinding: () => binding,
        observe,
        capture,
      }),
    ).rejects.toMatchObject({
      code: "VEIL_CAPTURE_CONTEXT_MISMATCH",
    });

    expect(observe).toHaveBeenCalledTimes(2);
    expect(authority.issue).toHaveBeenCalledOnce();
    expect(authority.capture).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not retry an actual screenshot-operation failure", async () => {
    const authority = new VeilVisualCaptureAuthority(policyDigest);
    const observe = vi.fn(async () => firstObservation);
    const capture = vi.fn(async () => {
      throw new Error("chromium screenshot failed");
    });

    await expect(
      captureWithStableVisualPermit({
        visualCapture: authority,
        captureBinding: () => binding,
        observe,
        capture,
      }),
    ).rejects.toThrow("chromium screenshot failed");

    expect(observe).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledOnce();
  });
});
