import { seedSession } from "./fixtures/browser-session.js";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserCommand } from "@scry/contracts";

import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionQueueService } from "../src/browser-execution/browser-execution-queue.service.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { RedisConnection } from "../src/infrastructure/redis.js";

const databaseUrl = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const run = databaseUrl && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
const apiRoot = fileURLToPath(new URL("../", import.meta.url));

run("browser baseline real worker-process recovery", () => {
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let database: Database;
  let redis: RedisConnection;
  let effects: BrowserExecutionRepository;
  let commands: BrowserCommandRepository;
  let queue: BrowserExecutionQueueService;
  let worker: ChildProcess | undefined;
  let sessionId: string;
  let artifactRoot: string;
  let loginEffects = 0;

  beforeAll(async () => {
    server = createServer((request, response) => void fixture(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.SCRY_BROWSER_ENABLED = "true";
    process.env.SCRY_BROWSER_RENDER_VIDEO = "true";
    delete process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64;
    process.env.SCRY_BROWSER_PROTECTED_KEYS_JSON = JSON.stringify({
      "qualification-v1": randomBytes(32).toString("base64"),
      "qualification-baseline": randomBytes(32).toString("base64"),
    });
    process.env.SCRY_BROWSER_PROTECTED_KEY_ID = "qualification-v1";
    artifactRoot = `/tmp/browser-process-recovery-${randomUUID()}`;
    process.env.SCRY_BROWSER_ARTIFACT_ROOT = artifactRoot;
    database = new Database();
    redis = new RedisConnection();
    const cipher = new BrowserProtectedValueCipher();
    effects = new BrowserExecutionRepository(database, cipher);
    commands = new BrowserCommandRepository(database, cipher);
    queue = new BrowserExecutionQueueService(redis, effects, commands);
    sessionId = await seedSession(database, effects, origin);
  });

  afterAll(async () => {
    if (worker) await stopWorker(worker, "SIGKILL");
    if (queue) await queue.onModuleDestroy();
    if (redis) await redis.onModuleDestroy();
    if (database) await database.onModuleDestroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("restores authenticated browser state after the owning process is killed", async () => {
    worker = startWorker();
    await queue.dispatchPending();
    await waitFor(async () => (await commands.sessionContext(sessionId)).ownerGeneration === 1);

    const login = await command({ kind: "navigate", url: `${origin}/login` }, "navigate-login");
    await command(
      {
        kind: "fill",
        reference: control(login, "Email"),
        publicValue: "operator@example.test",
      },
      "fill-email",
    );
    await command(
      {
        kind: "fill",
        reference: control(login, "Password"),
        publicValue: "fixture-password",
      },
      "fill-password",
    );
    const committed = await command(
      {
        kind: "commit",
        reference: control(login, "Log in"),
        effectClass: "authentication",
        effectIdempotencyKey: "process-login-effect",
        intentSummary: "Authenticate once before process replacement",
        timeoutMs: 5_000,
      },
      "commit-login",
    );
    expect((committed.successorObservation as { text: string }).text).toBe("[QUARANTINED]");
    const effectId = String(committed.effectId);
    const captureId = String((committed.capture as { captureId: string }).captureId);
    await command({ kind: "discard_capture", effectId, captureId }, "discard-login-capture");
    await command(
      { kind: "determine", effectId, outcome: "applied", source: "owned_login_response" },
      "determine-login",
    );
    const encryptedCheckpoint = await database.query<{
      ciphertext: Buffer;
      resume_origin: string;
      resume_url_digest: string;
    }>(
      "SELECT ciphertext,resume_origin,resume_url_digest FROM browser_session_checkpoints WHERE session_id=$1",
      [sessionId],
    );
    expect(encryptedCheckpoint.rowCount).toBe(1);
    expect(encryptedCheckpoint.rows[0]?.resume_origin).toBe(origin);
    expect(encryptedCheckpoint.rows[0]?.resume_url_digest).toMatch(/^[a-f0-9]{64}$/u);
    const serializedCiphertext = encryptedCheckpoint.rows[0]!.ciphertext.toString("utf8");
    expect(serializedCiphertext).not.toContain("session=valid");
    expect(serializedCiphertext).not.toContain("session-only-secret");
    expect(serializedCiphertext).not.toContain("/authenticated");
    await expect(
      commands.saveBrowserCheckpoint(sessionId, 1, {
        resumeUrl: "https://attacker.example/escape",
        storageState: { cookies: [], origins: [] },
        sessionStorage: {},
      }),
    ).rejects.toThrow("SCRY_BROWSER_CHECKPOINT_ORIGIN_INVALID");

    await stopWorker(worker, "SIGKILL");
    worker = undefined;
    process.env.SCRY_BROWSER_PROTECTED_KEY_ID = "qualification-baseline";
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
      [sessionId],
    );

    worker = startWorker();
    const recovered = await command({ kind: "observe" }, "observe-after-process-kill");
    expect(recovered.text).toContain("Authenticated dashboard");
    expect(recovered.text).toContain("Session state restored");
    expect(recovered.url).toBe(`${origin}/authenticated`);
    expect(loginEffects).toBe(1);
    expect((await commands.sessionContext(sessionId)).ownerGeneration).toBe(2);
    expect((await commands.sessionContext(sessionId)).protectionKeyId).toBe("qualification-v1");
    await expect(
      commands.saveBrowserCheckpoint(sessionId, 1, {
        resumeUrl: `${origin}/authenticated`,
        storageState: { cookies: [], origins: [] },
        sessionStorage: {},
      }),
    ).rejects.toThrow("SCRY_BROWSER_OWNER_FENCED");
    await command({ kind: "close" }, "close-after-recovery");
    const retained = await database.query<{ count: string }>(
      "SELECT count(*) FROM browser_session_checkpoints WHERE session_id=$1",
      [sessionId],
    );
    expect(Number(retained.rows[0]?.count)).toBe(0);
    const persistedArtifacts = await allPersistedText(artifactRoot);
    expect(persistedArtifacts).not.toContain("fixture-password");
    expect(persistedArtifacts).not.toContain("session=valid");
    expect(persistedArtifacts).not.toContain("session-only-secret");
    expect(await persistedFilesNamed(artifactRoot, "evidence.key")).toEqual([]);
  }, 60_000);

  it("restores an unsettled protection barrier before opening the replacement page", async () => {
    if (worker) await stopWorker(worker, "SIGKILL");
    worker = undefined;
    sessionId = await seedSession(database, effects, origin);
    worker = startWorker();
    await queue.dispatchPending();
    await waitFor(async () => (await commands.sessionContext(sessionId)).ownerGeneration === 1);

    const login = await command({ kind: "navigate", url: `${origin}/login` }, "barrier-navigate");
    await command(
      {
        kind: "fill",
        reference: control(login, "Email"),
        publicValue: "operator@example.test",
      },
      "barrier-email",
    );
    await command(
      {
        kind: "fill",
        reference: control(login, "Password"),
        publicValue: "fixture-password",
      },
      "barrier-password",
    );
    const committed = await command(
      {
        kind: "commit",
        reference: control(login, "Log in"),
        effectClass: "authentication",
        effectIdempotencyKey: "barrier-login-effect",
        intentSummary: "Authenticate once and retain the response quarantine",
        timeoutMs: 5_000,
      },
      "barrier-commit",
    );
    expect((committed.successorObservation as { text: string }).text).toBe("[QUARANTINED]");
    const effectId = String(committed.effectId);
    const captureId = String((committed.capture as { captureId: string }).captureId);

    const durableCapture = await database.query<{
      encrypted_payload: Buffer;
      encrypted_payload_digest: string;
    }>(
      "SELECT encrypted_payload,encrypted_payload_digest FROM browser_captures WHERE id=$1 AND state='durable'",
      [captureId],
    );
    expect(durableCapture.rowCount).toBe(1);
    expect(durableCapture.rows[0]!.encrypted_payload.length).toBeGreaterThan(0);
    expect(durableCapture.rows[0]!.encrypted_payload_digest).toMatch(/^[a-f0-9]{64}$/u);

    await stopWorker(worker, "SIGKILL");
    worker = undefined;
    // Prove recovery is database-authoritative rather than accidentally reading
    // the previous worker's local capture cache.
    await rm(`${artifactRoot}/${sessionId}/captures`, { recursive: true, force: true });
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
      [sessionId],
    );
    worker = startWorker();
    const quarantined = await command({ kind: "observe" }, "barrier-after-replacement");
    expect(quarantined.text).toBe("[QUARANTINED]");
    expect((await commands.sessionContext(sessionId)).ownerGeneration).toBe(2);

    await command({ kind: "discard_capture", effectId, captureId }, "barrier-discard");
    await command(
      { kind: "determine", effectId, outcome: "applied", source: "owned_login_response" },
      "barrier-determine",
    );
    const released = await command({ kind: "observe" }, "barrier-observe-released");
    expect(released.text).toContain("Authenticated dashboard");
    await command({ kind: "close" }, "barrier-close");
  }, 60_000);

  it("fails closed for corrupt or oversized checkpoints", async () => {
    const corruptSessionId = await seedSession(database, effects, origin);
    const owner = await effects.claimOwner(corruptSessionId, "corruption-test", 30_000);
    await commands.saveBrowserCheckpoint(corruptSessionId, owner.generation, {
      resumeUrl: `${origin}/authenticated`,
      storageState: { cookies: [], origins: [] },
      sessionStorage: { continuity: "session-only-secret" },
    });
    await database.query(
      `UPDATE browser_session_checkpoints
       SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0) # 255)
       WHERE session_id=$1`,
      [corruptSessionId],
    );
    await expect(
      commands.loadBrowserCheckpoint(corruptSessionId, owner.generation),
    ).rejects.toThrow("SCRY_BROWSER_CHECKPOINT_CORRUPT");
    await expect(
      commands.saveBrowserCheckpoint(corruptSessionId, owner.generation, {
        resumeUrl: `${origin}/authenticated`,
        storageState: { cookies: [], origins: [] },
        sessionStorage: { oversized: "x".repeat(2 * 1024 * 1024) },
      }),
    ).rejects.toThrow("SCRY_BROWSER_CHECKPOINT_SIZE_INVALID");
  });

  function startWorker(): ChildProcess {
    const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
      cwd: apiRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    return child;
  }

  async function command(
    value: BrowserCommand,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const submitted = await commands.submit(sessionId, { idempotencyKey, command: value });
    await queue.dispatchPendingCommands();
    return waitFor(async () => {
      const observed = await commands.observe(submitted.commandId);
      if (observed.state === "failed") throw new Error(observed.errorCode);
      if (observed.state === "completed") {
        if (!observed.result) throw new Error("fixture_command_result_missing");
        return observed.result;
      }
      return false;
    }, 30_000);
  }

  function control(observation: Record<string, unknown>, name: string): string {
    const item = (observation.controls as Array<{ reference: string; name: string }>).find(
      (candidate) => candidate.name === name,
    );
    if (!item) throw new Error(`control_not_found:${name}`);
    return item.reference;
  }

  async function fixture(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/login") {
      html(
        response,
        '<form method="post" action="/api/login"><label>Email<input aria-label="Email" name="email"></label><label>Password<input aria-label="Password" name="password" type="password"></label><button type="submit">Log in</button></form>',
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = new URLSearchParams(await bodyText(request));
      if (
        body.get("email") !== "operator@example.test" ||
        body.get("password") !== "fixture-password"
      ) {
        json(response, 403, { error: "forbidden" });
        return;
      }
      loginEffects += 1;
      response.writeHead(303, {
        location: "/authenticated",
        "content-type": "text/html",
        "set-cookie": "session=valid; Path=/; HttpOnly; SameSite=Lax",
      });
      response.end("redirecting");
      return;
    }
    if (request.method === "GET" && url.pathname === "/authenticated") {
      if (!String(request.headers.cookie ?? "").includes("session=valid")) {
        response.writeHead(302, { location: "/login" }).end();
        return;
      }
      html(
        response,
        `<main>Authenticated dashboard</main><script>
          if (sessionStorage.getItem('continuity') === 'session-only-secret') {
            const restored = document.createElement('p');
            restored.textContent = 'Session state restored';
            document.body.append(restored);
          } else {
            sessionStorage.setItem('continuity', 'session-only-secret');
          }
        </script>`,
      );
      return;
    }
    response.writeHead(404).end();
  }
});

async function stopWorker(worker: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  worker.kill(signal);
  await exited;
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html>${body}`);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function allPersistedText(directory: string): Promise<string> {
  const chunks: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = `${current}/${entry.name}`;
      if (entry.isDirectory()) await visit(target);
      else chunks.push((await readFile(target)).toString("utf8"));
    }
  };
  await visit(directory);
  return chunks.join("\n");
}

async function persistedFilesNamed(directory: string, filename: string): Promise<string[]> {
  const matches: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = `${current}/${entry.name}`;
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === filename) matches.push(target);
    }
  };
  await visit(directory);
  return matches.sort();
}

async function waitFor<T>(check: () => Promise<T | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("wait_timeout");
}
