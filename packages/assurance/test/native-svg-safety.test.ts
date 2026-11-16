import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNativeAdapterProtector, nativeProtectionScript } from "@scry/veil";

const enabled = process.env.SCRY_BROWSER_E2E === "1";
const browserTest = enabled ? it : it.skip;
const value = "FICTIONAL_PRIVATE_74219";

type Scenario = {
  name: string;
  kind: "svg" | "pseudo";
  nonatomic?: boolean;
  style?: string;
  attributes?: string;
  childAttributes?: string;
  overflow?: string;
  x?: number;
  y?: number;
  outcome: "available" | "withheld" | "covered-or-withheld";
  outset?: boolean;
};

type PixelProof = {
  privateGlyphPixels: number;
  coveredPrivateGlyphPixels: number;
  privatePixelsOutsideSvg: number;
  publicPixelsChanged: number;
};

const scenarios: Scenario[] = [
  { name: "ordinary non-atomic SVG", kind: "svg", nonatomic: true, outcome: "available" },
  {
    name: "SVG attribute stroke",
    kind: "svg",
    nonatomic: true,
    attributes: 'stroke="#123" stroke-width="26"',
    outcome: "withheld",
  },
  {
    name: "SVG CSS text stroke",
    kind: "svg",
    nonatomic: true,
    style: "-webkit-text-stroke:20px #123",
    outcome: "withheld",
  },
  {
    name: "SVG descendant tspan stroke override",
    kind: "svg",
    nonatomic: true,
    childAttributes: 'stroke="#123" stroke-width="26"',
    outcome: "withheld",
  },
  {
    name: "SVG text decoration",
    kind: "svg",
    nonatomic: true,
    style: "text-decoration:underline",
    outcome: "withheld",
  },
  {
    name: "SVG outline",
    kind: "svg",
    nonatomic: true,
    style: "outline:18px solid #123",
    outcome: "withheld",
  },
  { name: "ordinary clipped atomic SVG", kind: "svg", overflow: "hidden", outcome: "available" },
  {
    name: "atomic SVG negative-position overflow",
    kind: "svg",
    overflow: "visible",
    x: -60,
    outcome: "covered-or-withheld",
    outset: true,
  },
  {
    name: "atomic SVG stroked overflow",
    kind: "svg",
    overflow: "visible",
    x: 2,
    y: 32,
    attributes: 'stroke="#123" stroke-width="40"',
    outcome: "withheld",
    outset: true,
  },
  { name: "ordinary whole-private pseudo", kind: "pseudo", outcome: "available" },
  {
    name: "pseudo font size adjustment",
    kind: "pseudo",
    style: "font-size-adjust:2",
    outcome: "withheld",
  },
  {
    name: "pseudo CSS text stroke",
    kind: "pseudo",
    style: "-webkit-text-stroke:20px #123",
    outcome: "withheld",
  },
  {
    name: "pseudo text decoration",
    kind: "pseudo",
    style: "text-decoration:underline",
    outcome: "withheld",
  },
  {
    name: "pseudo outline",
    kind: "pseudo",
    style: "outline:18px solid #123",
    outcome: "withheld",
  },
];

function fixture(scenario: Scenario) {
  const graphic =
    scenario.kind === "svg"
      ? `<svg id="graphic" viewBox="0 0 700 300" style="overflow:${scenario.overflow ?? "hidden"}">
          ${scenario.nonatomic ? '<rect width="700" height="300" fill="#fff5e5"/>' : ""}
          <text id="payload" x="${scenario.x ?? 30}" y="${scenario.y ?? 100}" font-size="30" font-family="monospace" fill="#123" ${scenario.attributes ?? ""} style="${scenario.style ?? ""}">${scenario.childAttributes ? `<tspan ${scenario.childAttributes}>${value}</tspan>` : value}</text>
        </svg>`
      : '<div id="payload"></div>';
  return `<style>
    body{margin:8px;background:white;color:#123;font:16px sans-serif}
    svg{display:block;margin-left:100px;width:700px;height:300px}
    #payload:not(text){margin:24px 0 0 100px;width:460px;height:54px}
    #payload:not(text)::after{content:"${value}";display:block;font:30px/40px monospace;color:#123;${scenario.style ?? ""}}
  </style><p id="public">Public route remains open</p>${graphic}`;
}

// A literal browser program avoids server transpiler helpers in the page realm.
// Only counts leave the page; source pixels and the selected value stay private.
const compareProgram = `async ({raw,erased,protectedImage,publicBox,svgBox}) => {
  const decode=async(encoded)=>{
    const image=new Image();image.src='data:image/png;base64,'+encoded;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    return {width:image.width,height:image.height,data:ctx.getImageData(0,0,image.width,image.height).data};
  };
  const a=await decode(raw),b=await decode(erased),c=protectedImage?await decode(protectedImage):null;
  let privateGlyphPixels=0,coveredPrivateGlyphPixels=0,privatePixelsOutsideSvg=0,publicPixelsChanged=0;
  for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
    const i=(y*a.width+x)*4,privatePixel=[0,1,2].some(k=>a.data[i+k]!==b.data[i+k]);
    if(privatePixel){
      privateGlyphPixels++;
      if(c&&[0,1,2].some(k=>a.data[i+k]!==c.data[i+k]))coveredPrivateGlyphPixels++;
      if(svgBox&&(x<svgBox.x||x>=svgBox.x+svgBox.width||y<svgBox.y||y>=svgBox.y+svgBox.height))privatePixelsOutsideSvg++;
    }
    if(c&&x>=publicBox.x&&x<publicBox.x+publicBox.width&&y>=publicBox.y&&y<publicBox.y+publicBox.height&&[0,1,2].some(k=>a.data[i+k]!==c.data[i+k]))publicPixelsChanged++;
  }
  return {privateGlyphPixels,coveredPrivateGlyphPixels,privatePixelsOutsideSvg,publicPixelsChanged};
}`;

