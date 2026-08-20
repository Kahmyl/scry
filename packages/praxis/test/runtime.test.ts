import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InteractionTargetIntent, PraxisOperation, PraxisRequest } from "@scry/contracts";
import { PraxisAdapter } from "../src/adapter.js";
import {
  PraxisGroundingEngine,
  PraxisMutationLease,
  selectPraxisStrategy,
} from "../src/runtime.js";
import { PraxisDocumentEpoch, PraxisStaleTargetError } from "../src/observation.js";
import { PraxisAdapterError, PraxisTransactionCoordinator } from "../src/transaction.js";
import { executePraxisConsumer } from "../src/consumer.js";
import { observeSemanticPageContext } from "../src/page-context.js";
import { authenticateProtectedReferencedTargets } from "../src/interaction/protected-authentication.js";
import { compileVeilPolicy } from "@scry/veil";
import { VeilAuthority } from "@scry/veil";
import { authorizePraxisRequest, registerPraxisVeilAuthority } from "../src/veil-bridge.js";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  page = await browser.newPage();
  registerPraxisVeilAuthority(page, {
    authority: new VeilAuthority(
      compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://example.test"] }),
    ),
    userId: "test",
    environmentId: "test",
    browserContextId: "test-context",
  });
});
afterAll(async () => {
  await browser?.close();
});
const intent = (name: string, role: "button" | "textbox" = "button"): InteractionTargetIntent => ({
  concept: name,
  requiredCapabilities:
    role === "textbox" ? ["focusable", "accepts_text", "editable"] : ["pointer_activatable"],
  preferredEvidence: {
    roles: [role],
    names: [name],
    labels: [],
    descriptions: [],
    placeholders: [],
    inputTypes: [],
  },
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "ordinary",
  confidence: { requiredFamilies: [], minimum: 0.35, minimumMargin: 0, minimumFamilyCount: 1 },
});
const request = (operation: PraxisOperation, target = intent("Save")): PraxisRequest =>
  authorizePraxisRequest(page, {
    schemaVersion: 1,
    transactionId: `tx-${Math.random()}`,
    operationId: operation.type,
    intent: target,
    operation,
    expectedEffect: { type: "none" },
    risk: target.risk,
    policy: {
      allowedOrigins: ["https://example.test"],
      actionTimeoutMs: 1_000,
      totalTimeoutMs: 2_000,
    },
    privacy: {
      state: "normal",
      allowedChannels: ["public_dom", "accessibility"],
      suppressedChannels: [],
    },
    context: { pageId: "page", origin: "https://example.test", documentEpoch: 0 },
  });

