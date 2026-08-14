import { createServer, type Server } from "node:http";

import { executionPolicySchema, type InteractionTargetIntent } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthoringBrowserSession } from "../src/authoring-browser-session.js";
import { kernelInteractionExecutor, openTestBrowser } from "./kernel-harness.js";

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    const heading =
      request.url === "/second"
        ? "Second page"
        : request.url === "/docs"
          ? "API Documentation"
          : "First page";
    const body = request.url === "/delayed-app" ? `
      <main id="app"></main>
      <script>setTimeout(() => { document.querySelector('#app').innerHTML = '<h1>Ready application</h1><button>Continue</button>'; }, 300)</script>
    ` : request.url === "/protected-controls" ? `
      <main>
        <h1>Protected controls</h1>
        <form aria-label="Change password">
          <label>Current password <input type="password" autocomplete="current-password" /></label>
          <label>New password <input type="password" autocomplete="new-password" /></label>
          <label>Confirm password <input type="password" autocomplete="new-password" /></label>
        </form>
      </main>
    ` : `
      <main>
        <h1>${heading}</h1>
        <a href="/second">Continue</a>
        <a href="/docs" target="_blank">API documentation</a>
        <a href="https://disallowed.example.test/docs" target="_blank">External documentation</a>
        <a href="/slow-docs" target="_blank">Slow API documentation</a>
        <button>Open two pages</button>
        <a href="/docs" target="_blank">Unexpected documentation popup</a>
        <label>
          Name
          <input aria-label="Name" />
        </label>
      </main>
    `;
    if (request.url === "/slow-docs") setTimeout(() => response.end(body), 750);
    else response.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("authoring fixture unavailable");
  }

  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("persistent authoring browser session", () => {
  it("returns a bounded meaningful semantic context from one SPA navigation", async () => {
    const policy = executionPolicySchema.parse({
      allowedOrigins: [origin], trustedScriptOrigins: [origin], allowPrivateNetwork: true,
    });
    const session = await createAuthoringBrowserSession({
      sessionId: "99999999-9999-4999-8999-999999999999",
      environmentId: "authoring-test-environment",
      veilAdmissionKey: "authoring-test-only-veil-admission-key-32-bytes",
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      policy,
      openBrowser: openTestBrowser,
      executeInteraction: kernelInteractionExecutor({
        sessionId: "99999999-9999-4999-8999-999999999999",
        environmentId: "authoring-test-environment",
        policy,
      }),
    });
    try {
      const result = await session.interact({
        type: "navigate", url: `${origin}/delayed-app`, timeoutMs: 2_000,
      });
      expect(result.outcome).toMatchObject({ functionalResult: "succeeded" });
      expect(result.outcome.semanticPageContext?.controls).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "heading", name: "Ready application" }),
        expect.objectContaining({ role: "button", name: "Continue" }),
      ]));
    } finally {
      await session.close();
    }
  }, 20_000);

  it("keeps one Veil-authorized page alive across observations and interactions", async () => {
    const policy = executionPolicySchema.parse({
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
    });
    const executeInteraction = kernelInteractionExecutor({
      sessionId: "11111111-1111-4111-8111-111111111111",
      environmentId: "authoring-test-environment",
      policy,
    });
    const session = await createAuthoringBrowserSession({
      sessionId: "11111111-1111-4111-8111-111111111111",
      environmentId: "authoring-test-environment",
      veilAdmissionKey: "authoring-test-only-veil-admission-key-32-bytes",
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      policy,
      openBrowser: openTestBrowser,
      executeInteraction: async (input) => {
        if (input.operationId === "multiple-documentation-pages")
          await Promise.all([input.context.newPage(), input.context.newPage()]);
        return executeInteraction(input);
      },
    });

    try {
      expect(session.state()).toBe("active");
      expect(session.documentEpoch()).toBe(0);

      await session.page.goto(origin, { waitUntil: "domcontentloaded" });
      await session.observeDocument();

      expect(session.documentEpoch()).toBe(1);
      expect(await session.page.getByRole("heading").textContent()).toBe("First page");

      await session.interact(
        {
          type: "fill",
          target: target("name", "textbox", "Name"),
          value: "Habib",
          timeoutMs: 1_000,
        },
        {
          operationId: "fill-name",
          expectedEffect: {
            type: "value_change",
            target: target("name", "textbox", "Name"),
            expected: "Habib",
          },
          objectiveDelta: "Set the public display name",
        },
      );

      expect(await session.page.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Habib");
      expect(session.documentEpoch()).toBe(1);
      expect(
        documentationContext(
          outcomeOf(
            await session.interact({
              type: "waitFor",
              target: target("api documentation", "link", "API documentation"),
              state: "visible",
              timeoutMs: 1_000,
            }),
          ),
        ),
      ).toMatchObject({
        completeness: { kind: "bounded", truncated: false },
        controls: expect.arrayContaining([
          expect.objectContaining({ role: "link", name: "API documentation" }),
          expect.objectContaining({ role: "textbox", name: "Name" }),
        ]),
      });

      await session.interact({
        type: "click",
        target: target("continue", "link", "Continue"),
        expectedEffect: {
          type: "navigation",
          url: "/second",
          match: "path",
        },
      });

      expect(session.documentEpoch()).toBe(2);
      expect(await session.page.getByRole("heading").textContent()).toBe("Second page");
      expect(session.page.url()).toBe(`${origin}/second`);

      const wrongOrigin = await session.interact(
        {
          type: "click",
          target: target("external documentation", "link", "External documentation"),
          expectedEffect: { type: "new_page", origin },
          timeoutMs: 1_000,
        },
        {
          operationId: "reject-external-documentation-origin",
          expectedEffect: { type: "new_page", origin },
        },
      );
      expect(wrongOrigin.outcome).toMatchObject({
        functionalResult: "failed",
        reasonCode: "EXPECTED_NEW_PAGE_ORIGIN_NOT_ALLOWED",
      });
      await expect.poll(() => session.context.pages().length).toBe(1);

      const documentation = await session.interact(
        {
          type: "click",
          target: target("api documentation", "link", "API documentation"),
          expectedEffect: {
            type: "new_page",
            origin,
          },
        },
        {
          operationId: "open-documentation-popup",
          expectedEffect: {
            type: "new_page",
            origin,
          },
        },
      );

      expect(documentation.outcome).toMatchObject({
        functionalResult: "succeeded",
        mutationOutcome: "applied",
        resolvedTarget: {
          version: 2,
          concept: "api documentation",
          scopeKind: "page",
          structuralPath: [],
        },
      });
      expect(session.page.url()).toBe(`${origin}/docs`);
      expect(await session.page.getByRole("heading").textContent()).toBe("API Documentation");
      expect(session.documentEpoch()).toBe(3);

      const slowDocumentation = await session.interact(
        {
          type: "click",
          target: target("slow api documentation", "link", "Slow API documentation"),
          expectedEffect: { type: "new_page", origin },
          timeoutMs: 2_000,
        },
        {
          operationId: "open-slow-documentation-popup",
          expectedEffect: { type: "new_page", origin },
        },
      );
      expect(slowDocumentation.outcome.functionalResult).toBe("succeeded");
      expect(session.page.url()).toBe(`${origin}/slow-docs`);
      expect(session.documentEpoch()).toBe(4);

      const multiplePages = await session.interact(
        {
          type: "click",
          target: target("open two pages", "button", "Open two pages"),
          expectedEffect: { type: "new_page", origin },
          timeoutMs: 1_000,
        },
        {
          operationId: "multiple-documentation-pages",
          expectedEffect: { type: "new_page", origin },
        },
      );
      expect(multiplePages.outcome).toMatchObject({
        functionalResult: "failed",
        reasonCode: "EXPECTED_NEW_PAGE_AMBIGUOUS",
      });
      await expect.poll(() => session.context.pages().length).toBe(1);

      await session.interact({
        type: "click",
        target: target("unexpected documentation popup", "link", "Unexpected documentation popup"),
        expectedEffect: { type: "none" },
        timeoutMs: 1_000,
      });
      await expect.poll(() => session.context.pages().length).toBe(1);

      const sameTab = await session.interact(
        {
          type: "click",
          target: target("continue", "link", "Continue"),
          expectedEffect: { type: "new_page", origin },
        },
        { operationId: "same-tab-is-not-popup", expectedEffect: { type: "new_page", origin } },
      );
      expect(sameTab.outcome).toMatchObject({
        functionalResult: "failed",
        reasonCode: "EXPECTED_NEW_PAGE_NOT_OBSERVED",
      });

      const missingEffect = await session.interact(
        { type: "fill", target: target("name", "textbox", "Name"), value: "Other", timeoutMs: 200 },
        {
          operationId: "missing-effect",
          expectedEffect: {
            type: "value_change",
            target: target("name", "textbox", "Name"),
            expected: "Never observed",
          },
        },
      );
      expect(missingEffect.outcome).toMatchObject({
        functionalResult: "failed",
        reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
      });

      session.suspend();
      expect(session.state()).toBe("suspended");

      await expect(session.observeDocument()).rejects.toThrow(
        "AUTHORING_BROWSER_SESSION_NOT_ACTIVE",
      );

      session.resume();
      expect(session.state()).toBe("active");
    } finally {
      await session.close();
    }

    expect(session.state()).toBe("released");
  }, 40_000);

  it("fills protected references through a Veil-owned interval without returning plaintext", async () => {
    const policy = executionPolicySchema.parse({
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
    });
    const session = await createAuthoringBrowserSession({
      sessionId: "22222222-2222-4222-8222-222222222222",
      environmentId: "authoring-test-environment",
      veilAdmissionKey: "authoring-test-only-veil-admission-key-32-bytes",
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      policy,
      openBrowser: openTestBrowser,
      executeInteraction: kernelInteractionExecutor({
        sessionId: "22222222-2222-4222-8222-222222222222",
        environmentId: "authoring-test-environment",
        policy,
        secretResolver: async () => "protected-test-value",
      }),
    });

    try {
      await session.page.goto(origin, { waitUntil: "domcontentloaded" });

      const protectedInput = await session.interact({
        type: "fill",
        target: target("name", "textbox", "Name"),
        secretRef: "33333333-3333-4333-8333-333333333333",
      });
      expect(protectedInput.outcome).toMatchObject({
        functionalResult: "succeeded",
        mutationOutcome: "applied",
        privacyResult: "verified",
      });
      expect(JSON.stringify(protectedInput)).not.toContain("protected-test-value");
    } finally {
      await session.close();
    }
  }, 20_000);

  it("fills the exact protected control returned by fresh semantic page context", async () => {
    const policy = executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true });
    const session = await createAuthoringBrowserSession({
      sessionId: "44444444-4444-4444-8444-444444444444",
      environmentId: "authoring-test-environment",
      veilAdmissionKey: "authoring-test-only-veil-admission-key-32-bytes",
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      policy,
      openBrowser: openTestBrowser,
      executeInteraction: kernelInteractionExecutor({
        sessionId: "44444444-4444-4444-8444-444444444444",
        environmentId: "authoring-test-environment",
        policy,
        secretResolver: async () => "protected-reference-value",
      }),
    });

    try {
      await session.page.goto(`${origin}/protected-controls`, { waitUntil: "domcontentloaded" });
      const observed = await session.interact({
        type: "waitFor",
        target: target("protected controls", "heading", "Protected controls"),
        state: "visible",
      });
      const protectedControls = observed.outcome.semanticPageContext!.controls.filter(
        (control) => control.valueProtected,
      );
      expect(protectedControls).toHaveLength(3);
      const selected = protectedControls.find((control) => control.semanticPurpose === "current_password")!;

      const started = performance.now();
      const result = await session.interact({
        type: "fill",
        target: {
          concept: "current password",
          authoritativeReference: selected.reference,
          requiredCapabilities: ["focusable", "accepts_text", "editable"],
          preferredEvidence: {
            roles: [], names: [], labels: [], descriptions: [], placeholders: [], inputTypes: [],
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "authentication",
          confidence: { requiredFamilies: [] },
          matching: "exact",
        },
        secretRef: "55555555-5555-4555-8555-555555555555",
        timeoutMs: 2_000,
      });

      expect(result.outcome).toMatchObject({ functionalResult: "succeeded", privacyResult: "verified" });
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(await session.page.locator('input[autocomplete="current-password"]').inputValue()).toBe(
        "protected-reference-value",
      );
      expect(await session.page.locator('input[autocomplete="new-password"]').first().inputValue()).toBe("");
      expect(JSON.stringify(result)).not.toContain("protected-reference-value");

      const freshProtectedReference = result.outcome.semanticPageContext!.controls.find(
        (control) => control.semanticPurpose === "current_password",
      )!.reference;
      const publicFill = await session.interact({
        type: "fill",
        target: {
          ...referenceTarget(freshProtectedReference),
          concept: "current password as public input",
        },
        value: "must-not-dispatch",
        timeoutMs: 1_000,
      });
      expect(publicFill.outcome).toMatchObject({ functionalResult: "failed", mutationOutcome: "not_applied" });
      expect(await session.page.locator('input[autocomplete="current-password"]').inputValue()).toBe(
        "protected-reference-value",
      );
    } finally {
      await session.close();
    }
  }, 20_000);
});

