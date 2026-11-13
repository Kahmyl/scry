import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PraxisMcpBrowserEngine } from "@scry/praxis";
import { VeilBrowserProtection } from "@scry/veil";
import type {
  ChronicleEvidencePort,
  PraxisExecutionPort,
  PraxisCommandsPort,
  PraxisEffectsPort,
} from "@scry/contracts";
import { Database } from "../src/infrastructure/database.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { processBrowserCommand } from "../src/browser-execution/browser-command-processor.js";
import { seedSession } from "./fixtures/browser-session.js";

const target = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(target ? describe : describe.skip)(
  "native denial context preserves authoritative successor admission",
  () => {
    let db: Database;
    let commands: BrowserCommandRepository;
    let execution: BrowserExecutionRepository;
    beforeAll(() => {
      vi.stubEnv("DATABASE_URL", target!);
      vi.stubEnv("SCRY_BROWSER_MAX_LIVE_SESSIONS", "1000");
      vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
      vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
      vi.stubEnv("SCRY_BROWSER_PROTECTED_KEY_BASE64", randomBytes(32).toString("base64"));
      db = new Database();
      const cipher = new BrowserProtectedValueCipher();
      commands = new BrowserCommandRepository(db, cipher);
      execution = new BrowserExecutionRepository(db, cipher);
    });
    afterAll(async () => {
      await db?.onModuleDestroy();
      vi.unstubAllEnvs();
    });
    async function fixture() {
      const session = await seedSession(db, execution, "https://fixture.example");
      const engine = new PraxisMcpBrowserEngine(
        commands as unknown as PraxisCommandsPort,
        {} as PraxisEffectsPort,
        {} as ChronicleEvidencePort,
        new VeilBrowserProtection(),
        "unused",
      );
      const c = (engine as unknown as { cell(id: string): any }).cell(session);
      c.scope = await commands.sessionContext(session);
      c.opening = Promise.resolve();
      c.lease = { assertActive() {}, checkpoint: async () => {} };
      c.policyDigest = createHash("sha256").update("{}").digest("hex");
      c.custody = { synchronize: async () => {} };
      c.worker = {
        call: vi.fn(async () => ({
          isError: false,
          content: [{ type: "text", text: "Successor receipt" }],
        })),
      };
      const praxis = {
        executeCommand: (id, command, options) => engine.execute(id, command, options),
      } as PraxisExecutionPort;
      const process = (id: string) =>
        processBrowserCommand(commands, praxis, {
          data: { commandId: id },
          moveToDelayed: vi.fn(async () => {}),
        });
      const deny = () =>
        c.denials.record({ origin: "https://background.example", reason: "origin_not_allowed" });
      return { session, c, process, deny };
    }
    const click = () => ({
      kind: "browser_tool" as const,
      tool: "browser_click",
      args: { target: "e1" },
    });

    it.each([false, true])(
      "admits queued and new successors after fail-fast refusal (idle denial: %s)",
      async (idle) => {
        const f = await fixture();
        if (idle) f.deny();
        const first = await commands.submit(f.session, {
          idempotencyKey: randomUUID(),
          command: {
            kind: "browser_tool",
            tool: "browser_navigate",
            args: { url: "https://outside.example/" },
          },
        });
        const queued = await commands.submit(f.session, {
          idempotencyKey: randomUUID(),
          command: click(),
        });
        expect(await f.process(first.commandId)).toEqual({ failed: true });
        expect(f.c.worker.call).not.toHaveBeenCalled();
        const refusal = await commands.observe(first.commandId);
        expect(refusal.state).toBe("failed");
        expect(refusal.errorCode).toBe("SCRY_BROWSER_ORIGIN_DENIED");
        if (idle)
          expect(refusal.result).toMatchObject({
            execution: "not_dispatched",
            businessOutcome: "not_dispatched",
            scopeDiagnostics: { prior: { denialCount: 1 } },
          });
        else expect(refusal.result).toBeNull();
        const later = await commands.submit(f.session, {
          idempotencyKey: randomUUID(),
          command: click(),
        });
        for (const successor of [queued, later]) {
          expect(await f.process(successor.commandId)).toMatchObject({
            execution: "completed",
            businessOutcome: "unverified",
          });
          expect(await commands.observe(successor.commandId)).toMatchObject({
            state: "completed",
            result: { execution: "completed", businessOutcome: "unverified" },
          });
        }
        expect(
          f.c.worker.call.mock.calls.filter(([message]: any) => message.tool === "browser_click"),
        ).toHaveLength(2);
        expect((await commands.observe(first.commandId)).result).toEqual(refusal.result);
        f.c.denials.dispose();
      },
    );

    it("retains quarantine when an actual dispatch remains unknown alongside a denial", async () => {
      const f = await fixture();
      f.c.worker.call.mockImplementation(async () => {
        f.deny();
        throw Error("SCRY_BROWSER_ADAPTER_CALL_FAILED");
      });
      const first = await commands.submit(f.session, {
        idempotencyKey: randomUUID(),
        command: click(),
      });
      const queued = await commands.submit(f.session, {
        idempotencyKey: randomUUID(),
        command: click(),
      });
      expect(await f.process(first.commandId)).toEqual({ failed: true });
      expect((await commands.observe(first.commandId)).result).toMatchObject({
        execution: "unknown",
        businessOutcome: "unknown",
        scopeDiagnostics: { current: { denialCount: 1 } },
      });
      expect(await f.process(queued.commandId)).toEqual({ replay: true });
      expect(await commands.observe(queued.commandId)).toMatchObject({
        state: "failed",
        errorCode: "SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED",
        result: { execution: "not_dispatched" },
      });
      await expect(
        commands.submit(f.session, { idempotencyKey: randomUUID(), command: click() }),
      ).rejects.toThrow("RECONCILIATION_REQUIRED");
      expect(f.c.worker.call).toHaveBeenCalledTimes(1);
      f.c.denials.dispose();
    });
  },
);