describe("Praxis candidate resume fencing", () => {
  it("rejects a stale candidate before runtime resume dispatch", async () => {
    await page.setContent("<button>Save</button>");

    const engine = new PraxisGroundingEngine(page);

    await expect(
      engine.resume(
        request({ type: "activate" }),
        {
          id: "resume-save",
          intentDigest: "a".repeat(64),
          fingerprint: "b".repeat(64),
          documentEpoch: 0,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "TARGET_CHANGED_BEFORE_ACTION",
    });
  }, 15_000);
});

describe("Praxis strategy, dispatch, and verification", () => {
  it("fills protected fields and activates one exact submit in the same document operation", async () => {
    await page.setContent(`
      <label>Email <input aria-label="Email"></label>
      <label>Password <input aria-label="Password" type="password"></label>
      <button onclick="document.body.dataset.authenticated='yes'">Login</button>
    `);
    const context = await observeSemanticPageContext(page);
    const email = context.controls.find((control) => control.name === "Email")!;
    const password = context.controls.find((control) => control.valueProtected)!;
    const submit = context.controls.find((control) => control.role === "button")!;
    const result = await authenticateProtectedReferencedTargets(page, {
      fields: [
        { targetReference: email.reference, resolveValue: async () => "user@example.test" },
        { targetReference: password.reference, resolveValue: async () => "protected-test-value" },
      ],
      submitReference: submit.reference,
    });
    expect(result).toEqual({ dispatched: true });
    expect(await page.locator("body").getAttribute("data-authenticated")).toBe("yes");
  });

  it("refuses a wrong protected-auth reference before the dispatch boundary", async () => {
    await page.setContent(`<label>Password <input type="password"></label><button>Login</button>`);
    const context = await observeSemanticPageContext(page);
    const password = context.controls.find((control) => control.valueProtected)!;
    let dispatchStarted = false;
    let protectedInputResolved = false;
    await expect(authenticateProtectedReferencedTargets(page, {
      fields: [{ targetReference: password.reference, resolveValue: async () => {
        protectedInputResolved = true;
        return "protected-test-value";
      } }],
      submitReference: "context-control-00000000000000000000000000000000",
    }, () => { dispatchStarted = true; })).rejects.toBeInstanceOf(PraxisStaleTargetError);
    expect(dispatchStarted).toBe(false);
    expect(protectedInputResolved).toBe(false);
    expect(await page.locator("input").inputValue()).toBe("");
  });

  it("does not relabel a pre-mutation setup error as a dispatch failure", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.hit='yes'">Continue</button>`,
    );
    const canary = "sensitive pre-dispatch setup failure";

    const result = await new PraxisTransactionCoordinator(
      new PraxisAdapter(page),
      undefined,
      async () => {
        throw new Error(canary);
      },
    ).execute(
      request({ type: "activate" }, intent("Continue")),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "PRAXIS_INTERNAL_ERROR",
      mutationOutcome: "not_applied",
    });
    if (result.status !== "succeeded")
      expect(result.diagnostics.mutationBoundaryCrossed).toBe(false);

    expect(JSON.stringify(result)).not.toContain(canary);
    expect(await page.locator("body").getAttribute("data-hit")).toBeNull();
  });

  it("explicitly DOM-activates only the exact grounded entity", async () => {
    await page.setContent(`<button onclick="document.body.dataset.hit='exact'">DOM action</button>`);
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(
      request({ type: "activate", mechanism: "dom" }, intent("DOM action")),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "succeeded", mutationOutcome: "applied" });
    expect(await page.locator("body").getAttribute("data-hit")).toBe("exact");
  });

  it("explicitly uses trusted element activation without selector re-resolution", async () => {
    await page.setContent(`<button onclick="document.body.dataset.hit='element'">Element action</button>`);
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(
      request({ type: "activate", mechanism: "element" }, intent("Element action")),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "succeeded", mutationOutcome: "applied" });
    expect(await page.locator("body").getAttribute("data-hit")).toBe("element");
  });

  for (const mechanism of ["dom", "element"] as const) {
    it(`accepts immediate document replacement as factual ${mechanism} activation dispatch`, async () => {
      const route = async (route: import("playwright").Route) => {
        const authenticated = new URL(route.request().url()).pathname === "/authenticated";
        await route.fulfill({
          contentType: "text/html",
          body: authenticated
            ? "<title>Authenticated</title><main>Ready</main>"
            : `<button onclick="location.href='https://example.test/authenticated'">Login</button>`,
        });
      };
      await page.route("https://example.test/**", route);
      try {
        await page.goto("https://example.test/login");
        const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(
          request({ type: "activate", mechanism }, intent("Login")),
          new AbortController().signal,
        );
        expect(result).toMatchObject({ status: "succeeded", mutationOutcome: "applied" });
        await page.waitForURL("https://example.test/authenticated");
        expect(page.url()).toBe("https://example.test/authenticated");
      } finally {
        await page.unroute("https://example.test/**", route);
      }
    });
  }

  it("reports an absent observed target before the transaction deadline masks its cause", async () => {
    await page.setContent("<main><label>Username <input /></label></main>");
    const base = request({ type: "wait_for_state", state: "visible" }, intent("Email", "textbox"));
    const input = authorizePraxisRequest(page, {
      ...base,
      policy: { ...base.policy, totalTimeoutMs: 500 },
    });
    const started = performance.now();
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(
      input,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "PRAXIS_INSUFFICIENT_EVIDENCE",
      mutationOutcome: "not_started",
    });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("keeps waiting while a delayed target produces new evidence", async () => {
    await page.setContent(
      "<main><label>Username <input /></label><script>setTimeout(()=>document.querySelector('main').insertAdjacentHTML('beforeend','<label>Email <input /></label>'),600)</script></main>",
    );
    const base = request({ type: "wait_for_state", state: "visible" }, intent("Email", "textbox"));
    const input = authorizePraxisRequest(page, {
      ...base,
      policy: { ...base.policy, totalTimeoutMs: 2_000 },
    });
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(
      input,
      new AbortController().signal,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "succeeded", mutationOutcome: "not_applied" });
  });

  it("selects typed least-invasive strategies", () => {
    expect(selectPraxisStrategy({ type: "activate" }, "native_click")).toBe("native_activate");
    expect(
      selectPraxisStrategy(
        { type: "enter_text", input: { reference: "x", classification: "public" } },
        "content_editable",
      ),
    ).toBe("content_editable");
    expect(selectPraxisStrategy({ type: "inspect" }, "native_click")).toBe("inspect");
  });

  it("serializes page mutation leases", async () => {
    const first = await PraxisMutationLease.acquire(page, new AbortController().signal);
    let secondAcquired = false;
    const waiting = PraxisMutationLease.acquire(page, new AbortController().signal).then(
      (release) => {
        secondAcquired = true;
        release();
      },
    );
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first();
    await waiting;
    expect(secondAcquired).toBe(true);
  });

  it("owns the mutation lane before observation so concurrent transactions re-ground in order", async () => {
    await page.setContent(
      "<section aria-label='A'><button>A</button></section><section aria-label='B'><button>B</button></section><output>0</output><script>for(const b of document.querySelectorAll('button'))b.onclick=()=>document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1)</script>",
    );
    const scoped = (name: string): InteractionTargetIntent => ({
      ...intent(name),
      scope: { kind: "region", name },
    });
    const context = (ordinal: number) => ({
      channel: "action" as const,
      ordinal,
      allowedOrigins: ["https://example.test"],
      timeoutMs: 2_000,
    });
    const [first, second] = await Promise.all([
      executePraxisConsumer({
        page,
        intent: scoped("A"),
        operation: { type: "activate" },
        context: context(1),
        signal: new AbortController().signal,
      }),
      executePraxisConsumer({
        page,
        intent: scoped("B"),
        operation: { type: "activate" },
        context: context(2),
        signal: new AbortController().signal,
      }),
    ]);
    expect([first.status, second.status]).toEqual(["succeeded", "succeeded"]);
    expect(await page.locator("output").textContent()).toBe("2");
  });

  it("grounds, dispatches, and verifies a control in its owning frame document", async () => {
    await page.setContent(
      `<iframe srcdoc="<button onclick=&quot;parent.document.body.dataset.hit='yes'&quot;>Framed action</button>"></iframe>`,
    );
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(
      request({ type: "activate" }, intent("Framed action")),
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(await page.locator("body").getAttribute("data-hit")).toBe("yes");
    if (result.status === "succeeded")
      expect(result.resolution.target.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not report activation when frame detachment suppresses the click event", async () => {
    await page.mouse.move(0, 0);
    await page.setContent(
      `<iframe id="target" style="margin:200px" srcdoc="<button onpointerover=&quot;parent.document.querySelector('#target').remove()&quot; onclick=&quot;parent.document.body.dataset.hit='yes'&quot;>Detach action</button>"></iframe>`,
    );
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(
      request({ type: "activate" }, intent("Detach action")),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "inconclusive",
      code: "PRAXIS_DISPATCH_FAILED",
      mutationOutcome: "unknown",
      retry: "unsafe",
      safeActions: ["do_not_retry"],
    });
    expect(await page.locator("body").getAttribute("data-hit")).toBeNull();
  });

  it("reports unknown and unsafe when the target disappears after mouse-down input begins", async () => {
    await page.mouse.move(0, 0);
    await page.setContent(`
      <button style="margin:200px">Down then detach</button>
      <script>
        const target = document.querySelector("button");
        target.addEventListener("pointerdown", () => {
          document.body.dataset.down = "yes";
          target.remove();
        });
        target.addEventListener("click", () => { document.body.dataset.hit = "yes"; });
      </script>
    `);
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(
      request({ type: "activate" }, intent("Down then detach")),
      new AbortController().signal,
    );
    expect(await page.locator("body").getAttribute("data-down")).toBe("yes");
    expect(await page.locator("body").getAttribute("data-hit")).toBeNull();
    expect(result).toMatchObject({
      status: "inconclusive",
      code: "PRAXIS_DISPATCH_FAILED",
      mutationOutcome: "unknown",
      retry: "unsafe",
      safeActions: ["do_not_retry"],
    });
  });

  it("dispatches once and verifies the exact intended text", async () => {
    await page.setContent("<input aria-label=Name>");
    const result = await new PraxisTransactionCoordinator(
      new PraxisAdapter(page, async () => "Ada"),
    ).execute(
      request(
        { type: "enter_text", input: { reference: "name", classification: "public" } },
        intent("Name", "textbox"),
      ),
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(await page.locator("input").inputValue()).toBe("Ada");
  });

  it("dispatches public contenteditable text through the pinned entity", async () => {
    await page.setContent(
      '<div role="textbox" aria-label="Notes" contenteditable="true">starting</div>',
    );
    const result = await new PraxisTransactionCoordinator(
      new PraxisAdapter(page, async () => "replacement text"),
    ).execute(
      request(
        { type: "enter_text", input: { reference: "notes", classification: "public" } },
        intent("Notes", "textbox"),
      ),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "succeeded", mutationOutcome: "applied" });
    expect(await page.getByRole("textbox", { name: "Notes" }).textContent()).toBe("replacement text");
  });

  it("dispatches protected contenteditable text through the pinned entity without serializing it", async () => {
    const secret = "protected-contenteditable-canary-91f4";
    await page.setContent(
      '<div data-scry-redacted="true"><div role="textbox" aria-label="Secret notes" contenteditable="true"></div></div>',
    );
    const result = await new PraxisTransactionCoordinator(
      new PraxisAdapter(page, async () => secret),
    ).execute(
      request(
        { type: "enter_text", input: { reference: "secret-notes", classification: "known_secret" } },
        { ...intent("Secret notes", "textbox"), risk: "credential" },
      ),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "succeeded", mutationOutcome: "applied" });
    expect(await page.getByRole("textbox", { name: "Secret notes" }).textContent()).toBe(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not verify select state through a semantic replacement after dispatch", async () => {
    await page.setContent(`
      <label>Tier<select><option>Basic</option><option>Pro</option></select></label>
      <script>
        const originalSelect = document.querySelector("select");
        originalSelect.addEventListener("change", () => {
          const replacement = originalSelect.cloneNode(true);
          replacement.value = "Pro";
          replacement.dataset.replacement = "true";
          originalSelect.replaceWith(replacement);
        }, { once: true });
      </script>
    `);
    const target: InteractionTargetIntent = {
      ...intent("Tier"), requiredCapabilities: ["selects_option"],
      preferredEvidence: { ...intent("Tier").preferredEvidence, roles: ["combobox"] },
    };
    const result = await new PraxisTransactionCoordinator(
      new PraxisAdapter(page, async () => "Pro"),
    ).execute(
      request(
        { type: "select_option", input: { reference: "tier", classification: "public" } },
        target,
      ),
      new AbortController().signal,
    );
    expect(await page.locator('select[data-replacement="true"]').inputValue()).toBe("Pro");
    expect(result).toMatchObject({
      status: "failed", code: "PRAXIS_LOCAL_STATE_NOT_OBSERVED",
      mutationOutcome: "applied", retry: "requires_reobservation", safeActions: ["inspect_artifact"],
    });
  });

  it("dispatches and verifies scroll through the pinned container", async () => {
    await page.setContent('<div title="Audit scroll container" tabindex="0" style="height:50px;overflow:auto"><div style="height:300px"></div></div>');
    const target: InteractionTargetIntent = {
      ...intent("Audit scroll container"),
      requiredCapabilities: ["focusable", "readable_value"],
      preferredEvidence: { ...intent("Audit scroll container").preferredEvidence, roles: [], names: ["Audit scroll container"], labels: ["Audit scroll container"] },
      confidence: { requiredFamilies: [] },
    };
    const result = await new PraxisTransactionCoordinator(new PraxisAdapter(page)).execute(
      request({ type: "scroll", direction: "down" }, target),
      new AbortController().signal,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "succeeded", mutationOutcome: "not_applied" });
    expect(await page.locator('[tabindex="0"]').evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  });

  it("keeps an unexpected adapter failure after native fill unknown and unsafe", async () => {
    await page.setContent("<input aria-label=Name>");

    class FailingFillAdapter extends PraxisAdapter {
      override async dispatch(...args: Parameters<PraxisAdapter["dispatch"]>): ReturnType<
        PraxisAdapter["dispatch"]
      > {
        await super.dispatch(...args);
        throw new Error("forced adapter failure after successful fill dispatch");
      }
    }

    const result = await new PraxisTransactionCoordinator(
      new FailingFillAdapter(page, async () => "Ada"),
    ).execute(
      request({ type: "enter_text", input: { reference: "name", classification: "public" } }, intent("Name", "textbox")),
      new AbortController().signal,
    );

    expect(await page.locator("input").inputValue()).toBe("Ada");
    expect(result).toMatchObject({
      status: "inconclusive",
      code: "PRAXIS_INTERNAL_ERROR",
      mutationOutcome: "unknown",
      retry: "unsafe",
      safeActions: ["do_not_retry"],
    });
  });

  it("denies public literal text at the freshly resolved protected target before dispatch", async () => {
    await page.setContent('<label>Password <input type="password" value="unchanged"></label>');
    const result = await new PraxisTransactionCoordinator(
      new PraxisAdapter(page, async () => "must-not-dispatch"),
    ).execute(
      request(
        { type: "enter_text", input: { reference: "password", classification: "public" } },
        intent("Password", "textbox"),
      ),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "PROTECTED_INPUT_REFERENCE_REQUIRED",
      mutationOutcome: "not_applied",
    });
    expect(await page.locator("input").inputValue()).toBe("unchanged");
  });

  it("refreshes once when an SPA replaces the control immediately beside dispatch", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.count=String(Number(document.body.dataset.count||0)+1)">Continue</button>`,
    );
    class DispatchAdjacentReplacementAdapter extends PraxisAdapter {
      private replaced = false;
      override async dispatch(...args: Parameters<PraxisAdapter["dispatch"]>) {
        if (!this.replaced) {
          this.replaced = true;
          await page.locator("button").evaluate((old) => old.replaceWith(old.cloneNode(true)));
        }
        return super.dispatch(...args);
      }
    }
    const result = await new PraxisTransactionCoordinator(
      new DispatchAdjacentReplacementAdapter(page),
    ).execute(request({ type: "activate" }, intent("Continue")), new AbortController().signal);
    expect(result).toMatchObject({ status: "succeeded", mutationOutcome: "applied" });
    if (result.status === "succeeded") expect(result.timing.providerTimings).toHaveLength(2);
    expect(await page.locator("body").getAttribute("data-count")).toBe("1");
  });

  it("refuses repeated target instability without crossing the mutation boundary", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.count=String(Number(document.body.dataset.count||0)+1)">Continue</button>`,
    );
    class RepeatedInstabilityAdapter extends PraxisAdapter {
      override async revalidate(
        ..._args: Parameters<PraxisAdapter["revalidate"]>
      ): ReturnType<PraxisAdapter["revalidate"]> {
        await page.locator("button").evaluate((old) => old.replaceWith(old.cloneNode(true)));
        throw new PraxisAdapterError("PRAXIS_TARGET_CHANGED_BEFORE_ACTION", {
          provenance: "application",
          mutationOutcome: "not_started",
          retry: "requires_reobservation",
          safeActions: ["reobserve"],
        });
      }
    }
    const result = await new PraxisTransactionCoordinator(
      new RepeatedInstabilityAdapter(page),
    ).execute(request({ type: "activate" }, intent("Continue")), new AbortController().signal);
    expect(result).toMatchObject({ status: "failed", mutationOutcome: "not_started" });
    if (result.status !== "succeeded") {
      expect([
        "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
        "PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL",
      ]).toContain(result.code);
      expect(result.diagnostics.mutationBoundaryCrossed).toBe(false);
    }
    expect(await page.locator("body").getAttribute("data-count")).toBeNull();
  });

  it("does not focus or activate a reactive control before the mutation boundary", async () => {
    await page.setContent(
      `<button onfocus="document.body.dataset.focusPhase=document.body.dataset.phase" onclick="document.body.dataset.clickPhase=document.body.dataset.phase">Continue</button>`,
    );
    const result = await new PraxisTransactionCoordinator(
      new PraxisAdapter(page),
      async (event) => {
        await page.locator("body").evaluate((body, phase) => {
          body.dataset.phase = phase;
        }, event.phase);
      },
    ).execute(request({ type: "activate" }, intent("Continue")), new AbortController().signal);
    expect(result.status).toBe("succeeded");
    expect(await page.locator("body").getAttribute("data-focus-phase")).toBe("dispatching");
    expect(await page.locator("body").getAttribute("data-click-phase")).toBe("dispatching");
  });

  it("re-observes once before dispatch when a render invalidates the grounded handle", async () => {
    await page.setContent(
      "<button onclick='this.dataset.count=String(Number(this.dataset.count||0)+1)'>Save</button>",
    );
    const adapter = new PraxisAdapter(page);
    const original = adapter.revalidate.bind(adapter);
    let invalidated = false;
    adapter.revalidate = async (target, request, signal) => {
      if (!invalidated) {
        invalidated = true;
        await page.locator("body").evaluate((body) => body.append(document.createElement("span")));
        PraxisDocumentEpoch.bump(page);
      }
      return original(target, request, signal);
    };
    const result = await new PraxisTransactionCoordinator(adapter).execute(
      request({ type: "activate" }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "succeeded", mutationOutcome: "applied" });
    expect(await page.locator("button").getAttribute("data-count")).toBe("1");
  });

  it("derives an idempotent transaction identity for a consumer operation", async () => {
    await page.setContent("<output aria-label=Status>Ready</output>");
    const target = {
      ...intent("Status"),
      requiredCapabilities: ["readable_value" as const],
      preferredEvidence: { ...intent("Status").preferredEvidence, roles: ["value" as const] },
    };
    const ids: string[] = [];
    const context = {
      runId: "run-1",
      attemptId: "attempt-1",
      stepId: "step-1",
      channel: "probe" as const,
      ordinal: 0,
      allowedOrigins: ["https://example.test"],
      timeoutMs: 1_000,
      emit: (event: { type: string; transactionId: string }) => {
        if (event.type === "praxis.transaction_started") ids.push(event.transactionId);
      },
    };
    expect(
      (
        await executePraxisConsumer({
          page,
          intent: target,
          operation: { type: "inspect" },
          context,
          signal: new AbortController().signal,
        })
      ).status,
    ).toBe("succeeded");
    expect(
      (
        await executePraxisConsumer({
          page,
          intent: target,
          operation: { type: "inspect" },
          context,
          signal: new AbortController().signal,
        })
      ).status,
    ).toBe("succeeded");
    expect(new Set(ids).size).toBe(1);
  });
});
