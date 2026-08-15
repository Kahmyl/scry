import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  networkCalls: 0,
  networkAvailable: false,
  resolveTarget: undefined as undefined | ((target: any) => Promise<any>),
}));

vi.mock("../src/protected-response-envelope.js", () => ({
  acquireProtectedResponseValue: vi.fn(async () => {
    state.networkCalls += 1;
    if (!state.networkAvailable) throw new Error("PROTECTED_RESPONSE_NOT_OBSERVED");
    return "NETWORK_ORDER_ID";
  }),
}));

vi.mock("@scry/praxis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scry/praxis")>();
  return {
    ...actual,
    resolveTarget: vi.fn(async (_page: unknown, target: unknown) => {
      if (!state.resolveTarget) throw new Error("TEST_RESOLVER_UNCONFIGURED");
      return state.resolveTarget(target);
    }),
  };
});

import { acquireValue } from "../src/protected-extractor.js";

const never = () => new Promise<never>(() => undefined);
const target = (concept = "order id") => ({
  concept,
  requiredCapabilities: ["readable_value" as const],
  preferredEvidence: {
    roles: ["value" as const], names: ["id"], labels: [], descriptions: [],
    placeholders: [], inputTypes: [],
  },
  scope: { kind: "page" as const },
  relations: [], prohibited: [], risk: "protected" as const,
  confidence: { requiredFamilies: [] },
});
const locator = (overrides: Record<string, unknown> = {}) => ({
  evaluate: vi.fn(async () => ""),
  inputValue: vi.fn(async () => ""),
  textContent: vi.fn(async () => ""),
  elementHandle: vi.fn(async () => null),
  locator: vi.fn(() => ({
    getByRole: vi.fn(() => ({
      count: vi.fn(async () => 0),
      click: vi.fn(async () => undefined),
    })),
  })),
  ...overrides,
});
const page = {
  locator: vi.fn(() => locator()),
  evaluate: vi.fn(async () => ""),
  keyboard: { press: vi.fn(async () => undefined) },
};
const acquisition = (methods: Array<"semantic_field_value" | "input_value" | "text_content" | "copy_control" | "protected_network_value">, prohibited = false) => ({
  target: target(),
  ...(prohibited ? { prohibitedSourceTargets: [target("protected input")] } : {}),
  classification: "public" as const,
  permittedMethods: methods,
  objective: { kind: "capture_value" as const, expectedValueType: "public" as const },
  validation: { minimumLength: 1, maximumLength: 200 },
});

describe("protected acquisition subordinate deadline ownership", () => {
  beforeEach(() => {
    state.networkCalls = 0;
    state.networkAvailable = false;
    state.resolveTarget = undefined;
  });

  it("rechecks protected network acquisition after semantic target resolution stalls", async () => {
    state.resolveTarget = async () => {
      state.networkAvailable = true;
      return never();
    };
    const result = await acquireValue(page as never, acquisition([
      "semantic_field_value", "protected_network_value",
    ]), 120);
    expect(result).toMatchObject({
      value: "NETWORK_ORDER_ID",
      result: { adapter: "protected_network_value" },
    });
    expect(state.networkCalls).toBeGreaterThan(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "semantic_field_value", lastFailureCode: "ACQUISITION_METHOD_TIMEOUT" }),
    ]));
  });

  it("rechecks protected network acquisition after prohibited-source resolution stalls", async () => {
    const candidate = locator({
      elementHandle: vi.fn(async () => ({
        evaluate: vi.fn(async () => false),
        dispose: vi.fn(async () => undefined),
      })),
    });
    state.resolveTarget = async (candidateTarget) => {
      if (candidateTarget.concept === "protected input") {
        state.networkAvailable = true;
        return never();
      }
      return { locator: candidate };
    };
    const result = await acquireValue(page as never, acquisition([
      "semantic_field_value", "protected_network_value",
    ], true), 120);
    expect(result).toMatchObject({ value: "NETWORK_ORDER_ID", result: { adapter: "protected_network_value" } });
    expect(state.networkCalls).toBeGreaterThan(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "semantic_field_value", lastFailureCode: "ACQUISITION_METHOD_TIMEOUT" }),
    ]));
  });

  it("rechecks protected network acquisition after input value reading stalls", async () => {
    let releaseLateInput!: (value: string) => void;
    const lateInput = new Promise<string>((resolve) => { releaseLateInput = resolve; });
    const candidate = locator({
      inputValue: vi.fn(() => {
        state.networkAvailable = true;
        return lateInput;
      }),
    });
    state.resolveTarget = async () => ({ locator: candidate });
    const result = await acquireValue(page as never, acquisition([
      "semantic_field_value", "input_value", "protected_network_value",
    ]), 160);
    expect(result).toMatchObject({ value: "NETWORK_ORDER_ID", result: { adapter: "protected_network_value" } });
    expect(state.networkCalls).toBeGreaterThan(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "input_value", lastFailureCode: "ACQUISITION_METHOD_TIMEOUT" }),
    ]));
    releaseLateInput("LATE_PROTECTED_FALLBACK_VALUE");
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(result)).not.toContain("LATE_PROTECTED_FALLBACK_VALUE");
  });

  it("rechecks protected network acquisition after pinned copy-control preparation stalls", async () => {
    const copy = {
      count: vi.fn(async () => 1),
      elementHandle: vi.fn(() => {
        state.networkAvailable = true;
        return never();
      }),
    };
    const candidate = locator({
      locator: vi.fn(() => ({ getByRole: vi.fn(() => copy) })),
    });
    state.resolveTarget = async () => ({ locator: candidate });
    const result = await acquireValue(page as never, acquisition([
      "semantic_field_value", "input_value", "text_content", "copy_control",
      "protected_network_value",
    ]), 200);
    expect(result).toMatchObject({ value: "NETWORK_ORDER_ID", result: { adapter: "protected_network_value" } });
    expect(state.networkCalls).toBeGreaterThan(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "copy_control", lastFailureCode: "ACQUISITION_METHOD_TIMEOUT" }),
    ]));
  });

  it("terminates boundedly with method-specific diagnostics when network and fallback never settle", async () => {
    state.resolveTarget = async () => never();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const started = performance.now();
    try {
      const result = await acquireValue(page as never, acquisition([
        "semantic_field_value", "protected_network_value",
      ]), 100);
      expect(performance.now() - started).toBeLessThan(250);
      expect(result.result).toBeUndefined();
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "semantic_field_value", lastFailureCode: "ACQUISITION_METHOD_TIMEOUT" }),
      ]));
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
