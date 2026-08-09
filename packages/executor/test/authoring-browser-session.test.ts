import { createServer, type Server } from "node:http";

import { executionPolicySchema, type InteractionTargetIntent } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthoringBrowserSession } from "../src/authoring-browser-session.js";
import { kernelInteractionExecutor } from "./kernel-harness.js";

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
    response.end(`
      <main>
        <h1>${heading}</h1>
        <a href="/second">Continue</a>
        <a href="/docs" target="_blank">API documentation</a>
        <label>
          Name
          <input aria-label="Name" />
        </label>
      </main>
    `);
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
  it("keeps one Veil-authorized page alive across observations and interactions", async () => {
    const policy = executionPolicySchema.parse({
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
    });
    const session = await createAuthoringBrowserSession({
      sessionId: "11111111-1111-4111-8111-111111111111",
      environmentId: "authoring-test-environment",
      veilAdmissionKey: "authoring-test-only-veil-admission-key-32-bytes",
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      policy,
      executeInteraction: kernelInteractionExecutor({
        sessionId: "11111111-1111-4111-8111-111111111111",
        environmentId: "authoring-test-environment",
        policy,
      }),
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

      const documentation = await session.interact(
        {
          type: "click",
          target: target("api documentation", "link", "API documentation"),
          expectedEffect: {
            type: "new_region",
            target: {
              ...target("documentation heading", "heading", "API Documentation"),
              requiredCapabilities: ["readable_value"],
            },
          },
        },
        {
          operationId: "open-documentation-popup",
          expectedEffect: {
            type: "new_region",
            target: {
              ...target("documentation heading", "heading", "API Documentation"),
              requiredCapabilities: ["readable_value"],
            },
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
  }, 20_000);

  it("rejects protected or indirect-value authoring interactions", async () => {
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
      executeInteraction: kernelInteractionExecutor({
        sessionId: "22222222-2222-4222-8222-222222222222",
        environmentId: "authoring-test-environment",
        policy,
      }),
    });

    try {
      await session.page.goto(origin, { waitUntil: "domcontentloaded" });

      const unavailableProtectedInput = await session.interact({
        type: "fill",
        target: target("name", "textbox", "Name"),
        secretRef: "33333333-3333-4333-8333-333333333333",
      });
      expect(unavailableProtectedInput.outcome).toMatchObject({
        functionalResult: "failed",
        mutationOutcome: "not_applied",
        reasonCode: "PROTECTED_INPUT_RESOLVER_UNAVAILABLE",
      });
    } finally {
      await session.close();
    }
  }, 20_000);
});

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
