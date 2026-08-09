import { acquisitionIntentSchema } from "@scry/contracts";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretRedactor } from "@scry/policy";

import {
  acquireValue,
  protectedAcquisitionAdapterRegistry,
  registerProtectedAcquisitionAdapter,
} from "../src/protected-extractor.js";
import { extractAndPersistProtectedOutputs } from "../src/protected-transaction-acquisition.js";
import type {
  ProtectedTransactionDependencies,
  ProtectedTransactionFacts,
} from "../src/protected-transaction-coordinator.js";

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
      expect(result.diagnostics.at(-1)?.lastFailureCode).toBe("COPY_EXPERIENCE_NOT_OBSERVED");
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
