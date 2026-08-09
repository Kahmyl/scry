import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { InteractionTargetIntent } from "@scry/contracts";
import { executeInteractionCompatibility } from "@scry/executor";

import { NativeBrowserDriver } from "../src/runtime/native-browser-driver/index.js";

let origin = "";
let server: ReturnType<typeof createServer>;
let authenticatedRequestHeader: string | undefined;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/users/me") {
      authenticatedRequestHeader = request.headers.authorization;
      response.statusCode = 204;
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<main><label>Email<input placeholder='Work email'></label><button>Continue</button></main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture unavailable");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));

const emailIntent: InteractionTargetIntent = {
  concept: "work email",
  requiredCapabilities: ["focusable", "accepts_text", "editable"],
  preferredEvidence: {
    roles: ["textbox"], names: ["Email"], labels: ["Email"], descriptions: [],
    placeholders: ["Work email"], inputTypes: [],
  },
  scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"],
  risk: "authentication", confidence: { requiredFamilies: [] },
};

describe("NativeBrowserDriver shared primitives", () => {
  it("creates, navigates, resolves, executes, and safely tears down a Mission-owned browser", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await driver.navigateAndWait(opened.page, origin, [origin]);
      await driver.executeSemanticControl(opened.page, emailIntent, {
        type: "fill", value: "protected-value", protected: true,
      });
      const field = await driver.resolveSemanticTarget(opened.page, emailIntent);
      expect(await field.inputValue()).toBe("protected-value");
      expect(await field.getAttribute("data-scry-redacted")).toBe("true");
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("rejects an unapproved origin before navigation", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await expect(driver.navigateAndWait(opened.page, "https://example.com", [origin]))
        .rejects.toThrow("NATIVE_ORIGIN_NOT_ALLOWED");
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("reports an admitted pre-dispatch navigation failure with a safe typed code", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    const unavailableOrigin = "http://127.0.0.1:1";
    try {
      await expect(driver.navigateAndWait(opened.page, unavailableOrigin, [unavailableOrigin], 1_000))
        .rejects.toThrow("NATIVE_NAVIGATION_FAILED");
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("refuses ambiguous exact semantic targets", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent("<button>Continue</button><button>Continue</button>");
      await expect(driver.resolveSemanticTarget(opened.page, {
        ...emailIntent,
        concept: "continue",
        requiredCapabilities: ["pointer_activatable"],
        preferredEvidence: { ...emailIntent.preferredEvidence, roles: ["button"], names: ["Continue"], labels: [], placeholders: [] },
        risk: "ordinary",
      })).rejects.toThrow("NATIVE_TARGET_AMBIGUOUS");
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("ignores hidden duplicate controls before evaluating ambiguity", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent("<a href='#' style='display:none'>Add to cart</a><a href='#'>Add to cart</a>");
      await expect(driver.resolveSemanticTarget(opened.page, {
        ...emailIntent, concept: "add to cart", requiredCapabilities: ["pointer_activatable"],
        preferredEvidence: { ...emailIntent.preferredEvidence, roles: ["link"], names: ["Add to cart"], labels: [], placeholders: [] }, risk: "ordinary",
      })).resolves.toBeDefined();
    } finally { await driver.closeBrowser(opened.browser, opened.context); }
  }, 20_000);

  it("uses a visible named section and typed test ID without exposing raw locators", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent("<section><h2>Product A</h2><button data-testid='product-a-cart'>Add to cart</button></section><section><h2>Product B</h2><button>Add to cart</button></section>");
      const control = await driver.resolveSemanticTarget(opened.page, {
        ...emailIntent, concept: "add product", requiredCapabilities: ["pointer_activatable"],
        preferredEvidence: { ...emailIntent.preferredEvidence, roles: ["button"], names: ["Add to cart"], labels: [], placeholders: [], testIds: ["product-a-cart"] },
        scope: { kind: "section", name: "Product A" }, risk: "ordinary",
      });
      await expect(control.getAttribute("data-testid")).resolves.toBe("product-a-cart");
    } finally { await driver.closeBrowser(opened.browser, opened.context); }
  }, 20_000);

  it("requires complete native capabilities before an interactive target is admitted", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent("<span>Activate</span><button>Activate</button><span>Type</span><input aria-label='Type'>");
      await expect(driver.resolveSemanticTarget(opened.page, {
        ...emailIntent, concept: "activate", requiredCapabilities: ["focusable", "pointer_activatable"],
        preferredEvidence: { ...emailIntent.preferredEvidence, roles: ["text"], names: ["Activate"], labels: [], placeholders: [] }, risk: "ordinary",
      })).rejects.toThrow("NATIVE_TARGET_NOT_FOUND");
      await expect(driver.resolveSemanticTarget(opened.page, {
        ...emailIntent, concept: "activate", requiredCapabilities: ["focusable", "pointer_activatable"],
        preferredEvidence: { ...emailIntent.preferredEvidence, roles: ["button"], names: ["Activate"], labels: [], placeholders: [] }, risk: "ordinary",
      })).resolves.toBeDefined();
      await expect(driver.resolveSemanticTarget(opened.page, {
        ...emailIntent, concept: "fill", requiredCapabilities: ["focusable", "accepts_text", "editable"],
        preferredEvidence: { ...emailIntent.preferredEvidence, roles: ["text"], names: ["Type"], labels: [], placeholders: [] }, risk: "ordinary",
      })).rejects.toThrow("NATIVE_TARGET_NOT_FOUND");
    } finally { await driver.closeBrowser(opened.browser, opened.context); }
  }, 20_000);

  it("admits an ARIA option as a native pointer target without requiring a raw locator", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent("<div role='listbox'><div role='option'>Test Mode</div></div><button disabled>Continue</button><output></output><script>document.querySelector('[role=option]').addEventListener('click',()=>{document.querySelector('output').textContent='selected';setTimeout(()=>document.querySelector('button').disabled=false,120)})</script>");
      await driver.executeSemanticControl(opened.page, {
        ...emailIntent,
        concept: "test mode option",
        requiredCapabilities: ["focusable", "pointer_activatable"],
        preferredEvidence: {
          roles: ["option"], names: ["Test Mode"], labels: [], descriptions: [],
          placeholders: [], inputTypes: [],
        },
        risk: "ordinary",
      }, { type: "click" });
      await expect(opened.page.locator("output").textContent()).resolves.toBe("selected");
      await expect(driver.verifyExpectedEffect(opened.page, {
        type: "state_change",
        target: {
          ...emailIntent,
          concept: "continue",
          requiredCapabilities: ["readable_value"],
          preferredEvidence: {
            roles: ["button"], names: ["Continue"], labels: [], descriptions: [],
            placeholders: [], inputTypes: [],
          },
          risk: "ordinary",
        },
        enabled: true,
      }, opened.page.url(), 2_000)).resolves.toBeUndefined();
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("owns the bounded wait for a semantic target that appears later", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent("<main></main><script>setTimeout(()=>document.querySelector('main').innerHTML='<h1>Dashboard</h1>',150)</script>");
      await expect(driver.executeSemanticControl(opened.page, {
        ...emailIntent,
        concept: "dashboard",
        requiredCapabilities: ["readable_value"],
        preferredEvidence: { roles: ["heading"], names: ["Dashboard"], labels: [], descriptions: [], placeholders: [], inputTypes: [] },
        risk: "ordinary",
      }, { type: "waitFor", state: "visible", timeoutMs: 2_000 })).resolves.toBeUndefined();
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("uses the browser token cookie only inside the Veil request interval and never serializes it", async () => {
    const tokenCanary = "scry-token-canary-never-serialize";
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    const events: unknown[] = [];
    const artifactLike: unknown[] = [];
    const callbackRequests: unknown[] = [];
    const lifecycle: string[] = [];
    const privacyGate = {
      prepare: vi.fn(async () => { lifecycle.push("prepare"); }),
      beginProtected: vi.fn(async () => { lifecycle.push("protected"); }),
      markCaptured: vi.fn(async () => { lifecycle.push("captured"); }),
      beginSafeBoundary: vi.fn(async () => { lifecycle.push("safe-boundary"); }),
      confirmSafeBoundary: vi.fn(async () => { lifecycle.push("confirmed"); }),
      seal: vi.fn(async () => { lifecycle.push("sealed"); }),
    };
    try {
      authenticatedRequestHeader = undefined;
      await driver.navigateAndWait(opened.page, origin, [origin]);
      await opened.context.addCookies([{ name: "token", value: tokenCanary, url: origin }]);
      const outcome = await executeInteractionCompatibility({
        sessionId: "session", operationId: "delete-account", ordinal: 1, page: opened.page,
        action: { type: "sameOriginRequest", method: "DELETE", path: "/users/me", expectedStatus: { min: 204, max: 204 }, authentication: "current_browser_session" },
        policy: { allowedOrigins: [origin], allowPrivateNetwork: true, allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
        privacyGate: privacyGate as never,
        options: {
          outputDirectory: "/tmp/native-cookie-canary",
          onMutationDispatch: async () => { events.push({ type: "dispatch" }); },
          executeSameOriginRequest: async (page, request, allowedOrigins, beforeDispatch) => {
            callbackRequests.push(request);
            return driver.sameOriginRequest(page, request, allowedOrigins, beforeDispatch);
          },
        },
      });
      expect(authenticatedRequestHeader).toBe(`Bearer ${tokenCanary}`);
      expect(lifecycle).toEqual(["prepare", "protected", "captured", "safe-boundary", "confirmed"]);
      expect(outcome.privacyResult).toBe("verified");
      expect(JSON.stringify({ callbackRequests, events, artifactLike, outcome })).not.toContain(tokenCanary);
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);
});
