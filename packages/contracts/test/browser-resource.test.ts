import { describe, expect, it } from "vitest";

import {
  inspectPraxisBrowserResourcesResultSchema,
  readPraxisPublicResourceInputSchema,
  readPraxisPublicResourceResultSchema,
} from "../src/execution-kernel.js";

const reference = "context-resource-0123456789abcdef0123456789abcdef";
const authority = {
  referenceVersion: 1 as const,
  pageId: "page-1",
  frameId: "frame-1",
  documentEpoch: 1,
  documentIdentity: "document-1",
};

describe("bounded Praxis browser-resource contracts", () => {
  it("returns opaque metadata before a separately bounded public read", () => {
    const inspection = inspectPraxisBrowserResourcesResultSchema.parse({
      authority,
      resources: [{ reference, kind: "json", bytes: 128 }],
      completeness: { kind: "bounded", observed: 1, returned: 1, truncated: false },
    });
    expect(JSON.stringify(inspection)).not.toContain("POST /orders");
    expect(readPraxisPublicResourceInputSchema.parse({ reference })).toEqual({
      reference,
      offset: 0,
      maxBytes: 2048,
    });
    expect(
      readPraxisPublicResourceResultSchema.parse({
        reference,
        classification: "public",
        provenance: authority,
        resource: { kind: "json" },
        text: "{}",
        offset: 0,
        returnedBytes: 2,
        totalBytes: 2,
        truncated: false,
        admission: {
          admissionRevision: 1,
          contentDigest: "a".repeat(64),
          admissionDigest: "b".repeat(64),
        },
      }).text,
    ).toBe("{}");
  });
});
