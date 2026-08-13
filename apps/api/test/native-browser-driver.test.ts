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
    if (request.url === "/next") {
      response.setHeader("content-type", "text/html");
      response.end("<main><div role='region' aria-label='Destination'>Arrived</div></main>");
      return;
    }
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
  it("clamps native resolution to the remaining action deadline", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent("<main>waiting</main>");
      const started = performance.now();
      await expect(driver.executeSemanticControl(opened.page, emailIntent, {
        type: "click",
        timeoutMs: 10_000,
        resolutionTimeoutMs: 5_000,
        preDispatchDeadlineAt: performance.now() + 120,
      })).rejects.toThrow("NATIVE_TARGET_NOT_FOUND");
      expect(performance.now() - started).toBeLessThan(600);
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("rechecks the deadline after the dispatch boundary callback", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent("<label>Email<input placeholder='Work email'></label>");
      const dispatch = vi.fn();
      await expect(driver.executeSemanticControl(opened.page, emailIntent, {
        type: "fill",
        value: "must-not-dispatch",
        protected: false,
        timeoutMs: 10_000,
        resolutionTimeoutMs: 5_000,
        preDispatchDeadlineAt: performance.now() + 1_000,
      }, async () => {
        dispatch();
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      })).rejects.toThrow("NATIVE_ACTION_DEADLINE_EXCEEDED");
      expect(dispatch).toHaveBeenCalledOnce();
      expect(await opened.page.getByPlaceholder("Work email").inputValue()).toBe("");
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("correlates logical ownership with graceful browser process termination", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser({}, {
      kind: "safe_browser",
      ownerId: "ownership-regression-session",
    });
    const pid = opened.browserProcessId;

    await driver.closeBrowser(opened.browser, opened.context);

    expect(opened.browser.isConnected()).toBe(false);
    expect(opened.ownership).toMatchObject({
      ownerKind: "safe_browser",
      ownerId: "ownership-regression-session",
    });
    expect(opened.ownership.events.map((event) => event.milestone)).toEqual(expect.arrayContaining([
      "created",
      "ownership_acquired",
      "close_requested",
      "graceful_close_started",
      "graceful_close_completed",
      "process_exit_observed",
      "ownership_released",
    ]));
    if (pid !== undefined) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 20_000);

  it("force-terminates an owned browser process through its supported server handle", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser({}, {
      kind: "protected_capsule",
      ownerId: "ownership-regression-operation",
    });
    const pid = opened.browserProcessId;

    await opened.forceClose();

    expect(opened.browser.isConnected()).toBe(false);
    expect(opened.ownership.events.map((event) => event.milestone)).toEqual(expect.arrayContaining([
      "force_close_started",
      "force_close_completed",
      "process_exit_observed",
      "ownership_released",
    ]));
    if (pid !== undefined) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 20_000);

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

  it("prefers a unique section heading over a same-named navigation link", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent(`
        <nav><a href="#createPartnerOrder">Create Order</a></nav>
        <section id="createPartnerOrder">
          <h1>Create Order</h1>
          <label>Client ID<input></label>
        </section>
        <section><h1>List Orders</h1><label>Client ID<input></label></section>
      `);
      const scoped: InteractionTargetIntent = {
        ...emailIntent,
        concept: "create order client ID",
        preferredEvidence: {
          ...emailIntent.preferredEvidence,
          labels: ["Client ID"], names: [], placeholders: [],
        },
        scope: { kind: "section", name: "Create Order" },
      };
      await driver.executeSemanticControl(opened.page, scoped, {
        type: "fill", value: "opaque-protected-value", protected: true,
      });
      expect(await opened.page.locator("#createPartnerOrder input").inputValue())
        .toBe("opaque-protected-value");
      expect(await opened.page.locator("section").nth(1).locator("input").inputValue()).toBe("");
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("rejects genuinely duplicated section headings before dispatch", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    const beforeDispatch = vi.fn();
    try {
      await opened.page.setContent(`
        <section><h1>Create Order</h1><label>Client ID<input></label></section>
        <section><h1>Create Order</h1><label>Client ID<input></label></section>
      `);
      await expect(driver.executeSemanticControl(opened.page, {
        ...emailIntent,
        concept: "create order client ID",
        preferredEvidence: { ...emailIntent.preferredEvidence, labels: ["Client ID"], names: [], placeholders: [] },
        scope: { kind: "section", name: "Create Order" },
      }, { type: "fill", value: "opaque", protected: true }, beforeDispatch))
        .rejects.toThrow("NATIVE_SECTION_SCOPE_AMBIGUOUS");
      expect(beforeDispatch).not.toHaveBeenCalled();
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
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
      await opened.page.setContent("<main></main><script>setTimeout(()=>document.querySelector('main').innerHTML='<h1>Dashboard</h1>',1200)</script>");
      const startedAt = performance.now();
      await expect(driver.executeSemanticControl(opened.page, {
        ...emailIntent,
        concept: "dashboard",
        requiredCapabilities: ["readable_value"],
        preferredEvidence: { roles: ["heading"], names: ["Dashboard"], labels: [], descriptions: [], placeholders: [], inputTypes: [] },
        risk: "ordinary",
      }, { type: "waitFor", state: "visible", timeoutMs: 2_000 })).resolves.toBeUndefined();
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("bounds ordinary target resolution independently from the action timeout", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await opened.page.setContent("<main>No matching control</main>");
      const startedAt = performance.now();
      await expect(driver.executeSemanticControl(opened.page, {
        ...emailIntent,
        concept: "login email",
        preferredEvidence: {
          ...emailIntent.preferredEvidence,
          names: [], labels: [], placeholders: ["Enter your email"], inputTypes: ["email"],
        },
      }, {
        type: "click",
        timeoutMs: 60_000,
        resolutionTimeoutMs: 250,
      })).rejects.toThrow("NATIVE_TARGET_NOT_FOUND");
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("resolves an ordinary textbox that hydrates within the bounded action-resolution window", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    const beforeDispatch = vi.fn(async () => undefined);
    try {
      await opened.page.setContent(`<main></main><script>
        setTimeout(() => {
          document.querySelector('main').innerHTML =
            '<input type="email" placeholder="Enter your email" aria-label="Email">';
        }, 3000);
      </script>`);
      const startedAt = performance.now();
      await expect(driver.executeSemanticControl(opened.page, emailIntent, {
        type: "fill",
        value: "safe-public-characterization-value",
        timeoutMs: 60_000,
        resolutionTimeoutMs: 5_000,
        protected: false,
      }, beforeDispatch)).resolves.toBeUndefined();
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_500);
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(beforeDispatch).toHaveBeenCalledOnce();
      await expect(opened.page.getByPlaceholder("Enter your email").inputValue())
        .resolves.toBe("safe-public-characterization-value");
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("observes the complete semantic match set while mutations remain strictly unique", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    const beforeDispatch = vi.fn(async () => undefined);
    const dialogIntent: InteractionTargetIntent = {
      ...emailIntent,
      concept: "add credential dialog",
      requiredCapabilities: ["readable_value"],
      preferredEvidence: {
        roles: ["dialog"], names: ["Add credential"], labels: [], descriptions: [],
        placeholders: [], inputTypes: [],
      },
      risk: "read_only",
    };
    try {
      await opened.page.setContent(`
        <div role="dialog" aria-label="Add credential">First</div>
        <div role="dialog" aria-label="Add credential">Second</div>`);
      await expect(driver.executeSemanticControl(opened.page, dialogIntent,
        { type: "waitFor", state: "visible", timeoutMs: 500 }, beforeDispatch)).resolves.toBeUndefined();
      await expect(driver.executeSemanticControl(opened.page, dialogIntent,
        { type: "waitFor", state: "attached", timeoutMs: 500 }, beforeDispatch)).resolves.toBeUndefined();
      expect(beforeDispatch).not.toHaveBeenCalled();

      await expect(driver.executeSemanticControl(opened.page, {
        ...dialogIntent, requiredCapabilities: ["observable"], risk: "ordinary",
      }, { type: "click", timeoutMs: 500 }, beforeDispatch)).rejects.toThrow("NATIVE_TARGET_AMBIGUOUS");
      expect(beforeDispatch).not.toHaveBeenCalled();

      await opened.page.evaluate(() => {
        const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
        setTimeout(() => { dialogs[0]!.hidden = true; }, 50);
        setTimeout(() => { dialogs[1]!.hidden = true; }, 100);
      });
      await expect(driver.executeSemanticControl(opened.page, dialogIntent,
        { type: "waitFor", state: "hidden", timeoutMs: 1_000 }, beforeDispatch)).resolves.toBeUndefined();

      await opened.page.evaluate(() => {
        const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
        dialogs.forEach((dialog) => { dialog.hidden = false; });
        setTimeout(() => { dialogs[0]!.remove(); }, 50);
        setTimeout(() => { dialogs[1]!.remove(); }, 100);
      });
      await expect(driver.executeSemanticControl(opened.page, dialogIntent,
        { type: "waitFor", state: "detached", timeoutMs: 1_000 }, beforeDispatch)).resolves.toBeUndefined();

      await opened.page.setContent(`<div role="dialog" aria-label="Add credential">Remaining</div>`);
      await expect(driver.executeSemanticControl(opened.page, dialogIntent,
        { type: "waitFor", state: "hidden", timeoutMs: 150 }, beforeDispatch)).rejects.toThrow("NATIVE_TARGET_NOT_FOUND");
      await expect(driver.executeSemanticControl(opened.page, dialogIntent,
        { type: "waitFor", state: "detached", timeoutMs: 150 }, beforeDispatch)).rejects.toThrow("NATIVE_TARGET_NOT_FOUND");
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("verifies a native mutation's positive effect with observation cardinality", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    const beforeDispatch = vi.fn(async () => undefined);
    try {
      await opened.page.setContent(`<button onclick="document.body.insertAdjacentHTML('beforeend',
        '<div role=&quot;dialog&quot; aria-label=&quot;Done&quot;>One</div><div role=&quot;dialog&quot; aria-label=&quot;Done&quot;>Two</div>')">Launch</button>`);
      await driver.executeSemanticControl(opened.page, {
        ...emailIntent, concept: "launch", requiredCapabilities: ["pointer_activatable"],
        preferredEvidence: { roles: ["button"], names: ["Launch"], labels: [], descriptions: [], placeholders: [], inputTypes: [] },
        risk: "ordinary",
      }, { type: "click" }, beforeDispatch);
      await expect(driver.verifyExpectedEffect(opened.page, {
        type: "visibility_change", visible: true,
        target: {
          ...emailIntent, concept: "done dialog", requiredCapabilities: ["readable_value"],
          preferredEvidence: { roles: ["dialog"], names: ["Done"], labels: [], descriptions: [], placeholders: [], inputTypes: [] },
          risk: "read_only",
        },
      }, opened.page.url(), 1_000)).resolves.toBeUndefined();
      expect(beforeDispatch).toHaveBeenCalledOnce();
      expect(await opened.page.getByRole("dialog", { name: "Done" }).count()).toBe(2);
    } finally {
      await driver.closeBrowser(opened.browser, opened.context);
    }
  }, 20_000);

  it("observes navigation and a target in the current post-navigation document", async () => {
    const driver = new NativeBrowserDriver();
    const opened = await driver.openBrowser();
    try {
      await driver.navigateAndWait(opened.page, origin, [origin]);
      await opened.page.setContent("<button onclick=\"location.href='/next'\">Continue</button>");
      const beforeUrl = opened.page.url();
      await driver.executeSemanticControl(opened.page, {
        ...emailIntent, concept: "continue", requiredCapabilities: ["pointer_activatable"],
        preferredEvidence: { roles: ["button"], names: ["Continue"], labels: [], descriptions: [], placeholders: [], inputTypes: [] },
        risk: "ordinary",
      }, { type: "click" });
      await expect(driver.verifyExpectedEffect(opened.page, {
        type: "navigation", url: `${origin}/next`, match: "exact",
      }, beforeUrl, 2_000)).resolves.toBeUndefined();
      await expect(driver.verifyExpectedEffect(opened.page, {
        type: "new_region",
        target: {
          ...emailIntent, concept: "destination", requiredCapabilities: ["readable_value"],
          preferredEvidence: { roles: ["region"], names: ["Destination"], labels: [], descriptions: [], placeholders: [], inputTypes: [] },
          risk: "read_only",
        },
      }, beforeUrl, 2_000)).resolves.toBeUndefined();
      expect(opened.page.url()).toBe(`${origin}/next`);
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
