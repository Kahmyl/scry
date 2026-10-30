import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { OwnedBrowser } from "../src/owned-browser.js";

const live = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;
const options = {
  channel: process.env.SCRY_BROWSER_CHANNEL ?? "chromium",
  launchTimeoutMs: 15000,
  connectTimeoutMs: 5000,
};
describe("real local browser process custody", () => {
  live(
    "does not leave an actual child alive after its remote control connection closes",
    async () => {
      const owned = await OwnedBrowser.launch(options);
      try {
        await owned.browser.newPage();
        await owned.browser.close();
        expect((await owned.close()).exitConfirmed).toBe(true);
        expect(owned.exitConfirmed).toBe(true);
        expect(owned.terminationState).toBe("exited");
      } finally {
        await owned.terminate();
      }
    },
    30000,
  );
  live(
    "executes native controls/CDP and confirms cooperative process exit",
    async () => {
      const owned = await OwnedBrowser.launch(options);
      try {
        const page = await owned.browser.newPage();
        await page.setContent("<button onclick=\"this.textContent='Done'\">Start</button>");
        const cdp = await page.context().newCDPSession(page);
        expect((await cdp.send("Page.getFrameTree")).frameTree.frame.id).toBeTruthy();
        await page.getByRole("button", { name: "Start" }).click();
        expect(await page.getByRole("button").textContent()).toBe("Done");
        expect((await owned.close()).exitConfirmed).toBe(true);
        expect(owned.exitConfirmed).toBe(true);
        expect(owned.browser.isConnected()).toBe(false);
      } finally {
        await owned.terminate();
      }
    },
    30000,
  );
  live(
    "physically terminates a busy renderer and rejects the actual in-flight browser action",
    async () => {
      const owned = await OwnedBrowser.launch(options);
      try {
        const page = await owned.browser.newPage();
        let rejected = false;
        const pending = page
          .evaluate(() => {
            while (true) {
              /* Intentional isolated renderer stall. */
            }
          })
          .catch(() => {
            rejected = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await owned.terminate()).toEqual({ forced: true, exitConfirmed: true });
        await pending;
        expect(rejected).toBe(true);
        expect(owned.browser.isConnected()).toBe(false);
        expect(owned.exitConfirmed).toBe(true);
      } finally {
        await owned.terminate();
      }
    },
    30000,
  );
  live(
    "closes the actual child after a failed connection",
    async () => {
      const launched = vi.spyOn(chromium, "launchServer"),
        connect = vi
          .spyOn(chromium, "connect")
          .mockRejectedValueOnce(new Error("injected_connection_failure"));
      try {
        await expect(OwnedBrowser.launch(options)).rejects.toThrow(
          "SCRY_BROWSER_PROCESS_CONNECT_FAILED",
        );
        const server = await launched.mock.results[0]!.value;
        const child = server.process();
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        launched.mockRestore();
        connect.mockRestore();
      }
    },
    30000,
  );
});