function outcomeOf(
  result: Awaited<
    ReturnType<import("../src/authoring-browser-session.js").AuthoringBrowserSession["interact"]>
  >,
) {
  return result.outcome;
}

function documentationContext(outcome: ReturnType<typeof outcomeOf>) {
  expect(JSON.stringify(outcome.semanticPageContext).length).toBeLessThan(16_000);
  return outcome.semanticPageContext;
}

function referenceTarget(reference: string): InteractionTargetIntent {
  return {
    concept: "protected input",
    authoritativeReference: reference,
    requiredCapabilities: ["focusable", "accepts_text", "editable"],
    preferredEvidence: {
      roles: [], names: [], labels: [], descriptions: [], placeholders: [], inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "authentication",
    confidence: { requiredFamilies: [] },
    matching: "exact",
  };
}

function target(
  concept: string,
  role: InteractionTargetIntent["preferredEvidence"]["roles"][number],
  name: string,
): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities:
      role === "textbox"
        ? ["focusable", "accepts_text", "editable"]
        : role === "heading"
          ? ["readable_value"]
          : ["pointer_activatable"],
    preferredEvidence: {
      roles: [role],
      names: [name],
      labels: [name],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: {
      kind: "page",
    },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "read_only",
    confidence: {
      requiredFamilies: [],
      minimum: 0.35,
      minimumMargin: 0,
      minimumFamilyCount: 1,
    },
  };
}
