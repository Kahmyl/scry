import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { nativeProtectionScript } from "@scry/veil";

const browserTest = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;
const selected = "maple-reference-4938";

/** Independent recognition/admission regression: no fixture-specific geometry hook. */
async function inspect(pseudo: "before" | "after", generated: string, learned = false) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.SCRY_BROWSER_CHANNEL ? { channel: process.env.SCRY_BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    await page.setContent(
      `<style>body{font:18px/28px sans-serif;background:white;color:#123}
      #board{width:600px}#board::${pseudo}{content:${JSON.stringify(generated)};display:block;font:20px/30px monospace;white-space:pre}
      </style><h1>Community board</h1><div id="board">Independent public caption</div>` +
        (learned ? `<input type="password" value="${selected}">` : ""),
    );
    const session = await page.context().newCDPSession(page);
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "independent-selected-pseudo",
    });
    const evaluate = async (expression: string) => {
      const response = await session.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.exceptionDetails) throw new Error("SELECTED_PSEUDO_PROBE_UNAVAILABLE");
      return response.result.value;
    };
    await evaluate(nativeProtectionScript(learned ? [] : [selected]));
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const read = await evaluate("__scryNativeGraph.read(1)");
    const paint = await evaluate("__scryNativeGraph.paint(1)");
    return {
      text: paint.text,
      knownRequirement: paint.knownRequirement,
      ownerCount: read.imageCandidateRefs.length,
      image: paint.image,
    };
  } finally {
    await browser.close();
  }
}

describe("independent selected-value recognition in generated content", () => {
  for (const pseudo of ["before", "after"] as const) {
    browserTest.each([
      ["public prefix", `Public banner: ${selected}`],
      ["public suffix", `${selected} — reviewed`],
      ["public prefix and suffix", `Public banner: ${selected} (reviewed)`],
    ])(`withholds ::${pseudo} containing a selected substring with %s`, async (_name, value) => {
      const result = await inspect(pseudo, value);
      expect(result.ownerCount).toBeGreaterThan(0);
      expect(result.knownRequirement).toBe("present");
      expect(result.text).toBe("complete");
      expect(result.image.state).toBe("withheld");
    });

    browserTest(`withholds ::${pseudo} containing an automatically learned substring`, async () => {
      const result = await inspect(pseudo, `Public banner: ${selected} (reviewed)`, true);
      expect(result.ownerCount).toBeGreaterThan(1);
      expect(result.knownRequirement).toBe("present");
      expect(result.text).toBe("complete");
      expect(result.image.state).toBe("withheld");
    });

    browserTest(`preserves ordinary unselected ::${pseudo} content`, async () => {
      const result = await inspect(pseudo, "Public banner: gardening group (reviewed)");
      expect(result.ownerCount).toBe(0);
      expect(result.text).toBe("complete");
      expect(result.image.state).toBe("available");
    });
  }
});