async function erasePrivatePaint(page: Page, scenario: Scenario) {
  if (scenario.kind === "pseudo") {
    const style = await page.addStyleTag({
      content:
        "#payload::after{color:transparent!important;-webkit-text-fill-color:transparent!important;-webkit-text-stroke-color:transparent!important;text-decoration-color:transparent!important}",
    });
    const image = await page.screenshot();
    await style.evaluate((element) => element.parentNode?.removeChild(element));
    return image;
  }
  const original = await page.locator("#payload").evaluate((element) => {
    const nodes = [element, ...element.querySelectorAll("*")] as SVGElement[];
    const styles = nodes.map((text) => text.getAttribute("style"));
    for (const text of nodes) {
      text.style.fill = "transparent";
      text.style.stroke = "transparent";
      text.style.webkitTextStrokeColor = "transparent";
      text.style.textDecorationColor = "transparent";
    }
    return styles;
  });
  const image = await page.screenshot();
  await page.locator("#payload").evaluate((element, styles) => {
    const nodes = [element, ...element.querySelectorAll("*")];
    for (const [index, node] of nodes.entries()) {
      const style = styles[index];
      if (style === null || style === undefined) node.removeAttribute("style");
      else node.setAttribute("style", style);
    }
  }, original);
  return image;
}

describe("native SVG and pseudo ink safety", () => {
  let browser: Browser | undefined;
  beforeAll(async () => {
    if (enabled)
      browser = await chromium.launch({
        headless: true,
        ...(process.env.SCRY_BROWSER_CHANNEL ? { channel: process.env.SCRY_BROWSER_CHANNEL } : {}),
      });
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const entry of ["recorder", "adapter"] as const) {
    for (const scenario of scenarios) {
      browserTest(
        `${entry}: ${scenario.name}`,
        async () => {
          const context = await browser!.newContext({ viewport: { width: 900, height: 500 } });
          const protection = createNativeAdapterProtector({ selected: value });
          try {
            const page = await context.newPage();
            await page.setContent(fixture(scenario));
            await page.evaluate(() => document.fonts.ready);
            const publicBox = await page.locator("#public").boundingBox();
            const svgBox =
              scenario.kind === "svg" ? await page.locator("#graphic").boundingBox() : null;
            const raw = await page.screenshot();
            const erased = await erasePrivatePaint(page, scenario);
            const cdp = await context.newCDPSession(page);
            const { frameTree } = await cdp.send("Page.getFrameTree");
            const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
              frameId: frameTree.frame.id,
              worldName: "scry-svg-safety",
            });
            const evaluate = async (expression: string) => {
              const result = await cdp.send("Runtime.evaluate", {
                contextId: executionContextId,
                expression,
                returnByValue: true,
                awaitPromise: true,
              });
              expect(Boolean(result.exceptionDetails)).toBe(false);
              return result.result.value;
            };
            await evaluate(
              entry === "recorder" ? nativeProtectionScript([value]) : protection.script,
            );
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            await evaluate("__scryNativeGraph.read(1)");
            const result = await evaluate("__scryNativeGraph.paint(1)");
            const image = result.image.state === "available" ? await page.screenshot() : null;
            const checker = await context.newPage();
            const proof = await checker.evaluate<PixelProof>(
              `(${compareProgram})(${JSON.stringify({
                raw: raw.toString("base64"),
                erased: erased.toString("base64"),
                protectedImage: image?.toString("base64") ?? null,
                publicBox,
                svgBox,
              })})`,
            );
            expect(proof.privateGlyphPixels).toBeGreaterThan(0);
            if (scenario.outset) expect(proof.privatePixelsOutsideSvg).toBeGreaterThan(0);
            if (scenario.outcome === "available") expect(result.image.state).toBe("available");
            if (scenario.outcome === "withheld") expect(result.image.state).toBe("withheld");
            if (result.image.state === "withheld") {
              expect(result.image.reason).toBe("native_protection_geometry_unsupported");
            } else {
              expect(proof.coveredPrivateGlyphPixels).toBe(proof.privateGlyphPixels);
              expect(proof.publicPixelsChanged).toBe(0);
            }
            await evaluate("__scryNativeGraph.dispose()");
            await cdp.detach();
          } finally {
            protection.dispose();
            await context.close();
          }
        },
        15000,
      );
    }
  }
});
