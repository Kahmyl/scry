import { describe, expect, it, vi } from "vitest";

import { SecretRedactor } from "@scry/policy";
import { acquireProtectedResponseValue, beginProtectedResponseEnvelope } from "../src/protected-response-envelope.js";

describe("protected response envelope", () => {
  const output = (concept = "order id") => ({
    reference: "orderId",
    classification: "public",
    storage: { scope: "project", name: "Order ID" },
    acquisition: {
      target: {
        concept,
        requiredCapabilities: [],
        preferredEvidence: {
          roles: [], names: ["id"], labels: [], descriptions: [],
          placeholders: [], inputTypes: [],
        },
        scope: { kind: "page" }, relations: [], prohibited: [], risk: "protected",
        confidence: { requiredFamilies: [] },
      },
      permittedMethods: ["protected_network_value"],
    },
  });

  it("stages only declared values from a same-origin successful GET response", async () => {
    let listener: ((response: unknown) => void) | undefined;
    const page = {
      on: vi.fn((_event, callback) => { listener = callback; }),
      off: vi.fn(),
    };
    const stage = vi.fn().mockResolvedValue(undefined);
    const redactor = new SecretRedactor();
    const envelope = beginProtectedResponseEnvelope(
      page as never,
      ["https://api.example.test"],
      redactor,
      {
        outputs: [output()] as never,
        stage,
      },
    );

    listener?.({
      request: () => ({ method: () => "GET" }),
      url: () => "https://api.example.test/api/orders?limit=1",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      body: async () => Buffer.from(JSON.stringify({ data: { id: "order-safe-id" } })),
    });
    await envelope.settle();

    expect(stage).toHaveBeenCalledWith([{
      reference: "orderId",
      classification: "public",
      name: "Order ID",
      value: "order-safe-id",
      scope: "project",
    }]);
    expect(redactor.redact("order-safe-id")).not.toContain("order-safe-id");
    await envelope.close();
  });

  it("selects the semantically closest and shallowest id without exposing sibling ids", async () => {
    let listener: ((response: unknown) => void) | undefined;
    const page = { on: vi.fn((_event, callback) => { listener = callback; }), off: vi.fn() };
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor());
    listener?.({
      request: () => ({ method: () => "GET" }), url: () => "https://api.example.test/orders/one",
      status: () => 200, headers: () => ({ "content-type": "application/json" }),
      body: async () => Buffer.from(JSON.stringify({ data: { id: "order-id", client: { id: "client-id" }, practitioner: { id: "practitioner-id" } } })),
    });
    await envelope.settle();
    await expect(acquireProtectedResponseValue(page as never, output().acquisition as never)).resolves.toBe("order-id");
    await expect(acquireProtectedResponseValue(page as never, output("client id").acquisition as never)).resolves.toBe("client-id");
    await envelope.close();
  });

  it("preserves genuine ambiguity across equally ranked list items", async () => {
    let listener: ((response: unknown) => void) | undefined;
    const page = { on: vi.fn((_event, callback) => { listener = callback; }), off: vi.fn() };
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor());
    listener?.({
      request: () => ({ method: () => "GET" }), url: () => "https://api.example.test/orders",
      status: () => 200, headers: () => ({ "content-type": "application/json" }),
      body: async () => Buffer.from(JSON.stringify({ data: [{ id: "order-one" }, { id: "order-two" }] })),
    });
    await envelope.settle();
    await expect(acquireProtectedResponseValue(page as never, output().acquisition as never))
      .rejects.toThrow("PROTECTED_RESPONSE_VALUE_AMBIGUOUS");
    await envelope.close();
  });

  it.each([
    [401, "application/json", "PROTECTED_RESPONSE_HTTP_REJECTED"],
    [200, "text/html", "PROTECTED_RESPONSE_NON_JSON"],
  ] as const)("classifies rejected response status %s without reading its body", async (status, contentType, code) => {
    let listener: ((response: unknown) => void) | undefined;
    const page = { on: vi.fn((_event, callback) => { listener = callback; }), off: vi.fn() };
    const body = vi.fn(async () => Buffer.from("forbidden-response-body"));
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor());
    listener?.({
      request: () => ({ method: () => "GET" }), url: () => "https://api.example.test/orders",
      status: () => status, headers: () => ({ "content-type": contentType }), body,
    });
    await envelope.settle();
    await expect(acquireProtectedResponseValue(page as never, output().acquisition as never)).rejects.toThrow(code);
    expect(body).not.toHaveBeenCalled();
    await envelope.close();
  });
});
