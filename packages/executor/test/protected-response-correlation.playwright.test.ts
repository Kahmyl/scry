import { createServer, type ServerResponse } from "node:http";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretRedactor } from "@scry/policy";
import { acquireProtectedResponseValue, beginProtectedResponseEnvelope } from "@scry/praxis";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () =>
  Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  ),
);

const output = {
  reference: "orderId",
  classification: "public",
  storage: { scope: "project", name: "Order ID" },
  acquisition: {
    target: {
      concept: "order id",
      requiredCapabilities: [],
      preferredEvidence: {
        roles: [],
        names: ["id"],
        labels: [],
        descriptions: [],
        placeholders: [],
        inputTypes: [],
      },
      scope: { kind: "page" },
      relations: [],
      prohibited: [],
      risk: "protected",
      confidence: { requiredFamilies: [] },
    },
    permittedMethods: ["protected_network_value"],
  },
} as any;

describe("protected response action correlation in Chromium", () => {
  it("ignores a pre-existing delayed request and settles only the action-owned root", async () => {
    let oldResponse: ServerResponse | undefined;
    let oldArrivedResolve!: () => void;
    const oldArrived = new Promise<void>((resolve) => {
      oldArrivedResolve = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response
          .writeHead(200, { "content-type": "text/html" })
          .end("<!doctype html><main>ready</main>");
      } else if (request.url === "/old") {
        oldResponse = response;
        oldArrivedResolve();
      } else if (request.url === "/action") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id: "ACTION_VALUE" }));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      const oldRequest = page.waitForRequest((request) => request.url().endsWith("/old"));
      void page.evaluate(() => fetch("/old").then((response) => response.json()));
      await Promise.all([oldArrived, oldRequest]);

      const stage = vi.fn().mockResolvedValue(undefined);
      const envelope = beginProtectedResponseEnvelope(page, [origin], new SecretRedactor(), {
        outputs: [output],
        stage,
      });
      envelope.beginActionCapture();
      await page.evaluate(() => fetch("/action").then((response) => response.json()));
      envelope.endActionCapture();

      await expect(envelope.waitForRequestInitiation(100)).resolves.toMatchObject({
        status: "initiated",
      });
      await expect(envelope.settle(500)).resolves.toBe(true);
      expect(stage).toHaveBeenCalledOnce();
      await expect(acquireProtectedResponseValue(page, output.acquisition)).resolves.toBe(
        "ACTION_VALUE",
      );

      const oldResponseObserved = page.waitForResponse((response) =>
        response.url().endsWith("/old"),
      );
      oldResponse!
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ id: "PREEXISTING_VALUE" }));
      await oldResponseObserved;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stage).toHaveBeenCalledOnce();
      await expect(acquireProtectedResponseValue(page, output.acquisition)).resolves.toBe(
        "ACTION_VALUE",
      );
      expect(envelope.evidence()).toMatchObject({
        capturedRootCount: "one",
        ownershipStatus: "unique",
        ignoredUnownedResponseCount: 0,
      });
      await envelope.close();
    } finally {
      await browser.close();
    }
  }, 20_000);
});
