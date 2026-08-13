import { describe, expect, it } from "vitest";
import { executionPolicyAllowsProtectedSyntheticInput, executionPolicySchema } from "../src/policy.js";

const base = { allowedOrigins: ["https://example.test"] };
const request = { contract: "reserved_test_email", version: 1, purpose: "test_order_qualification", resourceKind: "order", operation: "create" };

describe("protected synthetic execution policy", () => {
  it("defaults old policies to deny", () => {
    const policy = executionPolicySchema.parse(base);
    expect(executionPolicyAllowsProtectedSyntheticInput(policy, request)).toBe(false);
  });

  it("allows only the exact authorized generator, purpose, and resource operation", () => {
    const policy = executionPolicySchema.parse({ ...base, protectedSyntheticInputs: { enabled: true, generators: [{
      contract: request.contract, version: request.version, purposes: [request.purpose],
      resourceScopes: [{ resourceKind: request.resourceKind, operation: request.operation }],
    }] } });
    expect(executionPolicyAllowsProtectedSyntheticInput(policy, request)).toBe(true);
    expect(executionPolicyAllowsProtectedSyntheticInput(policy, { ...request, version: 2 })).toBe(false);
    expect(executionPolicyAllowsProtectedSyntheticInput(policy, { ...request, purpose: "other" })).toBe(false);
    expect(executionPolicyAllowsProtectedSyntheticInput(policy, { ...request, resourceKind: "client" })).toBe(false);
    expect(executionPolicyAllowsProtectedSyntheticInput(policy, { ...request, operation: "update" })).toBe(false);
  });

  it("rejects disabled, empty, malformed, and duplicate declarations", () => {
    expect(() => executionPolicySchema.parse({ ...base, protectedSyntheticInputs: { enabled: false, generators: [] } })).toThrow();
    expect(() => executionPolicySchema.parse({ ...base, protectedSyntheticInputs: { enabled: true, generators: [] } })).toThrow();
    const generator = { contract: request.contract, version: 1, purposes: [request.purpose], resourceScopes: [{ resourceKind: "order", operation: "create" }] };
    expect(() => executionPolicySchema.parse({ ...base, protectedSyntheticInputs: { enabled: true, generators: [generator, generator] } })).toThrow();
  });
});
