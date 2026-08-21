import { describe, expect, it, vi } from "vitest";

import { VeilVisualCaptureAuthority } from "../src/visual-capture.js";

const policyDigest = "a".repeat(64);
const binding = {
  browserContextId: "context-1",
  pageId: "page-1",
  frameId: "main",
  documentEpoch: 4,
} as const;
const observation = {
  documentIdentity: "document-1",
  revision: 1,
  regions: [],
} as const;

describe("VeilVisualCaptureAuthority", () => {
  it("authorizes and admits capture from narrow Praxis-observed facts", async () => {
    const authority = new VeilVisualCaptureAuthority(policyDigest);
    const operation = vi.fn(async () => Buffer.from("capture"));
    const { permit } = authority.issue(observation, binding);

    await expect(authority.capture(observation, permit, binding, operation)).resolves.toEqual(
      Buffer.from("capture"),
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(authority.admissionBinding(permit)).toMatchObject({
      maskDigest: permit.maskDigest,
      documentEpoch: binding.documentEpoch,
    });
  });

  it("refuses unproven masks and changed document facts without browser access", () => {
    const authority = new VeilVisualCaptureAuthority(policyDigest);
    expect(() =>
      authority.issue(
        {
          documentIdentity: "document-1",
          revision: 1,
          regions: [{ masked: false }] as never,
        },
        binding,
      ),
    ).toThrowError(expect.objectContaining({ code: "VEIL_CAPTURE_MASK_UNPROVEN" }));

    const { permit } = authority.issue(observation, binding);
    expect(() =>
      authority.validate({ ...observation, documentIdentity: "document-2" }, permit, binding),
    ).toThrowError(expect.objectContaining({ code: "VEIL_CAPTURE_DOCUMENT_CHANGED" }));
  });
});
