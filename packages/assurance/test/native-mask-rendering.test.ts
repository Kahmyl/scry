import { chromium, type CDPSession, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { nativeProtectionScript, createNativeAdapterProtector } from "@scry/veil";

const browserTest = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;

async function refresh(cdp: CDPSession, contextId: number) {
  await cdp.send("Runtime.evaluate", {
    contextId,
    expression: `new Promise(resolve => {
      globalThis.__scryNativeRefresh();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`,
    awaitPromise: true,
  });
}

async function pixels(page: Page, png: Buffer) {
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return {
      width: image.width,
      data: Array.from(context.getImageData(0, 0, image.width, image.height).data),
    };
  }, png.toString("base64"));
}

describe("native frosted rendering", () => {
  for (const [entry, script] of [
    ["recorder", () => nativeProtectionScript([])],
    ["official adapter", () => createNativeAdapterProtector({}).script],
  ] as const) {
    for (const scale of [1, 1.5, 2]) {
      browserTest(
        `${entry} preserves surrounding pixels and covers changing secrets at scale ${scale}`,
        async () => {
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage({
              viewport: { width: 420, height: 320 },
              deviceScaleFactor: scale,
            });
            await page.setContent(`<style>
            body{margin:0;height:1200px;background:#163754;color:white;font:16px sans-serif}
            input{position:absolute;left:20.1px;top:80.3px;width:230.2px;height:40.4px;box-sizing:border-box;font:20px monospace;caret-color:transparent}
            button{position:absolute;left:20px;top:150px}
            </style><h1>Account settings</h1><input name="apiKey" value="fictional-alpha-key"><button onclick="this.textContent='Saved'">Save</button>`);
            const field = page.locator("input");
            const raw = await page.screenshot();
            await field.fill("fictional-bravo-key-with-a-different-length");
            expect((await page.screenshot()).equals(raw)).toBe(false); // The fixture really exposes different source pixels.
            await field.fill("fictional-alpha-key");
            await field.blur();
            const baseline = await page.screenshot();
            const cdp = await page.context().newCDPSession(page);
            const { frameTree } = await cdp.send("Page.getFrameTree");
            const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
              frameId: frameTree.frame.id,
              worldName: "scry-native-protection",
            });
            await cdp.send("Runtime.evaluate", {
              contextId: executionContextId,
              expression: script(),
            });
            await refresh(cdp, executionContextId);
            const protectedImage = await page.screenshot();
            const box = (await field.boundingBox())!;
            const [uncovered, covered] = await Promise.all([
              pixels(page, baseline),
              pixels(page, protectedImage),
            ]);
            let changedOutside = 0;
            let changedInside = 0;
            for (let offset = 0; offset < covered.data.length; offset += 4) {
              const x = (offset / 4) % covered.width;
              const y = Math.floor(offset / 4 / covered.width);
              const inside =
                // Chromium's composited overflow clip can rasterize one extra
                // device pixel beyond its exact layout bound. Allow only that
                // paint fringe; source independence below stays byte-exact.
                x >= Math.floor(box.x * scale) - 1 &&
                x < Math.ceil((box.x + box.width) * scale) + 1 &&
                y >= Math.floor(box.y * scale) - 1 &&
                y < Math.ceil((box.y + box.height) * scale) + 1;
              if (
                covered.data
                  .slice(offset, offset + 4)
                  .some((value, channel) => value !== uncovered.data[offset + channel])
              ) {
                if (inside) changedInside++;
                else changedOutside++;
              }
            }
            expect(changedInside).toBeGreaterThan(0);
            expect(changedOutside).toBe(0);

            const assertIndependent = async () => {
              await field.fill("fictional-alpha-key");
              await refresh(cdp, executionContextId);
              const first = await page.screenshot();
              await field.fill("fictional-bravo-key-with-a-different-length");
              await refresh(cdp, executionContextId);
              expect((await page.screenshot()).equals(first)).toBe(true);
            };
            await assertIndependent();
            await page.getByRole("button", { name: "Save", exact: true }).click();
            await expect.poll(() => page.getByRole("button").textContent()).toBe("Saved");
            await field.evaluate((element) => {
              element.style.top = "260.3px";
              element.style.left = "-10.1px";
            });
            await page.evaluate(() => window.scrollTo(0, 100));
            await page.setViewportSize({ width: 400, height: 280 });
            await refresh(cdp, executionContextId);
            await assertIndependent();
            await field.fill("");
            await refresh(cdp, executionContextId);
            const empty = await pixels(page, await page.screenshot());
            const emptyBox = (await field.boundingBox())!;
            const sample =
              (Math.floor((emptyBox.y + emptyBox.height / 2) * scale) * empty.width +
                Math.floor((emptyBox.x + emptyBox.width / 2) * scale)) *
              4;
            expect(empty.data.slice(sample, sample + 4)).toEqual([255, 255, 255, 255]);
            await field.evaluate((element) => element.remove());
            await refresh(cdp, executionContextId);
            const retired = await pixels(page, await page.screenshot());
            expect(retired.data.slice(sample, sample + 4)).toEqual([22, 55, 84, 255]);
          } finally {
            await browser.close();
          }
        },
        30000,
      );
    }
  }
});
