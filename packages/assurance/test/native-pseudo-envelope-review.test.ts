import { chromium } from "playwright";
import { expect, it } from "vitest";
import { nativeProtectionScript } from "@scry/veil";

const browserTest = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;
const selected = "FICTIONAL_PRIVATE_48371";
const compare = `async ({raw,erased,protectedImage})=>{
  const decode=async(encoded)=>{const i=new Image();i.src='data:image/png;base64,'+encoded;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return x.getImageData(0,0,c.width,c.height).data;};
  const a=await decode(raw),b=await decode(erased),c=await decode(protectedImage);let glyphs=0,uncovered=0;
  for(let i=0;i<a.length;i+=4)if([0,1,2].some(k=>a[i+k]!==b[i+k])){glyphs++;if([0,1,2].every(k=>a[i+k]===c[i+k]))uncovered++;}
  return {glyphs,uncovered};
}`;

browserTest.each([
  ["ordinary generated line", "", ""],
  ["generated line with top padding", "padding-top:100px", ""],
  ["generated line with top border", "border-top:100px solid transparent", ""],
  ["generated line with reflected ink", "-webkit-box-reflect:below 0px", ""],
  ["generated line with reflected ancestor", "", "-webkit-box-reflect:below 0px"],
])("independent native envelope covers %s or withholds it", async (_name, style, ancestorStyle) => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.SCRY_BROWSER_CHANNEL ? { channel: process.env.SCRY_BROWSER_CHANNEL } : {}),
  });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
    const page = await context.newPage();
    await page.setContent(
      `<style>body{background:white}#wrapper{${ancestorStyle}}#owner{margin:60px;width:500px;height:54px}#owner::after{content:"${selected}";display:block;font:30px/40px monospace;color:#123;${style}}</style><div id="wrapper"><div id="owner"></div></div>`,
    );
    await page.evaluate(() => document.fonts.ready);
    const raw = await page.screenshot();
    const erase = await page.addStyleTag({ content: "#owner::after{color:transparent!important}" });
    const erased = await page.screenshot();
    await erase.evaluate((e) => e.parentNode?.removeChild(e));
    const session = await context.newCDPSession(page);
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "independent-envelope-review",
    });
    const evaluate = async (expression: string) => {
      const response = await session.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.exceptionDetails) throw Error("INDEPENDENT_ENVELOPE_PROBE_FAILED");
      return response.result.value;
    };
    await evaluate(nativeProtectionScript([selected]));
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await evaluate("__scryNativeGraph.read(1)");
    const assessment = await evaluate("__scryNativeGraph.paint(1)");
    if (!style && !ancestorStyle) expect(assessment.image.state).toBe("available");
    if (assessment.image.state === "available") {
      const protectedImage = await page.screenshot();
      const checker = await context.newPage();
      const proof = await checker.evaluate<{ glyphs: number; uncovered: number }>(
        `(${compare})(${JSON.stringify({ raw: raw.toString("base64"), erased: erased.toString("base64"), protectedImage: protectedImage.toString("base64") })})`,
      );
      expect(proof.glyphs).toBeGreaterThan(0);
      expect(proof.uncovered).toBe(0);
    } else {
      expect(assessment.image.state).toBe("withheld");
    }
  } finally {
    await browser.close();
  }
});
