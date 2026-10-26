import { describe, expect, it } from "vitest";
import { CommandLane } from "../src/command-lane.js";
import { OwnedBrowser } from "../src/owned-browser.js";
const live = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;
const options = { channel: process.env.SCRY_BROWSER_CHANNEL ?? "chromium" };
describe("native command-attempt cancellation", () => {
  live(
    "expires a real busy renderer and waits for physical exit plus protocol settlement",
    async () => {
      const browser = await OwnedBrowser.launch(options),
        lane = new CommandLane();
      let actionSettled = false;
      try {
        const page = await browser.browser.newPage();
        await expect(
          lane.run({ remainingMs: 150 }, async (scope) => {
            scope.bind({
              stop: async () => {
                await browser.terminate();
              },
            });
            try {
              await page.evaluate(() => {
                while (true) {
                  /* Isolated native renderer stall. */
                }
              });
            } finally {
              actionSettled = true;
            }
          }),
        ).rejects.toThrow("COMMAND_DEADLINE_EXCEEDED");
        expect(actionSettled).toBe(true);
        expect(browser.exitConfirmed).toBe(true);
        expect(await lane.run({ remainingMs: 1000 }, async () => "drained")).toBe("drained");
      } finally {
        await browser.terminate();
      }
    },
    30000,
  );
  live(
    "owns and terminates a browser that launches after its command was cancelled",
    async () => {
      const lane = new CommandLane(),
        cancel = new AbortController();
      let start!: () => void,
        entered!: () => void,
        browser: OwnedBrowser | undefined,
        acquisition: Promise<OwnedBrowser> | undefined,
        dispatched = false;
      const release = new Promise<void>((resolve) => {
          start = resolve;
        }),
        acquiring = new Promise<void>((resolve) => {
          entered = resolve;
        });
      const running = lane.run({ remainingMs: 10000, signal: cancel.signal }, async (scope) => {
        scope.bind({
          stop: async () => {
            if (acquisition) await (await acquisition).terminate();
          },
        });
        acquisition = (async () => {
          entered();
          await release;
          browser = await OwnedBrowser.launch(options);
          return browser;
        })();
        await acquisition;
        scope.assertActive();
        dispatched = true;
      });
      const rejection = expect(running).rejects.toThrow("COMMAND_CANCELLED");
      try {
        await acquiring;
        cancel.abort();
        start();
        await rejection;
        expect(browser?.exitConfirmed).toBe(true);
        expect(dispatched).toBe(false);
      } finally {
        start();
        await running.catch(() => undefined);
        await browser?.terminate();
      }
    },
    30000,
  );
  live(
    "does not let an old signal stop the browser now serving the next command",
    async () => {
      const browser = await OwnedBrowser.launch(options),
        lane = new CommandLane(),
        old = new AbortController();
      const resource = {
        stop: async () => {
          await browser.terminate();
        },
      };
      try {
        const page = await browser.browser.newPage();
        await page.setContent("<button onclick=\"this.textContent='Done'\">Start</button>");
        await lane.run({ remainingMs: 10000, signal: old.signal }, async (scope) => {
          scope.bind(resource);
        });
        await lane.run({ remainingMs: 10000 }, async (scope) => {
          scope.bind(resource);
          old.abort();
          scope.assertActive();
          await page
            .getByRole("button", { name: "Start" })
            .click({ timeout: scope.remainingMs(5000) });
          expect(await page.getByRole("button").textContent()).toBe("Done");
          expect(browser.exitConfirmed).toBe(false);
        });
      } finally {
        await browser.terminate();
      }
    },
    30000,
  );
  live(
    "cancels one actual browser without interrupting another session's native controls",
    async () => {
      const first = await OwnedBrowser.launch(options),
        second = await OwnedBrowser.launch(options),
        cancel = new AbortController();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      try {
        const pageA = await first.browser.newPage(),
          pageB = await second.browser.newPage();
        await pageB.setContent("<button onclick=\"this.textContent='Independent'\">Start</button>");
        const running = new CommandLane().run(
          { remainingMs: 10000, signal: cancel.signal },
          async (scope) => {
            scope.bind({
              stop: async () => {
                await first.terminate();
              },
            });
            entered();
            await pageA.evaluate(() => {
              while (true) {
                /* Independent stalled session. */
              }
            });
          },
        );
        const rejection = expect(running).rejects.toThrow("COMMAND_CANCELLED");
        await started;
        cancel.abort();
        await new CommandLane().run({ remainingMs: 10000 }, async (scope) => {
          scope.bind({
            stop: async () => {
              await second.terminate();
            },
          });
          await pageB
            .getByRole("button", { name: "Start" })
            .click({ timeout: scope.remainingMs(5000) });
          expect(await pageB.getByRole("button").textContent()).toBe("Independent");
        });
        await rejection;
        expect(first.exitConfirmed).toBe(true);
        expect(second.exitConfirmed).toBe(false);
      } finally {
        await Promise.all([first.terminate(), second.terminate()]);
      }
    },
    30000,
  );
});
