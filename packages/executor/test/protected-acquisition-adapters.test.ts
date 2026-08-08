import { acquisitionIntentSchema } from "@scry/contracts";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireValue,
  protectedAcquisitionAdapterRegistry,
  registerProtectedAcquisitionAdapter,
} from "../src/protected-extractor.js";

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
    vi.stubEnv("SCRY_PROTECTED_ACQUISITION_ADAPTERS_ENABLED", "true");
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
    vi.stubEnv("SCRY_PROTECTED_ACQUISITION_ADAPTERS_ENABLED", "true");
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
});
