import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SupervisedBrowser } from "@scry/praxis";
import { composePraxisExecutionPort } from "../src/browser-execution/browser-boundary-composition.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";

const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
live("native owner lifetime during database delay", () => {
  let database: Database, origin: string, seenBusy: (() => void) | undefined;
  const actualLaunch = SupervisedBrowser.launch;
  const launched = vi.spyOn(SupervisedBrowser, "launch");
  const server = createServer((request, response) => {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        request.url === "/busy"
          ? "<title>Busy owner fixture</title><script>while(true){}</script>"
          : "<title>Available owner fixture</title><main>Available</main>",
      );
    if (request.url === "/busy") seenBusy?.();
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
      path.join(os.tmpdir(), "scry-owner-watchdog-"),
    );
    database = new Database();
  });
  afterAll(async () => {
    launched.mockRestore();
    await database?.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  function runtime(leaseMs = 2500) {
    const cipher = new BrowserProtectedValueCipher();
    const effects = new BrowserExecutionRepository(database, cipher);
    const claim = effects.claimOwner.bind(effects);
    const claimSpy = vi
      .spyOn(effects, "claimOwner")
      .mockImplementation((session, worker) => claim(session, worker, leaseMs));
    const praxis = composePraxisExecutionPort(
      new BrowserCommandRepository(database, cipher),
      effects,
    );
    return { effects, praxis, claimSpy };
  }
  it("physically stops a busy browser while its real owner heartbeat is blocked on PostgreSQL", async () => {
    const { effects, praxis, claimSpy } = runtime(6000),
      heartbeat = vi.spyOn(effects, "heartbeatOwner");
    let allowQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => {
      allowQuery = resolve;
    });
    const actualHeartbeat = BrowserExecutionRepository.prototype.heartbeatOwner.bind(effects);
    heartbeat.mockImplementation(async (...args) => {
      await queryGate;
      return actualHeartbeat(...args);
    });
    // Deliberately cover startup crossing the first renewal tick. Without
    // explicit fixture ordering an early successful renewal invalidates the
    // short-lease assumption and makes this a timing-dependent test.
    launched.mockImplementationOnce(async (options) => {
      const browser = await actualLaunch(options);
      await new Promise((resolve) => setTimeout(resolve, 2300));
      return browser;
    });
    const sessionId = await seedSession(database, effects, origin);
    const busy = new Promise<void>((resolve) => {
      seenBusy = resolve;
    });
    const running = praxis.executeCommand(
      sessionId,
      { kind: "navigate", url: origin + "/busy" },
      { remainingMs: 15000 },
    );
    const outcome = running.then(
      () => "unexpected_success",
      () => "rejected",
    );
    const client = await database.pool.connect();
    try {
      await Promise.race([
        busy,
        running.then(
          () => {
            throw new Error("fixture_navigation_finished_before_busy");
          },
          () => {
            throw new Error("fixture_navigation_failed_before_busy");
          },
        ),
      ]);
      const browser = await launched.mock.results.at(-1)!.value;
      await client.query("BEGIN");
      const {
        rows: [backend],
      } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await client.query("SELECT 1 FROM browser_owner_generations WHERE session_id=$1 FOR UPDATE", [
        sessionId,
      ]);
      allowQuery();
      await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1), { timeout: 3000 });
      await vi.waitFor(
        async () => {
          const blocked = await database.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
            [backend!.pid],
          );
          expect(blocked.rowCount).toBeGreaterThan(0);
        },
        { timeout: 1500 },
      );
      let heartbeatSettled = false;
      void Promise.allSettled(heartbeat.mock.results.map((result) => result.value)).then(() => {
        heartbeatSettled = true;
      });
      await vi.waitFor(
        () => {
          expect(browser.exitConfirmed).toBe(true);
          // Child exit is the stop proof; the client's asynchronous disconnect
          // notification may be delivered on a subsequent event-loop turn.
          expect(browser.browser.isConnected()).toBe(false);
        },
        { timeout: 6000 },
      );
      expect(heartbeatSettled).toBe(false);
      expect(browser.browser.isConnected()).toBe(false);
      await client.query("COMMIT");
      expect(await outcome).toBe("rejected");
      await Promise.allSettled(heartbeat.mock.results.map((result) => result.value));
      expect(browser.exitConfirmed).toBe(true);
      const stored = await database.query(
        "SELECT completed_at FROM browser_evidence_streams WHERE session_id=$1",
        [sessionId],
      );
      expect(stored.rows.every((row) => row.completed_at === null)).toBe(true);
    } finally {
      allowQuery();
      await client.query("ROLLBACK");
      client.release();
      seenBusy = undefined;
      await praxis.shutdown();
      await running.catch(() => undefined);
      heartbeat.mockRestore();
      claimSpy.mockRestore();
    }
  }, 20000);
  it("never launches for a real owner acknowledgement delayed beyond its admitted lease", async () => {
    const { effects, praxis, claimSpy } = runtime();
    const actual = BrowserExecutionRepository.prototype.claimOwner.bind(effects);
    claimSpy.mockImplementation(async (session, worker) => {
      const owner = await actual(session, worker, 2500);
      await new Promise((resolve) => setTimeout(resolve, 2700));
      return owner;
    });
    const before = launched.mock.calls.length,
      id = await seedSession(database, effects, origin);
    try {
      await expect(praxis.openSession(id)).rejects.toThrow("OWNER_FENCED");
      expect(launched.mock.calls.length).toBe(before);
    } finally {
      await praxis.shutdown();
      claimSpy.mockRestore();
    }
  });
  it("keeps a valid native browser alive after an acknowledged database renewal", async () => {
    const { effects, praxis, claimSpy } = runtime(),
      heartbeat = vi.spyOn(effects, "heartbeatOwner");
    const id = await seedSession(database, effects, origin);
    try {
      await praxis.openSession(id);
      const browser = await launched.mock.results.at(-1)!.value;
      await new Promise((resolve) => setTimeout(resolve, 2800));
      expect(heartbeat).toHaveBeenCalled();
      expect(browser.exitConfirmed).toBe(false);
      expect(browser.browser.isConnected()).toBe(true);
      await praxis.executeCommand(id, { kind: "observe" });
    } finally {
      await praxis.shutdown();
      heartbeat.mockRestore();
      claimSpy.mockRestore();
    }
  });
});
