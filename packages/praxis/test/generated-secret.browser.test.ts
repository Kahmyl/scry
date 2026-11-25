import { beforeAll, afterAll, describe, it, expect } from "vitest";
// @ts-expect-error Private shipped worker helper.
import { captureGeneratedSecret } from "../src/mcp-native/generated-secret.mjs";
// Pinned private adapter Chromium.
import { chromium } from "playwright-mcp-runtime";
import {
  createNativeAdapterProtector,
  VeilBrowserProtection,
  BrowserProtectedValueCipher,
} from "@scry/veil";
import { randomBytes, randomUUID } from "node:crypto";
const live = process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
live("generated value capture in real Chromium", () => {
  let browser: any;
  const origin = "https://fictional-secret.invalid",
    secret = "fictional-generated-value-634827",
    scope = {
      sessionId: randomUUID(),
      runId: randomUUID(),
      projectId: randomUUID(),
      missionId: randomUUID(),
      environmentId: randomUUID(),
      ownerGeneration: 1,
      baseOrigin: origin,
      allowedOrigins: [origin],
      protectionKeyId: "browser-key-1",
      disclosureMode: "confidential" as const,
    };
  beforeAll(async () => {
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function fixture(html: string, selector = "code", trimWhitespace = false) {
    const context = await browser.newContext();
    await context.route("**/*", (route: any) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    const page = await context.newPage();
    await page.goto(origin);
    const input = {
      sourceOrigin: origin,
      target: { selector },
      displayName: "Synthetic generated value",
      permittedUses: ["scoped_request" as const],
      expiresInSeconds: 3600,
      trimWhitespace,
      userConfirmed: true as const,
    };
    const admission = new VeilBrowserProtection().nativeSecretCapture(
      scope,
      input,
      randomUUID(),
      scope.environmentId,
    );
    const result = await captureGeneratedSecret({
      input,
      request: admission.request,
      interactions: { activePage: async () => page },
      protection: createNativeAdapterProtector({}),
      allowedOrigins: [origin],
    });
    return { context, page, result, admission };
  }
  it.each([
    `<code><span>${secret}</span><button onclick="throw Error('must not click')">Copy</button></code>`,
    `<input readonly value="${secret}">`,
    `<textarea readonly>${secret}</textarea>`,
  ])("captures only existing readonly bytes without clicks or clipboard", async (html) => {
    const f = await fixture(
      html,
      html.startsWith("<code") ? "code" : html.startsWith("<input") ? "input" : "textarea",
    );
    try {
      expect(f.result.reason).toBeUndefined();
      expect(JSON.stringify(f.result)).not.toContain(secret);
      const v = f.admission.accept(f.result.sealedSecret);
      expect(
        new BrowserProtectedValueCipher().decrypt(v.encrypted, {
          projectId: scope.projectId,
          protectedValueId: v.metadata.protectedValueId,
          canonicalName: v.metadata.displayName,
          sourceKind: "browser_generated",
        }),
      ).toBe(secret);
    } finally {
      f.admission.dispose();
      await f.context.close();
    }
  });
  it.each([
    ['<input value="' + secret + '">', "input", "source_not_a_readonly_secret_view"],
    ["<div>" + secret + "</div>", "div", "source_not_a_readonly_secret_view"],
    ["<code>a</code><code>b</code>", "code", "source_not_unique"],
    ["<code hidden>" + secret + "</code>", "code", "source_not_a_readonly_secret_view"],
    ['<code style="opacity:0">' + secret + "</code>", "code", "source_not_a_readonly_secret_view"],
    [
      '<code contenteditable="true">' + secret + "</code>",
      "code",
      "source_not_a_readonly_secret_view",
    ],
    ["<code>" + "x".repeat(8193) + "</code>", "code", "source_value_unavailable"],
  ])("refuses unsupported or ambiguous sources", async (html, selector, reason) => {
    const f = await fixture(html, selector);
    try {
      expect(f.result).toEqual({ reason });
    } finally {
      f.admission.dispose();
      await f.context.close();
    }
  });
  it("preserves whitespace unless trimming was explicitly requested", async () => {
    for (const trim of [false, true]) {
      const f = await fixture(`<code>  ${secret}\n</code>`, "code", trim);
      try {
        const v = f.admission.accept(f.result.sealedSecret);
        expect(
          new BrowserProtectedValueCipher().decrypt(v.encrypted, {
            projectId: scope.projectId,
            protectedValueId: v.metadata.protectedValueId,
            canonicalName: v.metadata.displayName,
            sourceKind: "browser_generated",
          }),
        ).toBe(trim ? secret : `  ${secret}\n`);
      } finally {
        f.admission.dispose();
        await f.context.close();
      }
    }
  });
  it.each([
    {
      name: "isolated exact subtree",
      markup: `<span>${secret}</span><button>Copy</button>`,
      buttonStyle: "",
      state: "available",
    },
    {
      name: "partial value inside one subtree",
      markup: `<span>Public prefix ${secret}</span><button>Copy</button>`,
      buttonStyle: "",
      state: "withheld",
    },
    {
      name: "overlapping public button",
      markup: `<span>${secret}</span><button>Copy</button>`,
      buttonStyle: "transform:translateX(-25px)",
      state: "withheld",
    },
  ])(
    "masks only proven atomic text and preserves refusal for $name",
    async ({ markup, buttonStyle, state }) => {
      const context = await browser.newContext(),
        page = await context.newPage(),
        protection = createNativeAdapterProtector({ key: secret });
      try {
        await page.setContent(
          `<style>code{display:flex;gap:16px;align-items:start}button{${buttonStyle}}</style><code>${markup}</code>`,
        );
        const publicBefore = await page.locator("button").screenshot(),
          privateBefore = await page.locator("span").screenshot();
        const cdp = await context.newCDPSession(page),
          { frameTree } = await cdp.send("Page.getFrameTree"),
          world = await cdp.send("Page.createIsolatedWorld", {
            frameId: frameTree.frame.id,
            worldName: "scry-native-protection",
          });
        await cdp.send("Runtime.evaluate", {
          contextId: world.executionContextId,
          expression: protection.script,
        });
        const read = protection.beginNativeRead(),
          source = { pageId: 0, worldId: 0 };
        const facts = await cdp.send("Runtime.evaluate", {
          contextId: world.executionContextId,
          expression: protection.readExpressionFor(source),
          awaitPromise: true,
          returnByValue: true,
        });
        protection.acceptNativeRead(read, facts.result.value, source);
        protection.finishNativeRead(read, true, 0);
        const safe = protection.cleanTextContent(
          [{ type: "text", text: await page.locator("body").ariaSnapshot() }],
          true,
        );
        expect(JSON.stringify(safe)).not.toContain(secret);
        const paint = await cdp.send("Runtime.evaluate", {
          contextId: world.executionContextId,
          expression: protection.pixelExpression,
          awaitPromise: true,
          returnByValue: true,
        });
        protection.acceptNativePaint(read, paint.result.value, source);
        protection.finishNativePaint(read);
        expect(protection.imageEvidence().state).toBe(state);
        if (state === "available") {
          expect((await page.locator("button").screenshot()).equals(publicBefore)).toBe(true);
          expect((await page.locator("span").screenshot()).equals(privateBefore)).toBe(false);
        }
      } finally {
        protection.dispose();
        await context.close();
      }
    },
  );
});
