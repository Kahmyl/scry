import { chromium } from "playwright";
import { expect, it } from "vitest";
import { nativeProtectionScript } from "@scry/veil";
import { transportNativeGeometry } from "../../praxis/src/mcp-native/geometry-transport.mjs";

const browserTest = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;

browserTest(
  "independent invalid native quads retain an actionable graph paint refusal",
  async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.SCRY_BROWSER_CHANNEL ? { channel: process.env.SCRY_BROWSER_CHANNEL } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
      await page.setContent(
        '<style>#owner{margin:30px;width:500px}#owner::after{content:"maple-ref-4938";display:block;font:20px/30px monospace}</style><div id="owner">Independent public caption</div>',
      );
      const session = await page.context().newCDPSession(page);
      const { frameTree } = await session.send("Page.getFrameTree");
      const { executionContextId } = await session.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "independent-geometry-feedback",
      });
      const evaluate = async (expression: string) => {
        const reply = await session.send("Runtime.evaluate", {
          contextId: executionContextId,
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (reply.exceptionDetails) throw Error("INDEPENDENT_GEOMETRY_FEEDBACK_FAILED");
        return reply.result.value;
      };
      await evaluate(nativeProtectionScript(["maple-ref-4938"]));
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const read = await evaluate("__scryNativeGraph.read(1)");
      expect(read.geometryRequired).toBe(true);
      const faultedSession = new Proxy(session, {
        get(target, key, receiver) {
          if (key !== "send") return Reflect.get(target, key, receiver);
          return async (method: string, params: Record<string, unknown>) => {
            if (method === "DOM.getContentQuads")
              return { quads: [[0, 0, 100, 10, 100, 30, 0, 30]] };
            return session.send(method as never, params as never);
          };
        },
      });
      const transported = await transportNativeGeometry({
        session: faultedSession,
        contextId: executionContextId,
        frameId: frameTree.frame.id,
        isMainFrame: true,
        readId: 1,
        policyGeneration: read.policyGeneration,
        expectedScope: read.geometryScope,
        deadline: Date.now() + 200,
        isCurrent: () => true,
      });
      expect(transported.ok).toBe(false);
      expect(transported.reason).toBe("native_protection_geometry_unsupported");
      // Exercises the actual exported graph wrapper, not only the private
      // capability or transport in isolation. Only finite diagnostics leave it.
      const paint = await evaluate("__scryNativeGraph.paint(1)");
      expect(paint.text).toBe("complete");
      expect(paint.image).toMatchObject({
        state: "withheld",
        reason: "native_protection_geometry_unsupported",
        recovery: "preserve_gap",
      });
    } finally {
      await browser.close();
    }
  },
);
