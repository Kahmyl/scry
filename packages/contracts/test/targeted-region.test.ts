import { describe, expect, it } from "vitest";

import {
  createAuthoringRuntimeCommandSchema,
  inspectPraxisRegionInputSchema,
  inspectPraxisRegionResultSchema,
} from "../src/index.js";

const controlReference = "context-control-0123456789abcdef0123456789abcdef";
const valueReference = "context-value-0123456789abcdef0123456789abcdef";

describe("targeted Praxis region contracts", () => {
  it("accepts one strict exact-control request and bounded no-plaintext result", () => {
    expect(
      inspectPraxisRegionInputSchema.parse({ contextControlReference: controlReference }),
    ).toEqual({ contextControlReference: controlReference });

    expect(
      inspectPraxisRegionResultSchema.parse({
        contextControlReference: controlReference,
        authority: {
          referenceVersion: 1,
          pageId: "page-1",
          frameId: "frame-1",
          documentEpoch: 3,
          documentIdentity: "document-identity-1",
        },
        region: { kind: "section" },
        readableValues: [
          {
            reference: valueReference,
            kind: "code",
            classification: "public",
            context: "Create Order",
          },
        ],
        readableValueCompleteness: {
          kind: "bounded",
          observed: 1,
          returned: 1,
          truncated: false,
        },
      }),
    ).not.toHaveProperty("text");
  });

  it("rejects plaintext extensions, inconsistent completeness, and over-bound results", () => {
    const base = {
      contextControlReference: controlReference,
      authority: {
        referenceVersion: 1 as const,
        pageId: "page-1",
        frameId: "frame-1",
        documentEpoch: 3,
        documentIdentity: "document-identity-1",
      },
      region: { kind: "section" as const },
      readableValues: [],
      readableValueCompleteness: {
        kind: "bounded" as const,
        observed: 0,
        returned: 0,
        truncated: false,
      },
    };

    expect(() =>
      inspectPraxisRegionResultSchema.parse({ ...base, plaintext: "region dump" }),
    ).toThrow();
    expect(() =>
      inspectPraxisRegionResultSchema.parse({
        ...base,
        readableValueCompleteness: { ...base.readableValueCompleteness, returned: 1 },
      }),
    ).toThrow();
    expect(() =>
      inspectPraxisRegionResultSchema.parse({
        ...base,
        readableValues: Array.from({ length: 33 }, (_, index) => ({
          reference: `context-value-${index.toString(16).padStart(32, "0")}`,
          kind: "code",
          classification: "public",
        })),
        readableValueCompleteness: {
          kind: "bounded",
          observed: 33,
          returned: 33,
          truncated: false,
        },
      }),
    ).toThrow();
  });

  it("admits inspect_region as an idempotent read-only runtime command payload", () => {
    expect(
      createAuthoringRuntimeCommandSchema.parse({
        missionId: "11111111-1111-4111-8111-111111111111",
        agentSessionId: "22222222-2222-4222-8222-222222222222",
        type: "inspect_region",
        payload: { contextControlReference: controlReference },
        idempotencyKey: "inspect-region-command",
      }),
    ).toMatchObject({ type: "inspect_region" });
  });
});
