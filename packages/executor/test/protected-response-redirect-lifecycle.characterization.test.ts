import { createServer } from "node:http";
import { chromium, type Request } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretRedactor } from "@scry/policy";
import {
  acquireProtectedResponseValue,
  beginProtectedResponseEnvelope,
} from "../src/protected-response-envelope.js";

type Listener = (value: any) => void;

class MockPage {
  private readonly listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, value: any) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function mockRequest(redirectedFrom?: any) {
  return {
    method: () => "GET",
    resourceType: () => "fetch",
    url: () => "http://allowed.test/resource",
    redirectedFrom: () => redirectedFrom ?? null,
  };
}

function mockResponse(owner: any, status: number, body: () => Promise<Buffer>) {
  return {
    request: () => owner,
    url: () => owner.url(),
    status: () => status,
    headers: () => ({ "content-type": status === 200 ? "application/json" : "text/plain" }),
    body,
  };
}

const output = {
  reference: "orderId",
  classification: "public",
  storage: { scope: "project", name: "Order ID" },
  acquisition: {
    target: {
      concept: "order id",
      requiredCapabilities: [],
      preferredEvidence: {
        roles: [], names: ["id"], labels: [], descriptions: [], placeholders: [], inputTypes: [],
      },
      scope: { kind: "page" }, relations: [], prohibited: [], risk: "protected",
      confidence: { requiredFamilies: [] },
    },
    permittedMethods: ["protected_network_value"],
  },
} as any;

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) =>
  new Promise<void>((resolve) => server.close(() => resolve())),
)));

