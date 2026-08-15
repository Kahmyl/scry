import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeAndMaskPraxisVisualRegions, visualRedactionInitScript } from "@scry/praxis";
import { VeilVisualCaptureAuthority, VeilVisualCaptureError } from "@scry/veil";

const policyDigest = "a".repeat(64);
const binding = {
  browserContextId: "context-1",
  pageId: "page-1",
  frameId: "main-frame",
  documentEpoch: 4,
} as const;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext();
  await context.addInitScript({ content: visualRedactionInitScript });
  page = await context.newPage();
});
afterAll(async () => {
  await browser?.close();
});

describe("VeilVisualCaptureAuthority", () => {
  it("discovers and masks sensitive and opaque surfaces before issuing a bound permit", async () => {
    await page.setContent(
      `<style>#bg{background-image:linear-gradient(#f0f,#f0f)}#pseudo::before{content:'';display:block;width:4px;height:4px;background-image:linear-gradient(#f0f,#f0f)}</style><input value="canary"><div aria-label="medical account">private</div><canvas></canvas><svg><text>secret</text></svg><video></video><iframe src="about:blank"></iframe><img alt="canary" width="4" height="4"><picture></picture><div id="bg"></div><div id="pseudo"></div><div id="closed"></div><script>document.querySelector('#closed').attachShadow({mode:'closed'}).innerHTML='<span>secret</span>'</script>`,
    );
    const authority = new VeilVisualCaptureAuthority(policyDigest);
    const observation = await observeAndMaskPraxisVisualRegions(page);
    const { permit, regions } = authority.issue(observation, binding);

    expect(new Set(regions.map((region) => region.surface))).toEqual(
      new Set([
        "editable",
        "aria_sensitive",
        "unclassified_text",
        "image",
        "css_image",
        "canvas",
        "svg",
        "video",
        "cross_origin_frame",
        "closed_shadow",
      ]),
    );
    expect(regions.every((region) => region.masked)).toBe(true);
    expect(permit).toMatchObject({ policyDigest, ...binding, regionCount: regions.length });
    expect(
      await page.locator("input").evaluate((element) => getComputedStyle(element).filter),
    ).not.toBe("none");
    expect(permit.maskDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses stale geometry and changed documents", async () => {
    await page.setContent(`<input id="secret" value="canary" style="width:100px">`);
    const authority = new VeilVisualCaptureAuthority(policyDigest);
    const { permit } = authority.issue(await observeAndMaskPraxisVisualRegions(page), binding);
    await page.locator("#secret").evaluate((element) => {
      element.setAttribute("style", "width:200px");
      const dynamic = document.createElement("div");
      dynamic.id = "dynamic-secret";
      dynamic.textContent = "new health canary";
      document.body.appendChild(dynamic);
    });
    await page.waitForTimeout(0);
    expect(
      await page.locator("#dynamic-secret").evaluate((element) => getComputedStyle(element).filter),
    ).not.toBe("none");
    const changed = await observeAndMaskPraxisVisualRegions(page);
    expect(() => authority.validate(changed, permit, binding)).toThrowError(
      expect.objectContaining({ code: "VEIL_CAPTURE_DOCUMENT_CHANGED" }),
    );
  });

  it("refuses cross-context, stale-epoch, expired, forged, and replayed permits", async () => {
    await page.setContent(`<textarea>canary</textarea>`);
    let now = 1_000;
    const authority = new VeilVisualCaptureAuthority(policyDigest, () => now, 100);
    const observation = await observeAndMaskPraxisVisualRegions(page);
    const first = authority.issue(observation, binding);
    expect(() =>
      authority.validate(observation, first.permit, { ...binding, documentEpoch: 5 }),
    ).toThrowError(expect.objectContaining({ code: "VEIL_CAPTURE_CONTEXT_MISMATCH" }));
    expect(() =>
      authority.validate(observation, { ...first.permit, maskDigest: "b".repeat(64) }, binding),
    ).toThrowError(expect.objectContaining({ code: "VEIL_CAPTURE_PERMIT_INVALID" }));
    now = 1_101;
    expect(() => authority.validate(observation, first.permit, binding)).toThrowError(
      expect.objectContaining({ code: "VEIL_CAPTURE_PERMIT_EXPIRED" }),
    );

    now = 2_000;
    const secondObservation = await observeAndMaskPraxisVisualRegions(page);
    const second = authority.issue(secondObservation, binding);
    await authority.capture(secondObservation, second.permit, binding, async () => "captured");
    expect(() => authority.validate(secondObservation, second.permit, binding)).toThrow(
      VeilVisualCaptureError,
    );
  });
});
