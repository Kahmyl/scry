import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { nativeProtectionScript } from "@scry/veil";
import { transportNativeGeometry } from "../src/mcp-native/geometry-transport.mjs";

const browserTest = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;

browserTest(
  "independent font-face load invalidates cached pseudo position despite stable owner CSS",
  async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.SCRY_BROWSER_CHANNEL ? { channel: process.env.SCRY_BROWSER_CHANNEL } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 500 } });
      await page.setContent(
        '<style>#owner{margin:30px;width:1400px;height:80px}#owner::before,#owner::after{font:30px/40px "independent-font",monospace}#owner::before{content:"IIIIIIIIIIIIIIIIIIII"}#owner::after{content:"maple-ref-4938"}</style><div id="owner"></div>',
      );
      const session = await page.context().newCDPSession(page);
      const { frameTree } = await session.send("Page.getFrameTree");
      const { executionContextId } = await session.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "independent-font-cache",
      });
      const evaluate = async (expression: string) => {
        const r = await session.send("Runtime.evaluate", {
          contextId: executionContextId,
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (r.exceptionDetails) throw Error("INDEPENDENT_FONT_PROBE_FAILED");
        return r.result.value;
      };
      await evaluate(nativeProtectionScript(["maple-ref-4938"]));
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const first = await evaluate("__scryNativeGraph.read(1)");
      expect(first.geometryRequired).toBe(true);
      const receipt = await transportNativeGeometry({
        session,
        contextId: executionContextId,
        frameId: frameTree.frame.id,
        isMainFrame: true,
        readId: 1,
        policyGeneration: first.policyGeneration,
        expectedScope: first.geometryScope,
        deadline: Date.now() + 200,
        isCurrent: () => true,
      });
      expect(receipt.ok).toBe(true);
      expect((await evaluate("__scryNativeGraph.paint(1)")).image.state).toBe("available");
      const before = await page.evaluate(() => ({
        box: document.querySelector("#owner")!.getBoundingClientRect().toJSON(),
        font: getComputedStyle(document.querySelector("#owner")!, "::after").font,
      }));
      const advanceBefore = await page.evaluate(() => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = getComputedStyle(document.querySelector("#owner")!, "::before").font;
        return ctx.measureText("IIIIIIIIIIIIIIIIIIII").width;
      });
      const font = await readFile(
        new URL("../../../apps/web/public/fonts/plex/IBMPlexSans-Regular.woff2", import.meta.url),
      );
      await page.evaluate(async (base64) => {
        const face = new FontFace("independent-font", `url(data:font/woff2;base64,${base64})`);
        document.fonts.add(face);
        await face.load();
        await document.fonts.ready;
      }, font.toString("base64"));
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const after = await page.evaluate(() => ({
        box: document.querySelector("#owner")!.getBoundingClientRect().toJSON(),
        font: getComputedStyle(document.querySelector("#owner")!, "::after").font,
      }));
      expect(after).toEqual(before);
      const advanceAfter = await page.evaluate(() => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = getComputedStyle(document.querySelector("#owner")!, "::before").font;
        return ctx.measureText("IIIIIIIIIIIIIIIIIIII").width;
      });
      expect(Math.abs(advanceAfter - advanceBefore)).toBeGreaterThan(100);
      const second = await evaluate("__scryNativeGraph.read(2)");
      // The public preceding pseudo changes its advance after font loading, so
      // its private sibling needs fresh native position even though the owner
      // box, CSS strings, private value and policy remain identical.
      expect(second.geometryRequired).toBe(true);
    } finally {
      await browser.close();
    }
  },
);
