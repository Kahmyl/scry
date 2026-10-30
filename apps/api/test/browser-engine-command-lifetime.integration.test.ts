import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PraxisExecutionPort } from "@scry/contracts";
import { OwnedBrowser } from "@scry/praxis";
import { composePraxisExecutionPort } from "../src/browser-execution/browser-boundary-composition.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
live("composed engine command lifetimes", () => {
  let database: Database,
    effects: BrowserExecutionRepository,
    praxis: PraxisExecutionPort,
    origin: string;
  let requested: (() => void) | undefined, held: ServerResponse | undefined;
  const launched = vi.spyOn(OwnedBrowser, "launch");
  const server = createServer((request, response) => {
    if (request.url === "/hold") {
      held = response;
      requested?.();
      return;
    }
    if (request.url === "/busy") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>Busy fixture</title><script>while(true){}</script>");
      requested?.();
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<title>Independent native fixture</title><main><button>Available</button></main>");
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    process.env.SCRY_BROWSER_RENDER_VIDEO = "false";
    process.env.SCRY_BROWSER_ARTIFACT_ROOT = await mkdtemp(
      path.join(os.tmpdir(), "praxis-command-lifetime-"),
    );
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    effects = new BrowserExecutionRepository(database, cipher);
    praxis = composePraxisExecutionPort(new BrowserCommandRepository(database, cipher), effects);
  });
  afterAll(async () => {
    held?.end();
    await praxis?.shutdown();
    await database?.onModuleDestroy();
    launched.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const hold = () =>
    new Promise<void>((resolve) => {
      requested = resolve;
    });
  const release = () => {
    held
      ?.writeHead(200, { "content-type": "text/html" })
      .end("<title>Released fixture</title><main>Available</main>");
    held = undefined;
    requested = undefined;
  };
  it("cancels a genuinely busy browser and waits for native process exit before returning", async () => {
    const sessionId = await seedSession(database, effects, origin),
      cancel = new AbortController(),
      seen = hold();
    const running = praxis.executeCommand(
      sessionId,
      { kind: "navigate", url: origin + "/busy" },
      { remainingMs: 10000, signal: cancel.signal },
    );
    const rejection = expect(running).rejects.toThrow("COMMAND_CANCELLED");
    try {
      await seen;
      const browser = await launched.mock.results.at(-1)!.value;
      cancel.abort();
      await rejection;
      expect(browser.exitConfirmed).toBe(true);
      expect(browser.browser.isConnected()).toBe(false);
    } finally {
      cancel.abort();
      await running.catch(() => undefined);
      requested = undefined;
    }
  }, 30000);
  it("rejects a second command while a native navigation is still in flight", async () => {
    const sessionId = await seedSession(database, effects, origin),
      seen = hold();
    const running = praxis.executeCommand(sessionId, { kind: "navigate", url: origin + "/hold" });
    void running.catch(() => undefined);
    try {
      await seen;
      await expect(praxis.executeCommand(sessionId, { kind: "observe" })).rejects.toThrow(
        "COMMAND_CONCURRENT",
      );
    } finally {
      release();
      await running;
      await praxis.executeCommand(sessionId, { kind: "close" });
    }
  }, 30000);
  it("does not let a completed command's old signal terminate its browser during the next navigation", async () => {
    const sessionId = await seedSession(database, effects, origin),
      old = new AbortController();
    await praxis.executeCommand(
      sessionId,
      { kind: "navigate", url: origin },
      { remainingMs: 10000, signal: old.signal },
    );
    const browser = await launched.mock.results.at(-1)!.value,
      seen = hold();
    const running = praxis.executeCommand(sessionId, { kind: "navigate", url: origin + "/hold" });
    void running.catch(() => undefined);
    try {
      await seen;
      old.abort();
      expect(browser.exitConfirmed).toBe(false);
      expect(browser.browser.isConnected()).toBe(true);
    } finally {
      release();
      await running;
      await praxis.executeCommand(sessionId, { kind: "close" });
    }
  }, 30000);
});
