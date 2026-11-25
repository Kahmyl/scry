// Standalone real-browser regression suite; no application accounts or network.
// Run with: node --test packages/praxis/test/native-input-guards.browser.mjs
// Uses the pinned full Chromium channel, including in the private Linux image.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-mcp-runtime";
import { observeControlState, bindKnownControls } from "../src/mcp-native/known-controls.mjs";
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, channel: "chromium" });
});
after(async () => {
  await browser?.close();
});

async function fixture(mode, guarded, repeat = false) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let observation, binding;
  try {
    await page.setContent(
      '<div id="host"></div><form action="https://fixture.invalid/original"><input id="price" name="price" aria-label="Price" value="-1" type="' +
        (mode === "number" ? "number" : "text") +
        '"><button id="next" type="button">Continue</button><input id="other"></form>',
    );
    await page.evaluate((mode) => {
      let input = document.getElementById("price");
      const button = document.getElementById("next");
      if (["shadow-name", "shadow-description"].includes(mode)) {
        const shadow = document.getElementById("host").attachShadow({ mode: "open" });
        shadow.append(input);
        input.setAttribute("aria-describedby", "help");
        const help = document.createElement("p");
        help.id = "help";
        help.textContent = "Price guidance";
        shadow.append(help);
      }
      window.saved = { count: 0, value: null, clicks: 0 };
      if (mode === "many-shadow-roots")
        for (let i = 0; i < 160; i++) {
          const host = document.createElement("div");
          document.body.append(host);
          host.attachShadow({ mode: "open" }).innerHTML = "<span>Unchanged component</span>";
        }
      input.addEventListener("change", () => {
        window.saved.count++;
        window.saved.value = input.value;
      });
      button.addEventListener("click", () => window.saved.clicks++);
      input.addEventListener("input", () =>
        queueMicrotask(() => {
          if (["name", "text", "number", "shadow-name"].includes(mode)) {
            input.name = "";
            input.name = "price";
          }
          if (mode === "shadow-description")
            input.getRootNode().getElementById("help").textContent = "Changed guidance";
          if (mode === "new-shadow-control")
            document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
              "<button>New decision</button>";
          if (mode === "transient-shadow-control") {
            const host = document.getElementById("host");
            host.attachShadow({ mode: "open" }).innerHTML = "<button>Transient decision</button>";
            host.remove();
          }
          if (["text", "number"].includes(mode)) input.type = mode;
          if (mode === "changed-name") input.name = "different-destination";
          if (mode === "restored-type") {
            input.type = "password";
            input.type = "text";
          }
          if (mode === "button-text") {
            button.textContent = "Unexpected";
            button.textContent = "Continue";
          }
          if (mode === "reinsert-input") {
            input.remove();
            button.before(input);
          }
          if (mode === "new-control") button.after(document.createElement("button"));
          if (mode === "new-frame") button.after(document.createElement("iframe"));
          if (mode === "overflow") {
            for (let i = 0; i < 300; i++) {
              input.name = "";
              input.name = "price";
            }
          }
          if (mode === "form-target") {
            input.form.action = "https://fixture.invalid/changed";
            input.form.action = "https://fixture.invalid/original";
          }
          if (mode === "other-control") {
            const other = document.getElementById("other");
            other.name = "";
            other.removeAttribute("name");
          }
          if (mode === "absent-vs-empty") input.removeAttribute("name");
        }),
      );
    }, mode);
    if (guarded) {
      observation = await observeControlState(page);
      const steps = [
        { args: { target: "price" } },
        ...(repeat ? [{ args: { target: "price" } }] : []),
        { args: { target: "next" } },
      ];
      binding = await bindKnownControls(page, steps, async (p, target) => ({
        handle: await p.locator("#" + target).elementHandle(),
      }));
      await binding.before(0);
    }
    await page.locator("#price").fill("365");
    if (guarded && !(await binding.advanceAfterInput(0, observation))) return { advanced: false };
    if (repeat) {
      if (guarded) await binding.before(1);
      await page.locator("#price").fill("456");
      if (guarded && !(await binding.advanceAfterInput(1, observation))) return { advanced: false };
    }
    if (guarded) {
      assert.equal(await observation.valid(), true);
      await binding.before(repeat ? 2 : 1);
    }
    await page.locator("#next").click();
    return { advanced: true, saved: await page.evaluate(() => window.saved) };
  } finally {
    await binding?.dispose();
    await observation?.dispose();
    await context.close();
  }
}

for (const mode of ["plain", "name", "text", "number", "shadow-name", "many-shadow-roots"])
  for (const repeat of [false, true]) {
    test(`preserves native change/save semantics for ${mode}, repeated=${repeat}`, async () => {
      const baseline = await fixture(mode, false, repeat),
        guarded = await fixture(mode, true, repeat);
      assert.equal(guarded.advanced, true);
      assert.deepEqual(guarded.saved, baseline.saved);
      assert.equal(guarded.saved.clicks, 1);
      assert.equal(guarded.saved.value, repeat ? "456" : "365");
      assert.ok(guarded.saved.count > 0);
    });
  }
for (const mode of [
  "changed-name",
  "restored-type",
  "button-text",
  "reinsert-input",
  "new-control",
  "new-frame",
  "overflow",
  "form-target",
  "other-control",
  "absent-vs-empty",
  "shadow-description",
  "new-shadow-control",
  "transient-shadow-control",
]) {
  test(`refuses successor after ${mode}`, async () =>
    assert.equal((await fixture(mode, true)).advanced, false));
}
