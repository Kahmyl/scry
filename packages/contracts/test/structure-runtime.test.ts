import { describe, expect, it } from "vitest";
import {
  inspectPraxisStructureResultSchema,
  readPraxisPublicStructureValueInputSchema,
  inspectPraxisRuntimeStateResultSchema,
  readPraxisPublicRuntimeValueInputSchema,
} from "../src/execution-kernel.js";
const authority = {
  referenceVersion: 1 as const,
  pageId: "page-1",
  frameId: "frame-1",
  documentEpoch: 1,
  documentIdentity: "document-1",
};
describe("bounded structure and runtime contracts", () => {
  it("admits opaque metadata and closed structure fields only", () => {
    const result = inspectPraxisStructureResultSchema.parse({
      authority,
      structures: [
        {
          reference: "context-structure-0123456789abcdef0123456789abcdef",
          source: "accessibility",
          role: "button",
          depth: 1,
          childCount: 0,
          readableFields: ["name"],
        },
      ],
      completeness: { kind: "bounded", observed: 1, returned: 1, truncated: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/nodeId|backendNodeId|objectId|html/i);
    expect(() =>
      readPraxisPublicStructureValueInputSchema.parse({
        reference: result.structures[0]!.reference,
        field: "attribute",
      }),
    ).toThrow();
    expect(() =>
      inspectPraxisStructureResultSchema.parse({
        ...result,
        completeness: { ...result.completeness, returned: 0 },
      }),
    ).toThrow();
    expect(
      inspectPraxisStructureResultSchema.parse({
        authority,
        structures: [],
        completeness: { kind: "bounded", observed: 0, returned: 0, truncated: false },
      }).structures,
    ).toEqual([]);
  });
  it("admits opaque runtime metadata and no expression or path input", () => {
    const result = inspectPraxisRuntimeStateResultSchema.parse({
      authority,
      values: [
        {
          reference: "context-runtime-0123456789abcdef0123456789abcdef",
          kind: "object",
          bytes: 2,
          memberCount: 0,
        },
      ],
      completeness: { kind: "bounded", observed: 1, returned: 1, truncated: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/objectId|global|secret/i);
    expect(() =>
      readPraxisPublicRuntimeValueInputSchema.parse({
        reference: result.values[0]!.reference,
        expression: "alert(1)",
      }),
    ).toThrow();
    expect(() =>
      inspectPraxisRuntimeStateResultSchema.parse({
        ...result,
        completeness: { ...result.completeness, truncated: true },
      }),
    ).toThrow();
    expect(
      inspectPraxisRuntimeStateResultSchema.parse({
        authority,
        values: [],
        completeness: { kind: "bounded", observed: 0, returned: 0, truncated: false },
      }).values,
    ).toEqual([]);
  });
});
