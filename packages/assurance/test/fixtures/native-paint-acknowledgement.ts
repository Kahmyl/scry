import assert from "node:assert/strict";
import { chromium } from "playwright";
import { nativeProtectionScript } from "@scry/veil";
import { transportNativeGeometry } from "../../../praxis/src/mcp-native/geometry-transport.mjs";

export const paintAcknowledgementCases = [
  "second-delayed",
  "second-delayed-pseudo",
  "bootstrap-pseudo-gap",
  "first-delayed",
  "first-missing",
  "css-changed",
  "owner-replaced",
  "owner-replaced-normal",
  "layout-changed",
  "policy-changed",
  "observed-gap",
  "old-read",
  "disposed",
] as const;
export type PaintAcknowledgementCase = (typeof paintAcknowledgementCases)[number];

/** Literal browser runtime with only its isolated world's scheduler intercepted. */
export async function nativePaintAcknowledgement(mode: PaintAcknowledgementCase) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.SCRY_BROWSER_CHANNEL ? { channel: process.env.SCRY_BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    const selected = "fictional-paint-reference";
    const pseudo = mode === "second-delayed-pseudo" || mode === "bootstrap-pseudo-gap";
    await page.setContent(
      `<style>body{margin:30px;background:white;font:20px/30px monospace;color:#123}
      #target{display:block;width:650px;height:60px;margin:20px 0}
      #target::after{content:${JSON.stringify(pseudo ? selected : "")};display:inline;font:20px/30px monospace}
      </style><h1>Public fixture</h1><div id="target">${pseudo ? "" : selected}</div>`,
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const session = await page.context().newCDPSession(page);
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "isolated-paint-acknowledgement",
    });
    const evaluate = async (expression: string) => {
      const result = await session.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw Error("PAINT_ACKNOWLEDGEMENT_PROBE_UNAVAILABLE");
      return result.result.value;
    };
    // Store the actual scheduler before replacing it, and invoke selected
    // callbacks on a real animation frame. No scheduler in the app world changes.
    const scheduler = `(() => {
      const frame = requestAnimationFrame.bind(globalThis);
      globalThis.__fixtureFrames = [];
      globalThis.__fixtureFrameCalls = 0;
      globalThis.__fixtureFrame = () => new Promise(resolve => {
        const callback = __fixtureFrames.shift();
        if (!callback) throw Error('MISSING_FIXTURE_FRAME');
        frame(time => { ++__fixtureFrameCalls; callback(time); resolve(true); });
      });
      globalThis.requestAnimationFrame = callback => { __fixtureFrames.push(callback); return __fixtureFrames.length; };
    })()`;
    if (mode === "second-delayed-pseudo") {
      // Isolate the foreground completed-installation path before bootstrap's
      // separately characterized provider-free background callback can run.
      await evaluate(scheduler);
      await evaluate(nativeProtectionScript([selected]));
      await evaluate("__fixtureFrames.length = 0");
    } else {
      await evaluate(nativeProtectionScript([selected]));
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await evaluate(scheduler);
    }
    const read = async (id: number) => {
      const facts = await evaluate(`__scryNativeGraph.read(${id})`);
      if (facts.geometryRequired) {
        const geometry = await transportNativeGeometry({
          session,
          contextId: executionContextId,
          frameId: frameTree.frame.id,
          isMainFrame: true,
          readId: id,
          policyGeneration: facts.policyGeneration,
          expectedScope: facts.geometryScope,
          deadline: Date.now() + 200,
          isCurrent: () => true,
        });
        assert.equal(geometry.ok, true, geometry.reason);
      }
      return facts;
    };
    const initial = await read(1);
    if (mode === "bootstrap-pseudo-gap")
      assert.equal(initial.observedRequiredGap, "native_protection_geometry_unsupported");
    if (mode === "second-delayed-pseudo") assert.equal(initial.observedRequiredGap, undefined);
    await evaluate(`globalThis.__fixtureSettledAtFrames = undefined;
      globalThis.__fixturePaint = __scryNativeGraph.paint(1).then(value => {
        __fixtureSettledAtFrames = __fixtureFrameCalls; return value;
      }); true`);
    const missingFirst =
      mode === "first-delayed" || mode === "first-missing" || mode === "observed-gap";
    if (!missingFirst) await evaluate("__fixtureFrame()");
    if (mode === "css-changed")
      await page.evaluate(() =>
        document.styleSheets[0]!.insertRule("#target{transform:translateX(40px)}"),
      );
    if (mode === "owner-replaced" || mode === "owner-replaced-normal")
      await page.evaluate(() => {
        const owner = document.querySelector("#target")!;
        owner.replaceWith(owner.cloneNode(true));
      });
    if (mode === "layout-changed")
      await page.evaluate(
        () => ((document.querySelector("#target") as HTMLElement).style.marginLeft = "40px"),
      );
    if (mode === "policy-changed") await evaluate("__scryNativeGraph.bind([], 2)");
    if (mode === "old-read") await read(2);
    if (mode === "disposed") await evaluate("__scryNativeGraph.dispose()");
    if (mode === "owner-replaced-normal") {
      assert.equal(await evaluate("__fixtureSettledAtFrames"), undefined);
      await evaluate("__fixtureFrame()");
      assert.equal(await evaluate("__fixtureSettledAtFrames"), 2);
    }
    const result = await evaluate("__fixturePaint");
    const recovered = mode === "second-delayed" || pseudo;
    assert.equal(result.image.state, recovered ? "available" : "withheld");
    // Fallback cannot add a gap after completed installation, nor erase a gap
    // already observed during bootstrap or an earlier read.
    if (recovered) assert.equal(result.observedRequiredGap, initial.observedRequiredGap);
    if (
      [
        "first-delayed",
        "first-missing",
        "observed-gap",
        "owner-replaced",
        "owner-replaced-normal",
      ].includes(mode)
    )
      assert.equal(result.observedRequiredGap, "native_protection_refresh_incomplete");
    if (mode === "old-read" || mode === "disposed") {
      assert.equal(result.image.reason, "native_protection_geometry_stale");
      await evaluate("__fixtureFrame()");
      assert.equal(await evaluate("__scryNativeGraph.visualReady()"), false);
    }
    if (mode === "first-delayed") {
      await evaluate("__fixtureFrame()");
      assert.equal(await evaluate("__scryNativeGraph.visualReady()"), false);
    }
    let recoveredGap: string | undefined;
    if (mode === "observed-gap") {
      await evaluate("__fixtureFrames.length = 0");
      await read(2);
      await evaluate("globalThis.__fixturePaint = __scryNativeGraph.paint(2); true");
      await evaluate("__fixtureFrame()");
      const next = await evaluate("__fixturePaint");
      assert.equal(next.image.state, "available");
      assert.equal(next.observedRequiredGap, "native_protection_refresh_incomplete");
      recoveredGap = next.observedRequiredGap;
    }
    return {
      mode,
      image: result.image,
      observedGap: result.observedRequiredGap ?? null,
      priorGap: initial.observedRequiredGap ?? null,
      recoveredGap: recoveredGap ?? null,
      actualPseudoGeometry: pseudo,
    };
  } finally {
    await browser.close();
  }
}