describe("protected response redirect lifecycle characterization", () => {
  it("records real Chromium redirect event ordering over repeated natural redirects", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><main>ready</main>");
      } else if (request.url?.startsWith("/start")) {
        response.writeHead(302, { location: request.url.replace("/start", "/final") }).end();
      } else if (request.url?.startsWith("/final")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "FINAL" }));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      const runs: string[][] = [];
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const events: string[] = [];
        let root: Request | undefined;
        let child: Request | undefined;
        const classify = (request: Request) => request === root ? "ROOT" : request === child ? "CHILD" : undefined;
        const onRequest = (request: Request) => {
          if (!request.url().includes(`run=${iteration}`)) return;
          if (!request.redirectedFrom()) root = request;
          else child = request;
          events.push(`request(${classify(request)})`);
        };
        const onResponse = (response: any) => {
          const owner = classify(response.request());
          if (owner) events.push(`response(${owner},${response.status()})`);
        };
        const onFinished = (request: Request) => {
          const owner = classify(request);
          if (owner) events.push(`requestfinished(${owner})`);
        };
        page.on("request", onRequest);
        page.on("response", onResponse);
        page.on("requestfinished", onFinished);
        await page.evaluate((run) => fetch(`/start?run=${run}`).then((response) => response.json()), iteration);
        page.off("request", onRequest);
        page.off("response", onResponse);
        page.off("requestfinished", onFinished);
        runs.push(events);
      }
      console.log("SAFE_REDIRECT_EVENT_ORDERS", JSON.stringify(runs));
      expect(new Set(runs.map((events) => events.join(" -> ")))).toEqual(new Set([
        "request(ROOT) -> response(ROOT,302) -> requestfinished(ROOT) -> request(CHILD) -> response(CHILD,200) -> requestfinished(CHILD)",
      ]));
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("characterizes settlement racing natural redirected-child admission", async () => {
    let releaseFinal!: () => void;
    const finalGate = new Promise<void>((resolve) => { releaseFinal = resolve; });
    let finalArrivedResolve!: () => void;
    const finalArrived = new Promise<void>((resolve) => { finalArrivedResolve = resolve; });
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><main>ready</main>");
      } else if (request.url === "/start") {
        response.writeHead(302, { location: "/final" }).end();
      } else if (request.url === "/final") {
        finalArrivedResolve();
        void finalGate.then(() => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "FINAL" })));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      const stage = vi.fn().mockResolvedValue(undefined);
      const envelope = beginProtectedResponseEnvelope(page, [origin], new SecretRedactor(), { outputs: [output], stage });
      envelope.beginActionCapture();
      const rootObserved = page.waitForRequest((request) => request.url().endsWith("/start"));
      const childObserved = page.waitForRequest((request) => request.url().endsWith("/final"));
      const fetchResult = page.evaluate(() => fetch("/start").then((response) => response.json()));
      await rootObserved;
      envelope.endActionCapture();
      let settled = false;
      const settlement = envelope.settle(2_000).then((result) => { settled = true; return result; });
      await finalArrived;
      await childObserved;
      const settledBeforeChildAdmission = settled;
      console.log("SAFE_PRODUCTION_SHAPED_REDIRECT_RESULT", JSON.stringify({ settledBeforeChildAdmission }));
      expect(envelope.evidence().redirectHopCount).toBe(1);
      releaseFinal();
      await fetchResult;
      await expect(settlement).resolves.toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledBeforeChildAdmission).toBe(false);
      expect(stage).toHaveBeenCalledOnce();
      await expect(acquireProtectedResponseValue(page, output.acquisition)).resolves.toBe("FINAL");
      expect(envelope.evidence().redirectHopCount).toBe(1);
      await envelope.close();
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("keeps synthetic settlement open through exact redirect handoff", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const body = vi.fn(async () => Buffer.from(JSON.stringify({ id: "FINAL" })));
    const envelope = beginProtectedResponseEnvelope(page as never, ["http://allowed.test"], new SecretRedactor(), {
      outputs: [output], stage,
    });
    const root = mockRequest();
    envelope.beginActionCapture();
    page.emit("request", root);
    envelope.endActionCapture();
    let resolved = false;
    const settlement = envelope.settle(500).then((result) => { resolved = true; return result; });
    page.emit("response", mockResponse(root, 302, vi.fn()));
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(stage).not.toHaveBeenCalled();

    const child = mockRequest(root);
    page.emit("request", child);
    page.emit("response", mockResponse(child, 200, body));
    await expect(settlement).resolves.toBe(true);
    expect(envelope.evidence().redirectHopCount).toBe(1);
    expect(body).toHaveBeenCalledOnce();
    expect(envelope.evidence()).toMatchObject({ bodyParseStatus: "success", extractionResultClass: "acquired" });
    await expect(acquireProtectedResponseValue(page as never, output.acquisition)).resolves.toBe("FINAL");
    expect(stage).toHaveBeenCalledOnce();
    await envelope.close();
  });

  it("fails closed with a precise bounded reason when a redirect child never arrives", async () => {
    const page = new MockPage();
    const stage = vi.fn();
    const envelope = beginProtectedResponseEnvelope(page as never, ["http://allowed.test"], new SecretRedactor(), {
      outputs: [output], stage,
    });
    const root = mockRequest();
    envelope.beginActionCapture();
    page.emit("request", root);
    envelope.endActionCapture();
    page.emit("response", mockResponse(root, 302, vi.fn()));
    await expect(envelope.settle(10)).resolves.toBe(false);
    await expect(acquireProtectedResponseValue(page as never, output.acquisition))
      .rejects.toThrow("PROTECTED_REQUEST_REDIRECT_HANDOFF_TIMEOUT");
    expect(stage).not.toHaveBeenCalled();
    await envelope.close();
  });

  it("does not let requestfinished close the redirect handoff gap", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const envelope = beginProtectedResponseEnvelope(page as never, ["http://allowed.test"], new SecretRedactor(), {
      outputs: [output], stage,
    });
    const root = mockRequest();
    envelope.beginActionCapture();
    page.emit("request", root);
    envelope.endActionCapture();
    let resolved = false;
    const settlement = envelope.settle(500).then((result) => { resolved = true; return result; });
    page.emit("response", mockResponse(root, 302, vi.fn()));
    page.emit("requestfinished", root);
    await Promise.resolve();
    expect(resolved).toBe(false);
    const child = mockRequest(root);
    page.emit("request", child);
    page.emit("response", mockResponse(child, 200, async () => Buffer.from(JSON.stringify({ id: "FINAL" }))));
    await expect(settlement).resolves.toBe(true);
    expect(stage).toHaveBeenCalledOnce();
    await envelope.close();
  });

  it("completes an order-independent handoff when the child precedes the parent 302 response", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const envelope = beginProtectedResponseEnvelope(page as never, ["http://allowed.test"], new SecretRedactor(), {
      outputs: [output], stage,
    });
    const root = mockRequest();
    envelope.beginActionCapture();
    page.emit("request", root);
    envelope.endActionCapture();
    const child = mockRequest(root);
    page.emit("request", child);
    const settlement = envelope.settle(500);
    page.emit("response", mockResponse(root, 302, vi.fn()));
    page.emit("response", mockResponse(child, 200, async () => Buffer.from(JSON.stringify({ id: "FINAL" }))));
    await expect(settlement).resolves.toBe(true);
    expect(stage).toHaveBeenCalledOnce();
    expect(envelope.evidence().redirectHopCount).toBe(1);
    await envelope.close();
  });

  it("settles a three-hop exact-identity redirect chain as one semantic aggregate", async () => {
    const page = new MockPage();
    const stage = vi.fn().mockResolvedValue(undefined);
    const envelope = beginProtectedResponseEnvelope(page as never, ["http://allowed.test"], new SecretRedactor(), {
      outputs: [output], stage,
    });
    const first = mockRequest();
    envelope.beginActionCapture();
    page.emit("request", first);
    envelope.endActionCapture();
    const settlement = envelope.settle(500);
    const second = mockRequest(first);
    page.emit("response", mockResponse(first, 302, vi.fn()));
    page.emit("request", second);
    const third = mockRequest(second);
    page.emit("response", mockResponse(second, 302, vi.fn()));
    page.emit("request", third);
    const final = mockRequest(third);
    page.emit("request", final);
    page.emit("response", mockResponse(third, 302, vi.fn()));
    page.emit("response", mockResponse(final, 200, async () => Buffer.from(JSON.stringify({ id: "FINAL" }))));
    await expect(settlement).resolves.toBe(true);
    expect(envelope.evidence().redirectHopCount).toBe(3);
    expect(stage).toHaveBeenCalledOnce();
    await expect(acquireProtectedResponseValue(page as never, output.acquisition)).resolves.toBe("FINAL");
    await envelope.close();
  });

  it.each(["success", "timeout", "ambiguity", "rejection"] as const)(
    "keeps lineage and evidence immutable after %s finalization",
    async (outcome) => {
      const page = new MockPage();
      const stage = vi.fn().mockResolvedValue(undefined);
      const envelope = beginProtectedResponseEnvelope(page as never, ["http://allowed.test"], new SecretRedactor(), {
        outputs: [output], stage,
      });
      const root = mockRequest();
      envelope.beginActionCapture();
      page.emit("request", root);
      if (outcome === "ambiguity") page.emit("request", mockRequest());
      envelope.endActionCapture();

      if (outcome === "success") page.emit("response", mockResponse(root, 200, async () => Buffer.from(JSON.stringify({ id: "FINAL" }))));
      if (outcome === "rejection") {
        const forbidden = { ...mockRequest(root), url: () => "http://forbidden.test/resource" };
        page.emit("request", forbidden);
      }
      await envelope.settle(outcome === "timeout" ? 1 : 100);
      const before = envelope.evidence();
      const lateChild = mockRequest(root);
      const lateBody = vi.fn(async () => Buffer.from(JSON.stringify({ id: "LATE" })));
      page.emit("request", lateChild);
      page.emit("response", mockResponse(lateChild, 200, lateBody));
      await Promise.resolve();
      await Promise.resolve();
      const after = envelope.evidence();
      expect(after).toEqual(before);
      expect(lateBody).not.toHaveBeenCalled();
      expect(stage).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      await envelope.close();
    },
  );
});
