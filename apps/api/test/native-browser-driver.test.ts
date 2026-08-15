import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeBrowserDriver } from "../src/runtime/native-browser-driver/native-browser-driver.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("NativeBrowserDriver application adapters", () => {
  it("delegates owned browser creation to Praxis", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser({}, { kind: "runtime_browser", ownerId: "driver-test" });
    try {
      await opened.page.setContent("<main>ready</main>");
      expect(await opened.page.getByRole("main").textContent()).toBe("ready");
    } finally {
      await opened.forceClose();
    }
  }, 15_000);

  it("keeps authenticated same-origin request dispatch inside its callback boundary", async () => {
    const observed: Array<{ authorization: string | undefined; method: string | undefined }> = [];
    const server = createServer((request, response) => {
      observed.push({ authorization: request.headers.authorization, method: request.method });
      if (request.method === "GET") response.end("<main>ready</main>");
      else response.writeHead(204).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_UNAVAILABLE");
    const origin = `http://127.0.0.1:${address.port}`;
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser({}, { kind: "runtime_browser", ownerId: "request-test" });
    const beforeDispatch = vi.fn();
    try {
      await opened.page.goto(origin);
      await opened.context.addCookies([{ name: "token", value: "opaque-token", url: origin }]);
      await expect(driver.sameOriginRequest(opened.page, {
        method: "POST",
        path: "/dispatch",
        expectedStatus: { min: 200, max: 299 },
      }, [origin], beforeDispatch)).resolves.toMatchObject({ status: 204, classification: "expected" });
      expect(beforeDispatch).toHaveBeenCalledOnce();
      expect(observed.at(-1)).toEqual({
        authorization: "Bearer opaque-token",
        method: "POST",
      });
    } finally {
      await opened.forceClose();
    }
  }, 15_000);

  it("rejects cross-origin request dispatch before the callback", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser({}, { kind: "runtime_browser", ownerId: "denial-test" });
    const beforeDispatch = vi.fn();
    try {
      await expect(driver.sameOriginRequest(opened.page, {
        method: "POST",
        path: "https://denied.example/dispatch",
        expectedStatus: { min: 200, max: 299 },
      }, ["https://allowed.example"], beforeDispatch)).rejects.toMatchObject({
        code: "NATIVE_SAME_ORIGIN_REQUEST_DENIED",
      });
      expect(beforeDispatch).not.toHaveBeenCalled();
    } finally {
      await opened.forceClose();
    }
  }, 15_000);
});
