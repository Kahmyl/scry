import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { extractProtectedValue } from "../src/protected-extractor.js";

describe("protected semantic extraction", () => {
  it("resolves the nearest following definition value across direct and wrapped labels", async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
    try {
      const page = await browser.newPage();
      const acquisition = {target:{concept:"Client secret value",requiredCapabilities:["readable_value" as const],preferredEvidence:{roles:["value" as const],names:["Client secret"],labels:[],descriptions:[],placeholders:[],inputTypes:[]},scope:{kind:"page" as const},relations:[{kind:"following" as const,name:"Client secret"}],prohibited:["hidden" as const],risk:"protected" as const,confidence:{requiredFamilies:[],minimum:.3,minimumMargin:0,minimumFamilyCount:1}},classification:"unknown_secret" as const,permittedMethods:["semantic_field_value" as const],validation:{minimumLength:1,maximumLength:100}};

      await page.setContent("<dl><div><dt>Client secret</dt><dd>direct-secret</dd></div></dl>");
      expect((await extractProtectedValue(page, acquisition, 500)).value).toBe("direct-secret");

      await page.setContent("<dl><div><div><dt>Client secret</dt><button>Copy</button></div><dd>wrapped-secret</dd></div></dl>");
      expect((await extractProtectedValue(page, acquisition, 500)).value).toBe("wrapped-secret");
    } finally {
      await browser.close();
    }
  });
});
