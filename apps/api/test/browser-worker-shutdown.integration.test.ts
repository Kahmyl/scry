import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { OwnedBrowser } from "@scry/praxis";
import { describe, expect, it } from "vitest";
import {
  BrowserWorkRegistry,
  createBrowserWorkerShutdown,
} from "../src/browser-execution/worker-lifecycle.js";

const live = process.env.SCRY_BROWSER_E2E === "1" && process.env.REDIS_URL ? it : it.skip;
describe("actual queue and browser shutdown", () => {
  live(
    "stops an actual busy renderer before draining its Redis job, then preserves queue acknowledgement",
    async () => {
      const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      const name = "native-shutdown-" + randomUUID(),
        queue = new Queue(name, { connection }),
        registry = new BrowserWorkRegistry();
      let owned: OwnedBrowser | undefined;
      let worker: Worker | undefined;
      try {
        owned = await OwnedBrowser.launch({
          channel: process.env.SCRY_BROWSER_CHANNEL ?? "chromium",
        });
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const browserOwner = owned;
        const page = await browserOwner.browser.newPage();
        let failures = 0;
        worker = new Worker(
          name,
          (job, token) =>
            registry.run(job, token, async () => {
              enter();
              try {
                await page.evaluate(() => {
                  while (true) {
                    /* Intentional isolated renderer stall. */
                  }
                });
                return { interrupted: false };
              } catch {
                return { interrupted: true };
              }
            }),
          { connection },
        );
        const queueWorker = worker;
        worker.on("error", () => {
          failures++;
          registry.failTransport();
        });
        let applicationClosed = false;
        const shutdown = createBrowserWorkerShutdown({
          registry,
          workers: [queueWorker],
          praxis: {
            shutdown: async () => {
              await browserOwner.terminate();
            },
          },
          closeApplication: async () => {
            applicationClosed = true;
          },
        });
        const submitted = await queue.add("isolated-native-command", {});
        await entered;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(owned.exitConfirmed).toBe(false);
        await shutdown();
        expect(owned.exitConfirmed).toBe(true);
        expect(registry.activeCount).toBe(0);
        expect(applicationClosed).toBe(true);
        const persisted = await queue.getJob(submitted.id!);
        expect(await persisted!.getState()).toBe("completed");
        expect(persisted!.returnvalue).toEqual({ interrupted: true });
        expect(persisted!.attemptsMade).toBe(1);
        expect(failures).toBe(0);
      } finally {
        const cleanup = await Promise.allSettled([
          owned?.terminate(),
          worker?.close(true),
          queue.close(),
          connection.quit(),
        ]);
        expect(cleanup.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      }
    },
    30000,
  );
});
