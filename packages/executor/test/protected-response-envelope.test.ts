import { describe, expect, it, vi } from "vitest";
import { SecretRedactor } from "@scry/policy";
import { acquireProtectedResponseValue, beginProtectedResponseEnvelope } from "../src/protected-response-envelope.js";

type Listener = (value: any) => void;

class MockPage {
  listeners = new Map<string, Set<Listener>>();
  on = vi.fn((event: string, listener: Listener) => {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  });
  off = vi.fn((event: string, listener: Listener) => this.listeners.get(event)?.delete(listener));
  emit(event: string, value: any) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function request(input: { url?: string; method?: string; resourceType?: string; redirectedFrom?: any } = {}) {
  let redirectedTo: any;
  const value = {
    method: () => input.method ?? "GET",
    resourceType: () => input.resourceType ?? "fetch",
    url: () => input.url ?? "https://api.example.test/orders",
    redirectedFrom: () => input.redirectedFrom ?? null,
    redirectedTo: () => redirectedTo ?? null,
    setRedirectedTo(next: any) { redirectedTo = next; },
  };
  input.redirectedFrom?.setRedirectedTo(value);
  return value;
}

function response(owner: any, body: unknown, input: { url?: string; status?: number; contentType?: string; body?: () => Promise<Buffer> } = {}) {
  return {
    request: () => owner,
    url: () => input.url ?? owner.url(),
    status: () => input.status ?? 200,
    headers: () => ({ "content-type": input.contentType ?? "application/json" }),
    body: input.body ?? (async () => Buffer.from(JSON.stringify(body))),
  };
}

const output = (concept = "order id") => ({
  reference: "orderId", classification: "public",
  storage: { scope: "project", name: "Order ID" },
  acquisition: {
    target: {
      concept, requiredCapabilities: [],
      preferredEvidence: { roles: [], names: ["id"], labels: [], descriptions: [], placeholders: [], inputTypes: [] },
      scope: { kind: "page" }, relations: [], prohibited: [], risk: "protected",
      confidence: { requiredFamilies: [] },
    },
    permittedMethods: ["protected_network_value"],
  },
});

function capture(page: MockPage, envelope: ReturnType<typeof beginProtectedResponseEnvelope>, ...requests: any[]) {
  envelope.beginActionCapture();
  for (const owned of requests) page.emit("request", owned);
  envelope.endActionCapture();
}

describe("protected response envelope request lineage", () => {
  it("owns only the exact authored mutation method, safe route template, and transport", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [output()] as never,
      stage,
      request: { method: "POST", pathTemplate: "/api/v1/partner-api/orders", transports: ["fetch"] },
    });
    const exact = request({
      method: "POST", resourceType: "fetch",
      url: "https://api.example.test/api/v1/partner-api/orders",
    });
    capture(page, envelope, exact);
    page.emit("response", response(exact, { data: { id: "CREATED_ORDER" } }));
    await expect(envelope.waitForRequestInitiation(1)).resolves.toMatchObject({
      status: "initiated", method: "POST", resourceType: "fetch",
    });
    await expect(envelope.settle(100)).resolves.toBe(true);
    expect(stage).toHaveBeenCalledOnce();
    await envelope.close();
  });

  it.each([
    ["GET", "fetch", "/api/v1/partner-api/orders"],
    ["POST", "xhr", "/api/v1/partner-api/orders"],
    ["POST", "fetch", "/api/v1/partner-api/clients"],
  ])("does not own a neighboring request with method=%s transport=%s path=%s", async (method, resourceType, path) => {
    const page = new MockPage();
    const body = vi.fn(async () => Buffer.from(JSON.stringify({ id: "UNRELATED" })));
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [output()] as never,
      stage: vi.fn(),
      request: { method: "POST", pathTemplate: "/api/v1/partner-api/orders", transports: ["fetch"] },
    });
    const unrelated = request({ method, resourceType, url: `https://api.example.test${path}` });
    capture(page, envelope, unrelated);
    page.emit("response", response(unrelated, {}, { body }));
    await expect(envelope.waitForRequestInitiation(1)).resolves.toMatchObject({
      status: "outside_envelope", method, resourceType,
    });
    await envelope.settle(10);
    expect(body).not.toHaveBeenCalled();
    await envelope.close();
  });

  it("matches protected path segments internally without emitting their value", async () => {
    const page = new MockPage();
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      request: { method: "GET", pathTemplate: "/orders/{protected-id}", transports: ["fetch"] },
    });
    const exact = request({ url: "https://api.example.test/orders/SECRET_ORDER_ID" });
    capture(page, envelope, exact);
    expect(await envelope.waitForRequestInitiation(1)).toMatchObject({ status: "initiated" });
    expect(JSON.stringify(envelope.evidence())).not.toContain("SECRET_ORDER_ID");
    page.emit("requestfailed", exact);
    await envelope.settle(10);
    await envelope.close();
  });

  it("stages exactly once after final aggregate analysis for one owned root", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const redactor = new SecretRedactor();
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], redactor, {
      outputs: [output()] as never, stage,
    });
    const owned = request();
    capture(page, envelope, owned);
    page.emit("response", response(owned, { data: [{ id: "ORDER_ID_CANARY" }] }));
    await expect(envelope.settle(100)).resolves.toBe(true);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledWith([expect.objectContaining({ value: "ORDER_ID_CANARY" })]);
    await expect(acquireProtectedResponseValue(page as never, output().acquisition as never)).resolves.toBe("ORDER_ID_CANARY");
    expect(envelope.evidence()).toMatchObject({
      ownershipStatus: "unique", capturedRootCount: "one", ownedLineageCount: "one",
      stagingStatus: "success", declaredSemanticLeafMatchCount: "one",
    });
    expect(JSON.stringify(envelope.evidence())).not.toContain("ORDER_ID_CANARY");
    expect(redactor.redact("ORDER_ID_CANARY")).not.toContain("ORDER_ID_CANARY");
    await envelope.close();
  });

  it("ignores a response whose exact Request was never captured even when its URL is identical", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [output()] as never, stage,
    });
    const owned = request();
    const unownedSameUrl = request();
    capture(page, envelope, owned);
    const unownedBody = vi.fn(async () => Buffer.from(JSON.stringify({ id: "UNOWNED" })));
    page.emit("response", response(unownedSameUrl, {}, { body: unownedBody }));
    page.emit("response", response(owned, { id: "OWNED" }));
    await envelope.settle(100);
    expect(unownedBody).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledOnce();
    await expect(acquireProtectedResponseValue(page as never, output().acquisition as never)).resolves.toBe("OWNED");
    expect(envelope.evidence().ignoredUnownedResponseCount).toBe(1);
    await envelope.close();
  });

  it("does not own background traffic before action capture", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [output()] as never, stage,
    });
    const background = request();
    page.emit("request", background);
    const action = request();
    capture(page, envelope, action);
    const backgroundBody = vi.fn(async () => Buffer.from(JSON.stringify({ id: "BACKGROUND" })));
    page.emit("response", response(background, {}, { body: backgroundBody }));
    page.emit("response", response(action, { id: "ACTION" }));
    await envelope.settle(100);
    expect(backgroundBody).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledWith([expect.objectContaining({ value: "ACTION" })]);
    await envelope.close();
  });

  it.each(["distinct", "identical", "only_one_matches"] as const)(
    "fails closed with zero staging for two independent roots: %s",
    async (scenario) => {
      const page = new MockPage();
      const stage = vi.fn();
      const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
        outputs: [output()] as never, stage,
      });
      const first = request();
      const second = request();
      capture(page, envelope, first, second);
      page.emit("response", response(first, { id: "FIRST" }));
      page.emit("response", response(second, scenario === "only_one_matches" ? { status: "ok" } : { id: scenario === "identical" ? "FIRST" : "SECOND" }));
      await expect(envelope.waitForRequestInitiation(1)).resolves.toEqual({ status: "lineage_ambiguous" });
      await expect(envelope.settle(100)).resolves.toBe(true);
      await expect(acquireProtectedResponseValue(page as never, output().acquisition as never))
        .rejects.toThrow("PROTECTED_REQUEST_LINEAGE_AMBIGUOUS");
      expect(stage).not.toHaveBeenCalled();
      expect(envelope.evidence()).toMatchObject({ ownershipStatus: "ambiguous", capturedRootCount: "many" });
      await envelope.close();
    },
  );

  it("never enters a slow stage callback for simultaneous ambiguous bodies", async () => {
    const page = new MockPage();
    const stage = vi.fn(async () => new Promise<void>(() => undefined));
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [output()] as never, stage,
    });
    const first = request();
    const second = request();
    capture(page, envelope, first, second);
    page.emit("response", response(first, { id: "FIRST" }));
    page.emit("response", response(second, { id: "SECOND" }));
    await envelope.settle(20);
    expect(stage).not.toHaveBeenCalled();
    await envelope.close();
  });

  it("fails semantic collision within one lineage before staging", async () => {
    const page = new MockPage();
    const stage = vi.fn();
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [output()] as never, stage,
    });
    const owned = request();
    capture(page, envelope, owned);
    page.emit("response", response(owned, { id: "FIRST" }));
    page.emit("response", response(owned, { id: "SECOND" }));
    await envelope.settle(100);
    expect(stage).not.toHaveBeenCalled();
    await expect(acquireProtectedResponseValue(page as never, output().acquisition as never))
      .rejects.toThrow("PROTECTED_RESPONSE_VALUE_AMBIGUOUS");
    await envelope.close();
  });

  it("keeps same-origin redirect descendants in one lineage and ignores intermediate semantics", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [output()] as never, stage,
    });
    const root = request({ url: "https://api.example.test/start" });
    envelope.beginActionCapture();
    page.emit("request", root);
    envelope.endActionCapture();
    const redirected = request({ url: "https://api.example.test/final", redirectedFrom: root });
    page.emit("request", redirected);
    page.emit("response", response(root, {}, { status: 302, contentType: "text/html" }));
    page.emit("response", response(redirected, { id: "FINAL" }));
    await envelope.settle(100);
    expect(stage).toHaveBeenCalledOnce();
    await expect(acquireProtectedResponseValue(page as never, output().acquisition as never)).resolves.toBe("FINAL");
    expect(envelope.evidence()).toMatchObject({ redirectHopCount: 1, capturedRootCount: "one" });
    await envelope.close();
  });

  it("allows an explicitly allowed cross-origin redirect lineage", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://a.example.test", "https://b.example.test"], new SecretRedactor(), {
      outputs: [output()] as never, stage,
    });
    const root = request({ url: "https://a.example.test/start" });
    capture(page, envelope, root);
    const redirected = request({ url: "https://b.example.test/final", redirectedFrom: root });
    page.emit("request", redirected);
    page.emit("response", response(root, {}, { status: 302, contentType: "text/html" }));
    page.emit("response", response(redirected, { id: "FINAL" }));
    await envelope.settle(100);
    expect(stage).toHaveBeenCalledOnce();
    await envelope.close();
  });

  it("rejects a forbidden-origin redirect lineage without reading its final body", async () => {
    const page = new MockPage();
    const stage = vi.fn();
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://a.example.test"], new SecretRedactor(), {
      outputs: [output()] as never, stage,
    });
    const root = request({ url: "https://a.example.test/start" });
    capture(page, envelope, root);
    const redirected = request({ url: "https://forbidden.example.test/final", redirectedFrom: root });
    page.emit("request", redirected);
    const finalBody = vi.fn(async () => Buffer.from(JSON.stringify({ id: "FORBIDDEN" })));
    page.emit("response", response(root, {}, { status: 302, contentType: "text/html" }));
    page.emit("response", response(redirected, {}, { url: redirected.url(), body: finalBody }));
    await envelope.settle(100);
    expect(finalBody).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    await expect(acquireProtectedResponseValue(page as never, output().acquisition as never))
      .rejects.toThrow("PROTECTED_REQUEST_LINEAGE_REJECTED");
    await envelope.close();
  });

  it("waits for a uniquely owned initiated request response lifecycle", async () => {
    const page = new MockPage();
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor());
    const owned = request();
    capture(page, envelope, owned);
    let completed = false;
    const settlement = envelope.settle(200).then((value) => { completed = true; return value; });
    await Promise.resolve();
    expect(completed).toBe(false);
    page.emit("response", response(owned, { id: "VALUE" }));
    await expect(settlement).resolves.toBe(true);
    await envelope.close();
  });

  it("discards a late owned body after settlement expiry and never stages", async () => {
    const page = new MockPage();
    const stage = vi.fn();
    let release!: (value: Buffer) => void;
    const body = new Promise<Buffer>((resolve) => { release = resolve; });
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [output()] as never, stage,
    });
    const owned = request();
    capture(page, envelope, owned);
    page.emit("response", response(owned, {}, { body: () => body }));
    await expect(envelope.settle(5)).resolves.toBe(false);
    release(Buffer.from(JSON.stringify({ id: "LATE" })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stage).not.toHaveBeenCalled();
    expect(envelope.evidence()).toMatchObject({ lateResultDiscarded: true, bodyParseStatus: "not_started" });
    await envelope.close();
  });

  it("keeps body and staging failure classifications distinct", async () => {
    const bodyPage = new MockPage();
    const bodyEnvelope = beginProtectedResponseEnvelope(bodyPage as never, ["https://api.example.test"], new SecretRedactor());
    const bodyRequest = request();
    capture(bodyPage, bodyEnvelope, bodyRequest);
    bodyPage.emit("response", response(bodyRequest, {}, { body: async () => { throw new Error("body"); } }));
    await bodyEnvelope.settle(100);
    await expect(acquireProtectedResponseValue(bodyPage as never, output().acquisition as never))
      .rejects.toThrow("PROTECTED_RESPONSE_BODY_UNAVAILABLE");
    expect(bodyEnvelope.evidence().bodyParseStatus).toBe("unavailable");
    await bodyEnvelope.close();

    const stagePage = new MockPage();
    const stageEnvelope = beginProtectedResponseEnvelope(stagePage as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [output()] as never, stage: async () => { throw new Error("stage"); },
    });
    const stageRequest = request();
    capture(stagePage, stageEnvelope, stageRequest);
    stagePage.emit("response", response(stageRequest, { id: "VALUE" }));
    await stageEnvelope.settle(100);
    expect(stageEnvelope.evidence()).toMatchObject({ bodyParseStatus: "success", stagingStatus: "failed" });
    await stageEnvelope.close();
  });

  it("does not read owned response bodies for a DOM-only output set", async () => {
    const page = new MockPage();
    const body = vi.fn(() => new Promise<Buffer>(() => undefined));
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor(), {
      outputs: [{ ...output(), acquisition: { ...output().acquisition, permittedMethods: ["input_value"] } }] as never,
      stage: vi.fn(),
    });
    const owned = request();
    capture(page, envelope, owned);
    page.emit("response", response(owned, {}, { body }));
    await expect(envelope.settle(20)).resolves.toBe(true);
    expect(body).not.toHaveBeenCalled();
    await envelope.close();
  });

  it("safe ownership evidence contains no request or protected data", async () => {
    const page = new MockPage();
    const envelope = beginProtectedResponseEnvelope(page as never, ["https://api.example.test"], new SecretRedactor());
    const owned = request({ url: "https://api.example.test/private/path?token=SECRET_QUERY" });
    capture(page, envelope, owned);
    page.emit("response", response(owned, { id: "SECRET_VALUE" }));
    await envelope.settle(100);
    const serialized = JSON.stringify(envelope.evidence());
    expect(serialized).not.toMatch(/private|token|SECRET|api\.example|orders/i);
    await envelope.close();
  });
});
