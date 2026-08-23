import { acquisitionIntentSchema } from "@scry/contracts";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretRedactor } from "@scry/policy";

import {
  acquireValue,
  protectedAcquisitionAdapterRegistry,
  registerProtectedAcquisitionAdapter,
} from "@scry/executor";
import {
  acquireProtectedOutputs,
  extractAndPersistProtectedOutputs,
} from "../src/runtime/protected-transactions/protected-transaction-acquisition.js";
import type {
  ProtectedTransactionDependencies,
  ProtectedTransactionFacts,
} from "../src/runtime/protected-transactions/protected-transaction-coordinator.js";

const target = {
  concept: "generated_value",
  requiredCapabilities: ["readable_value"],
  preferredEvidence: {
    roles: ["textbox"],
    names: ["Generated value"],
    labels: ["Generated value"],
    descriptions: [],
    placeholders: [],
    inputTypes: ["text"],
  },
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "protected",
  confidence: {
    requiredFamilies: ["accessibility"],
    minimum: 0.8,
    minimumMargin: 0.1,
    minimumFamilyCount: 2,
  },
} as const;

describe("protected acquisition adapter registry", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("exposes the approved PR10 adapter surface without executable agent code", () => {
    expect(Object.keys(protectedAcquisitionAdapterRegistry()).sort()).toEqual([
      "clipboard_event",
      "copy_control",
      "download_content",
      "input_value",
      "keyboard_copy",
      "ocr_region",
      "protected_network_value",
      "selected_text",
      "text_content",
    ]);
  });

  it("distinguishes capture objectives from copy-experience verification", () => {
    const registry = protectedAcquisitionAdapterRegistry();

    expect(registry.copy_control.objectiveTypes).toContain("verify_user_copy_experience");
    expect(registry.keyboard_copy.objectiveTypes).toEqual(["verify_user_copy_experience"]);
    expect(registry.input_value.objectiveTypes).toEqual(["capture_value"]);
  });

  it("refuses static extraction for a copy-experience objective", async () => {
    const acquisition = acquisitionIntentSchema.parse({
      target,
      classification: "unknown_secret",
      objective: {
        kind: "verify_user_copy_experience",
        expectedValueType: "unknown_secret",
      },
      permittedMethods: ["text_content"],
      validation: { minimumLength: 1, maximumLength: 100 },
    });

    await expect(acquireValue(null as never, acquisition, 100)).rejects.toMatchObject({
      code: "ACQUISITION_OBJECTIVE_METHOD_MISMATCH",
    });
  });

  it("routes protected network acquisition only through a registered runtime adapter", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    const unregister = registerProtectedAcquisitionAdapter(
      "vitract.generated-value",
      async () => "registered-protected-value",
    );
    try {
      const page = await browser.newPage();
      await page.setContent(`<label>Generated value<input value="masked"></label>`);
      const acquisition = acquisitionIntentSchema.parse({
        target,
        classification: "unknown_secret",
        objective: { kind: "capture_value", expectedValueType: "unknown_secret" },
        permittedMethods: ["protected_network_value"],
        adapter: { id: "vitract.generated-value", configuration: { field: "value" } },
        validation: { minimumLength: 1, maximumLength: 100 },
      });

      await expect(acquireValue(page, acquisition, 2_000)).resolves.toMatchObject({
        value: "registered-protected-value",
      });
      expect(() =>
        registerProtectedAcquisitionAdapter("vitract.generated-value", async () => "duplicate"),
      ).toThrowError(/ACQUISITION_ADAPTER_ALREADY_REGISTERED/);
    } finally {
      unregister();
      await browser.close();
    }
  }, 15_000);

  it("runs a protected network adapter without requiring a DOM target", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    const unregister = registerProtectedAcquisitionAdapter(
      "system.network-only",
      async () => "network-only-protected-value",
    );
    try {
      const page = await browser.newPage();
      await page.setContent(`<main>No generated value is rendered</main>`);
      const acquisition = acquisitionIntentSchema.parse({
        target,
        classification: "unknown_secret",
        objective: { kind: "capture_value", expectedValueType: "unknown_secret" },
        permittedMethods: ["protected_network_value"],
        adapter: { id: "system.network-only", configuration: {} },
        validation: { minimumLength: 1, maximumLength: 100 },
      });

      await expect(acquireValue(page, acquisition, 2_000)).resolves.toMatchObject({
        value: "network-only-protected-value",
        result: { adapter: "protected_network_value" },
      });
    } finally {
      unregister();
      await browser.close();
    }
  }, 15_000);

  it("prefers an approved response value over a masked DOM fallback", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    const unregister = registerProtectedAcquisitionAdapter(
      "system.response-first",
      async () => "authoritative-response-value",
    );
    try {
      const page = await browser.newPage();
      await page.setContent(`<label>Generated value<input value="masked"></label>`);
      const acquisition = acquisitionIntentSchema.parse({
        target,
        classification: "unknown_secret",
        objective: { kind: "capture_value", expectedValueType: "unknown_secret" },
        permittedMethods: [
          "semantic_field_value",
          "input_value",
          "text_content",
          "protected_network_value",
        ],
        adapter: { id: "system.response-first", configuration: {} },
        validation: { minimumLength: 1, maximumLength: 100 },
      });
      const started = performance.now();
      await expect(acquireValue(page, acquisition, 2_000)).resolves.toMatchObject({
        value: "authoritative-response-value",
        result: { adapter: "protected_network_value" },
      });
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      unregister();
      await browser.close();
    }
  }, 15_000);

  it("never admits a protected preparation input as a newly acquired response output", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <section aria-label="List Orders">
          <label>Client ID<input value="CLIENT_ID_CANARY"></label>
          <label>Client secret<input value="SECRET_CANARY"></label>
          <button>Run</button>
        </section>
      `);
      const acquisition = acquisitionIntentSchema.parse({
        target: {
          concept: "order id",
          requiredCapabilities: ["readable_value"],
          preferredEvidence: {
            roles: ["value"],
            names: ["id"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
          },
          scope: { kind: "section", name: "List Orders" },
          relations: [],
          prohibited: [],
          risk: "protected",
          confidence: { requiredFamilies: [] },
        },
        prohibitedSourceTargets: [
          {
            concept: "List Orders Client ID",
            requiredCapabilities: ["readable_value"],
            preferredEvidence: {
              roles: ["textbox"],
              names: ["Client ID"],
              labels: [],
              descriptions: [],
              placeholders: [],
              inputTypes: [],
            },
            scope: { kind: "section", name: "List Orders" },
            relations: [],
            prohibited: [],
            risk: "protected",
            confidence: { requiredFamilies: [] },
          },
          {
            concept: "List Orders Client secret",
            requiredCapabilities: ["readable_value"],
            preferredEvidence: {
              roles: ["textbox"],
              names: ["Client secret"],
              labels: [],
              descriptions: [],
              placeholders: [],
              inputTypes: [],
            },
            scope: { kind: "section", name: "List Orders" },
            relations: [],
            prohibited: [],
            risk: "protected",
            confidence: { requiredFamilies: [] },
          },
        ],
        classification: "unknown_secret",
        objective: { kind: "capture_value", expectedValueType: "unknown_secret" },
        permittedMethods: [
          "protected_network_value",
          "semantic_field_value",
          "input_value",
          "text_content",
          "copy_control",
        ],
        validation: { minimumLength: 1, maximumLength: 100 },
      });

      const result = await acquireValue(page, acquisition, 250);

      expect(result.value).not.toBe("CLIENT_ID_CANARY");
      expect(result.value).not.toBe("SECRET_CANARY");
      expect(result.result).toBeUndefined();
      expect(
        result.diagnostics
          .filter((item) => item.lastFailureCode === "ACQUISITION_SOURCE_PROHIBITED")
          .map((item) => item.method),
      ).toEqual(expect.arrayContaining(["semantic_field_value"]));
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("derives prohibited protected-input provenance at runtime when a compiled output omits it", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`<label>Client ID<input value="CLIENT_ID_CANARY"></label>`);
      const protectedInputTarget = {
        concept: "client id",
        requiredCapabilities: ["focusable", "accepts_text", "editable", "readable_value"],
        preferredEvidence: {
          roles: ["textbox"],
          names: ["Client ID"],
          labels: [],
          descriptions: [],
          placeholders: [],
          inputTypes: [],
        },
        scope: { kind: "page" },
        relations: [],
        prohibited: [],
        risk: "protected",
        confidence: { requiredFamilies: [] },
      } as const;
      const outputTarget = {
        ...protectedInputTarget,
        concept: "order id",
        requiredCapabilities: ["readable_value"],
        preferredEvidence: {
          ...protectedInputTarget.preferredEvidence,
          roles: ["value"],
          names: ["id"],
        },
      } as const;
      const facts = {
        diagnostics: [],
        protectedAcquisitionEvidence: [],
        credentialReferences: {},
        publicValueReferences: {},
        protectedExtraction: "not_attempted",
        publicExtraction: "not_attempted",
      } as unknown as ProtectedTransactionFacts;

      await expect(
        acquireProtectedOutputs(
          page,
          {
            preparation: {
              actions: [
                { type: "fillKnownSecret", input: "clientId", target: protectedInputTarget },
              ],
              assertions: [],
            },
            mutation: { dispatchSemantics: "read_only" },
            extraction: {
              timeoutMs: 1_000,
              outputs: [
                {
                  reference: "orderId",
                  classification: "protected",
                  acquisition: {
                    target: outputTarget,
                    classification: "unknown_secret",
                    objective: { kind: "capture_value", expectedValueType: "unknown_secret" },
                    permittedMethods: ["semantic_field_value", "input_value", "text_content"],
                    validation: { minimumLength: 1, maximumLength: 100 },
                  },
                  storage: { credentialName: "Order ID", scope: "project" },
                },
              ],
            },
          } as never,
          {} as ProtectedTransactionDependencies,
          facts,
        ),
      ).rejects.toMatchObject({ code: "PROTECTED_VALUE_UNAVAILABLE" });
      expect(
        facts.diagnostics.some((item) => item.lastFailureCode === "ACQUISITION_SOURCE_PROHIBITED"),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("falls back from an incorrect authored container while retaining semantic identity", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<section aria-label="Actual result"><label>Generated value<input value="container-independent-value"></label></section>`,
      );
      const acquisition = acquisitionIntentSchema.parse({
        target: {
          ...target,
          preferredEvidence: { ...target.preferredEvidence, roles: ["value"] },
          scope: { kind: "dialog", name: "Incorrect guessed dialog" },
        },
        classification: "unknown_secret",
        objective: { kind: "capture_value", expectedValueType: "unknown_secret" },
        permittedMethods: ["semantic_field_value", "input_value", "text_content"],
        validation: { minimumLength: 1, maximumLength: 100 },
      });

      await expect(acquireValue(page, acquisition, 2_000)).resolves.toMatchObject({
        value: "container-independent-value",
      });
    } finally {
      await browser.close();
    }
  }, 15_000);

  it.each(["keyboard_copy", "clipboard_event"] as const)(
    "verifies %s without returning copied plaintext",
    async (method) => {
      const browser = await chromium.launch({
        headless: true,
        channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      });
      try {
        const page = await browser.newPage();
        const secret = "must-never-leave-the-protected-page";
        await page.setContent(`<label>Generated value<input value="${secret}"></label>`);
        const acquisition = acquisitionIntentSchema.parse({
          target,
          classification: "unknown_secret",
          objective: {
            kind: "verify_user_copy_experience",
            expectedValueType: "unknown_secret",
          },
          permittedMethods: [method],
          validation: { minimumLength: 1, maximumLength: 100 },
        });

        const result = await acquireValue(page, acquisition, 2_000);

        expect(result.result).toEqual({
          kind: "copy_experience_verified",
          adapter: method,
        });
        expect(result.value).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        await browser.close();
      }
    },
    15_000,
  );

  it("verifies a copy control without reading clipboard plaintext", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<div role="group"><label>Generated value<input value="secret"></label><button>Copy</button></div>`,
      );
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            readText: () => {
              throw new Error("clipboard plaintext was read");
            },
            writeText: async () => undefined,
          },
        });
        document.querySelector("button")?.addEventListener("click", () => {
          document.dispatchEvent(new ClipboardEvent("copy"));
        });
      });
      const acquisition = acquisitionIntentSchema.parse({
        target,
        classification: "unknown_secret",
        objective: {
          kind: "verify_user_copy_experience",
          expectedValueType: "unknown_secret",
        },
        permittedMethods: ["copy_control"],
        validation: { minimumLength: 1, maximumLength: 100 },
      });

      await expect(acquireValue(page, acquisition, 2_000)).resolves.toMatchObject({
        result: { kind: "copy_experience_verified", adapter: "copy_control" },
        value: undefined,
      });
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("rejects a copy control that produces no observable copy event", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<div role="group"><label>Generated value<input value="secret"></label><button>Copy</button></div>`,
      );
      const acquisition = acquisitionIntentSchema.parse({
        target,
        classification: "unknown_secret",
        objective: {
          kind: "verify_user_copy_experience",
          expectedValueType: "unknown_secret",
        },
        permittedMethods: ["copy_control"],
        validation: { minimumLength: 1, maximumLength: 100 },
      });

      const result = await acquireValue(page, acquisition, 120);

      expect(result.result).toBeUndefined();
      expect(result.diagnostics.at(-1)?.lastFailureCode).toBe("ACQUISITION_METHOD_TIMEOUT");
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("never persists plaintext for a verified copy experience", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<div role="group"><label>Generated value<input value="must-not-persist"></label><button>Copy</button></div>`,
      );
      await page.evaluate(() => {
        document.querySelector("button")?.addEventListener("click", () => {
          document.dispatchEvent(new ClipboardEvent("copy"));
        });
      });
      const persistSecret = vi.fn();
      const persistPublicValue = vi.fn();
      const operation = {
        operationId: "verify-copy",
        mutation: { dispatchSemantics: "mutation" },
        extraction: {
          timeoutMs: 2_000,
          outputs: [
            {
              classification: "protected",
              reference: "clientSecret",
              acquisition: acquisitionIntentSchema.parse({
                target,
                classification: "unknown_secret",
                objective: {
                  kind: "verify_user_copy_experience",
                  expectedValueType: "unknown_secret",
                },
                permittedMethods: ["copy_control"],
                validation: { minimumLength: 1, maximumLength: 100 },
              }),
              storage: { credentialName: "Client secret", scope: "project" },
            },
          ],
        },
      } as never;
      const facts = {
        diagnostics: [],
        protectedAcquisitionEvidence: [],
        credentialReferences: {},
        publicValueReferences: {},
      } as unknown as ProtectedTransactionFacts;

      await extractAndPersistProtectedOutputs(
        page,
        operation,
        {
          redactor: new SecretRedactor(),
          persistSecret,
          persistPublicValue,
        } as unknown as ProtectedTransactionDependencies,
        facts,
        {
          id: "protected-operation",
          state: "persisting",
          version: 1,
          fencingToken: 1,
          mutationOutcome: "unknown",
        },
      );

      expect(persistSecret).not.toHaveBeenCalled();
      expect(persistPublicValue).not.toHaveBeenCalled();
      expect(facts.credentialReferences).toEqual({});
      expect(facts.protectedAcquisitionEvidence).toEqual([
        {
          reference: "clientSecret",
          adapter: "copy_control",
          objective: "verify_user_copy_experience",
          outcome: "copy_experience_verified",
          capsule: "destroyed",
          evidenceClosure: "sealed",
        },
      ]);
      expect(JSON.stringify(facts)).not.toContain("must-not-persist");
    } finally {
      await browser.close();
    }
  }, 15_000);
});
