import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import type { ChronicleReplayPlan, ChronicleReplayRendererPort } from "@scry/contracts";

/** Browser mechanics for a replay plan whose artifacts are owned by Chronicle. */
export class BrowserReplayRenderer implements ChronicleReplayRendererPort {
  async render(plan: ChronicleReplayPlan) {
    const browser = await chromium.launch({
      headless: true,
      ...(plan.executablePath ? { executablePath: plan.executablePath } : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1_280, height: 720 },
      serviceWorkers: "block",
      recordVideo: { dir: plan.stagingDirectory, size: { width: 1_280, height: 720 } },
    });
    let replayFailed = false;
    let networkRequests = 0;
    await context.route("**/*", async (route) => {
      networkRequests += 1;
      await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.on("pageerror", () => {
      replayFailed = true;
    });
    page.on("crash", () => {
      replayFailed = true;
    });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#e5e7eb}
    #replay{position:absolute;inset:0 0 56px 0;background:#fff}
    #caption{position:absolute;left:0;right:0;bottom:0;height:56px;box-sizing:border-box;padding:10px 18px;background:#111827;color:#f9fafb;font:14px/18px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    </style><div id="replay"></div><div id="caption">Sanitized replay</div>`);
    const require = createRequire(import.meta.url);
    await page.addScriptTag({
      path: path.resolve(path.dirname(require.resolve("rrweb")), "../umd/rrweb.min.js"),
    });
    await page.evaluate(
      ({ recordedEvents, replaySpeed }) => {
        const host = globalThis as unknown as {
          rrweb: {
            Replayer: new (
              events: unknown[],
              options: Record<string, unknown>,
            ) => { play(offset: number): void };
          };
          __scryReplayer?: { play(offset: number): void };
        };
        host.__scryReplayer = new host.rrweb.Replayer(recordedEvents, {
          root: document.querySelector("#replay"),
          showWarning: false,
          showDebug: false,
          mouseTail: false,
          UNSAFE_replayCanvas: false,
          speed: replaySpeed,
        });
        host.__scryReplayer.play(0);
      },
      { recordedEvents: plan.events, replaySpeed: plan.playbackRate },
    );
    let elapsed = 0;
    let visibleFrameCount = 0;
    for (const [index, frame] of plan.frames.entries()) {
      await page.evaluate((caption) => {
        const element = document.querySelector("#caption");
        if (element) element.textContent = caption;
      }, frame.caption);
      await page.waitForTimeout(Math.max(0, frame.renderOffset - elapsed));
      elapsed = frame.renderOffset;
      const hasVisibleDocument = await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>("#replay iframe");
        const body = frame?.contentDocument?.body;
        return Boolean(body && (body.children.length > 0 || body.textContent?.trim()));
      });
      if (hasVisibleDocument) visibleFrameCount += 1;
      await page.screenshot({
        path: path.join(plan.framesDirectory, `frame-${String(index).padStart(6, "0")}.png`),
      });
    }
    if (elapsed < plan.renderDurationMs) await page.waitForTimeout(plan.renderDurationMs - elapsed);
    const video = page.video();
    await context.close();
    await browser.close();
    return {
      ...(video ? { videoPath: await video.path() } : {}),
      replayFailed,
      networkRequests,
      visibleFrameCount,
    };
  }
}
