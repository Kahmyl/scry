// Reproduce the exact inactive order-line note condition from the blind trial.
// Work on a UI-duplicated fictional quotation. Explicitly discard before reload:
// navigation itself is not a general promise to abandon app edits.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const input = JSON.parse(await readFile("/inputs.json", "utf8")).odoo;
const root = "/results/odoo-row-cause-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const helper = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<!doctype html><title>Private clipboard helper</title>");
});
await new Promise((resolve) => helper.listen(0, "127.0.0.1", resolve));
const helperOrigin = "http://127.0.0.1:" + helper.address().port;
let clipboard;
const rows = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto("http://odoo:8069/web/login");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(input.username);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(input.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.goto("http://odoo:8069/odoo/sales/1", { waitUntil: "domcontentloaded" });
  const note = page.getByRole("textbox", { name: "Enter a description", exact: true });
  await note.waitFor();
  if (process.env.SCRY_ODOO_RESTORE === "true") {
    await page.getByRole("cell", { name: "9.00", exact: true }).click();
    await page.locator('[name="product_uom_qty"] input').fill("3");
    await page.getByRole("button", { name: "Save manually", exact: true }).click();
    await page
      .getByRole("button", { name: "Save manually", exact: true })
      .waitFor({ state: "hidden" });
    await page.reload();
    await note.waitFor();
    await page.getByRole("cell", { name: "3.00", exact: true }).waitFor();
    rows.push({
      cleanup: "restore-fictional-qualification-quantity",
      baselineQuantity: 3,
      note: await note.inputValue(),
      table: await page.locator("table.o_list_table").innerText(),
    });
    console.log(JSON.stringify({ restoredOriginalQuantity: true }));
  }
  await page
    .getByRole("cell", { name: "3.00", exact: true })
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(async (error) => {
      const table = await page.locator("table.o_list_table").innerText();
      await writeFile(root + "/baseline-table.json", JSON.stringify({ table }), { mode: 0o600 });
      console.log(JSON.stringify({ baselineTable: table }));
      throw error;
    });
  const baseline = await note.inputValue();
  if (!baseline.startsWith("Blind 1031 fictional acceptance note:"))
    throw new Error("Unexpected baseline; do not edit");
  if (process.env.SCRY_ODOO_RESTORE !== "true") {
    if (process.env.SCRY_ODOO_REUSE === "true") await page.goto("http://odoo:8069/odoo/sales/2");
    else {
      await page.getByRole("button", { name: "Actions menu", exact: true }).click();
      await page.getByText("Duplicate", { exact: true }).click();
      await page.waitForURL((url) => !url.pathname.endsWith("/sales/1"));
    }
    await note.waitFor();
    console.log(JSON.stringify({ isolatedDuplicate: page.url() }));
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: helperOrigin });
    clipboard = await page.context().newPage();
    await clipboard.goto(helperOrigin);
    await page.bringToFront();
  }
  const inspect = () =>
    note.evaluate((e) => ({
      value: e.value,
      tag: e.tagName,
      readOnly: e.readOnly,
      focused: e === document.activeElement,
      connected: e.isConnected,
      active: {
        tag: document.activeElement?.tagName,
        placeholder: document.activeElement?.getAttribute("placeholder"),
      },
      html: e.outerHTML,
      events: globalThis.__noteEvents ?? [],
    }));
  for (const strategy of process.env.SCRY_ODOO_RESTORE === "true"
    ? []
    : process.env.SCRY_ODOO_READY === "true"
      ? ["ready-fill", "ready-paste"]
      : ["fill-inactive", "click-fill", "click-keys", "click-native-paste"]) {
    await page.reload();
    await note.waitFor();
    await page
      .getByRole("cell", { name: "3.00", exact: true })
      .waitFor({ state: "visible", timeout: 5000 });
    const before = await note.inputValue();
    if (before !== baseline) throw new Error("Quotation baseline changed unexpectedly");
    await page.getByRole("cell", { name: "3.00", exact: true }).click();
    // Use the labelled row, not positional inputs elsewhere in the form.
    const qty = page.locator('[name="product_uom_qty"] input');
    await qty.waitFor({ state: "visible", timeout: 5000 });
    await qty.fill("9");
    const initial = await inspect();
    await note.evaluate((e) => {
      globalThis.__noteEvents = [];
      for (const type of ["focus", "blur", "beforeinput", "input", "change"])
        e.addEventListener(type, (event) => {
          globalThis.__noteEvents.push({
            type,
            trusted: event.isTrusted,
            inputType: event.inputType,
            value: e.value,
            focused: e === document.activeElement,
          });
        });
    });
    const expected = "UNSAVED Cause 1031 " + strategy;
    let error;
    try {
      if (strategy === "click-native-paste" || strategy === "ready-paste") {
        await clipboard.bringToFront();
        await clipboard.evaluate((value) => navigator.clipboard.writeText(value), expected);
        await page.bringToFront();
      }
      if (strategy !== "fill-inactive") await note.click();
      if (strategy.startsWith("ready-")) {
        await page
          .locator('tr.o_selected_row textarea[placeholder="Enter a description"]')
          .waitFor({ state: "visible", timeout: 5000 });
        await page.waitForFunction(
          () => {
            const e = document.querySelector(
              'tr.o_selected_row textarea[placeholder="Enter a description"]',
            );
            return e && document.activeElement === e;
          },
          undefined,
          { timeout: 5000 },
        );
      }
      if (strategy === "click-keys") {
        await note.press("ControlOrMeta+A");
        await note.pressSequentially(expected);
      } else if (strategy === "click-native-paste" || strategy === "ready-paste") {
        await note.press("ControlOrMeta+A");
        await note.press("ControlOrMeta+V");
      } else await note.fill(expected);
    } catch (e) {
      error = e.message;
    }
    await page.waitForTimeout(500);
    const after = await inspect();
    await page.screenshot({ path: root + "/" + strategy + ".png" });
    // Odoo can save on navigation/unload. Explicitly discard form edits first;
    // never use the whole-quotation business Cancel action as a discard.
    await page.getByRole("button", { name: "Discard all changes", exact: true }).click();
    await page.reload();
    await note.waitFor();
    const restored = await note.inputValue();
    await page
      .getByRole("cell", { name: "3.00", exact: true })
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(async () => {
        await writeFile(
          root + "/quantity-readback.json",
          JSON.stringify({ table: await page.locator("table.o_list_table").innerText() }),
          { mode: 0o600 },
        );
      });
    const restoredQty = await page.getByRole("cell", { name: "3.00", exact: true }).count();
    const result = {
      strategy,
      before,
      expected,
      initial,
      after,
      error,
      restored,
      restoredQty,
      changed: after.value === expected,
      baselineRestored: restored === baseline && restoredQty === 1,
    };
    rows.push(result);
    console.log(
      JSON.stringify({
        strategy,
        changed: result.changed,
        baselineRestored: result.baselineRestored,
        error,
      }),
    );
    if (!result.baselineRestored) throw new Error("Reload failed to restore baseline");
  }
} finally {
  if (clipboard && !clipboard.isClosed()) {
    await clipboard.bringToFront().catch(() => {});
    await clipboard.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
  }
  await browser.close();
  await new Promise((resolve) => helper.close(resolve));
  await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, cases: rows.length }));
}
