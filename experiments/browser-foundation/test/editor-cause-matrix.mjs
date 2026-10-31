// Controlled real-app characterization. Only uniquely seeded fictional research
// documents are edited; no customer/baseline document is touched.
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const pinned = require("playwright-mcp-runtime");
const stable = require("playwright");
const { originProxy } = await import("/workspace/packages/praxis/src/mcp-native/proxy.mjs");
const input = JSON.parse(await readFile("/inputs.json", "utf8")).nextcloud;
const root = "/results/editor-matrix-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const selector = "[role=dialog] [contenteditable=true]";
const source = await readFile("/workspace/packages/veil/src/native-mask-runtime.js", "utf8");
const strategies = ["fill", "clear-insert", "click-clear-insert", "click-clear-keys"];
const rows = [];
const proxy = await originProxy(["http://nextcloud"]);
// Remote collaboration-caret labels are ephemeral widgets, not document text.
// Read a detached DOM copy; never remove widgets or mutate the tested app.
const getText = (editor) =>
  editor.evaluate((e) => {
    const copy = e.cloneNode(true);
    for (const widget of copy.querySelectorAll("[contenteditable=false]")) widget.remove();
    return copy.textContent;
  });
async function replaceKeys(editor, text) {
  await editor.press("ControlOrMeta+A");
  if (text) await editor.pressSequentially(text);
  else await editor.press("Backspace");
}
try {
  for (const driver of ["pinned-alpha", "stable-client-same-browser"]) {
    const runtime = driver === "pinned-alpha" ? pinned : stable;
    const browser = await runtime.chromium.launch({
      executablePath: pinned.chromium.executablePath(),
      headless: true,
      args: ["--no-sandbox"],
      proxy: { server: proxy.url, bypass: "<-loopback>" },
    });
    try {
      for (const masks of [false, true]) {
        if (
          driver === "pinned-alpha" &&
          !masks &&
          process.env.SCRY_MATRIX_SKIP_PINNED_UNMASKED === "true"
        )
          continue;
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();
        // Fixture provisioning only: a unique fictional document per context avoids
        // contaminating mask/driver comparisons with abandoned peer sessions.
        const filename = "Cause 1031 Matrix " + driver + " " + masks + " " + Date.now() + ".txt";
        const seeded = await fetch(
          "http://nextcloud/remote.php/dav/files/" +
            encodeURIComponent(input.username) +
            "/" +
            encodeURIComponent(filename),
          {
            method: "PUT",
            headers: {
              authorization:
                "Basic " + Buffer.from(input.username + ":" + input.password).toString("base64"),
              "content-type": "text/plain",
            },
            body: "Initial fictional matrix document\n",
          },
        );
        if (seeded.status !== 201)
          throw new Error("Unique fixture provisioning failed: " + seeded.status);
        if (masks) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
            source: source + "\ninstallNativeMasks([]);",
            worldName: "scry-native-protection",
            runImmediately: true,
          });
        }
        await page.goto("http://nextcloud/login", { waitUntil: "domcontentloaded" });
        await page
          .getByRole("textbox", { name: "Account name or email", exact: true })
          .fill(input.username);
        await page.getByRole("textbox", { name: "Password", exact: true }).fill(input.password);
        await page.getByRole("button", { name: "Log in", exact: true }).click({ timeout: 20000 });
        await page.goto("http://nextcloud/apps/files/files", { waitUntil: "domcontentloaded" });
        await page
          .getByRole("button", { name: "View: " + filename, exact: true })
          .click({ timeout: 20000 });
        await page.locator(selector).waitFor({ state: "visible", timeout: 20000 });
        await page.locator(selector + " code").waitFor({ state: "attached", timeout: 20000 });
        await page
          .getByRole("button", { name: "Save document", exact: true })
          .waitFor({ state: "visible", timeout: 20000 });
        // Stabilize the diagnostic fixture once so hydration is not confounded with
        // the replacement primitive. This is not a proposed production readiness rule.
        await page.waitForTimeout(1500);
        for (let repeat = 0; repeat < 2; repeat++)
          for (const strategy of strategies) {
            let editor = page.locator(selector);
            const baseline = "Existing model " + driver + " " + masks + " " + repeat;
            await editor.evaluate((e) => {
              globalThis.__baselineEvents = [];
              e.addEventListener("input", (ev) =>
                globalThis.__baselineEvents.push({
                  type: ev.type,
                  data: ev.data,
                  html: e.innerHTML,
                }),
              );
            });
            await editor.click();
            await editor.press("ControlOrMeta+A");
            await editor.press("Backspace");
            await editor.pressSequentially(baseline);
            await page.waitForTimeout(150);
            const baselineActual = await getText(editor);
            if (baselineActual !== baseline && baselineActual !== baseline + "\n") {
              await writeFile(
                root + "/invalid-baseline.json",
                JSON.stringify(
                  {
                    driver,
                    masks,
                    repeat,
                    strategy,
                    baseline,
                    actual: baselineActual,
                    diagnostic: await editor.evaluate((e) => ({
                      html: e.innerHTML,
                      node: e.pmViewDesc?.node?.toJSON(),
                      events: globalThis.__baselineEvents,
                    })),
                    snapshot: await page.locator("[role=dialog]").ariaSnapshot(),
                  },
                  null,
                  2,
                ),
              );
              throw new Error("Invalid baseline; do not count experiment");
            }
            const expected = `New ${strategy} ${repeat}\n\nCafé 日本語 😀`;
            const events = [];
            const sink = "matrixEvent" + rows.length;
            await page.exposeBinding(sink, (_s, e) => events.push(e));
            await editor.evaluate((element, sink) => {
              const handler = (e) =>
                window[sink]({
                  type: e.type,
                  inputType: e.inputType,
                  data: e.data,
                  key: e.key,
                  html: element.innerHTML,
                  model: element.pmViewDesc?.node?.toJSON(),
                  at: performance.now(),
                });
              for (const name of ["beforeinput", "input", "keydown"])
                element.addEventListener(name, handler);
              element.__matrixDispose = () => {
                for (const name of ["beforeinput", "input", "keydown"])
                  element.removeEventListener(name, handler);
              };
            }, sink);
            let error;
            const start = Date.now();
            try {
              if (strategy === "fill") await editor.fill(expected);
              if (strategy === "select-insert") {
                await editor.press("ControlOrMeta+A");
                await page.keyboard.insertText(expected);
              }
              if (strategy === "keys") await replaceKeys(editor, expected);
              if (strategy === "clear-insert") {
                await editor.press("ControlOrMeta+A");
                await editor.press("Backspace");
                await page.keyboard.insertText(expected);
              }
              if (strategy === "clear-fill") {
                await editor.press("ControlOrMeta+A");
                await editor.press("Backspace");
                await editor.fill(expected);
              }
              if (strategy === "clear-keys") {
                await editor.press("ControlOrMeta+A");
                await editor.press("Backspace");
                await editor.pressSequentially(expected);
              }
              if (strategy === "clear-arrow-insert") {
                await editor.press("ControlOrMeta+A");
                await editor.press("Backspace");
                await editor.press("ArrowRight");
                await page.keyboard.insertText(expected);
              }
              if (strategy === "click-clear-insert") {
                await editor.click();
                await editor.press("ControlOrMeta+A");
                await editor.press("Backspace");
                await page.keyboard.insertText(expected);
              }
              if (strategy === "click-clear-keys") {
                await editor.click();
                await editor.press("ControlOrMeta+A");
                await editor.press("Backspace");
                await editor.pressSequentially(expected);
              }
            } catch (e) {
              error = e.message;
            }
            const inputMs = Date.now() - start;
            await page.waitForTimeout(500);
            const actual = await getText(editor);
            const diagnostic = await editor.evaluate((e) => ({
              html: e.innerHTML,
              model: e.pmViewDesc?.node?.toJSON(),
            }));
            await editor.evaluate((e) => e.__matrixDispose?.());
            // Deliberately save/read back failures too, to distinguish display glitches
            // from persisted business corruption. This delay is an experimental control,
            // not a proposed production wait or a claim of universal save readiness.
            await page
              .getByRole("button", { name: "Save document", exact: true })
              .click({ timeout: 20000 });
            await page.waitForTimeout(1000);
            await page
              .locator("[role=dialog]")
              .getByRole("button", { name: "Close", exact: true })
              .click({ timeout: 20000 });
            await page
              .getByRole("button", { name: "View: " + filename, exact: true })
              .click({ timeout: 20000 });
            await page.locator(selector).waitFor({ state: "visible", timeout: 20000 });
            await page.locator(selector + " code").waitFor({ state: "attached", timeout: 20000 });
            await page
              .getByRole("button", { name: "Save document", exact: true })
              .waitFor({ state: "visible", timeout: 20000 });
            await page.waitForTimeout(1500);
            const persisted = await getText(page.locator(selector));
            const row = {
              driver,
              masks,
              repeat,
              strategy,
              filename,
              baselineActual,
              expected,
              actual,
              persisted,
              inputMs,
              error,
              diagnostic,
              events,
              passed: !error && actual === expected && persisted === expected,
            };
            rows.push(row);
            await appendFile(root + "/matrix.jsonl", JSON.stringify(row) + "\n", { mode: 0o600 });
            console.log(
              JSON.stringify({
                driver,
                masks,
                repeat,
                strategy,
                inputMs,
                actualLength: actual.length,
                persistedLength: persisted.length,
                passed: row.passed,
                error,
              }),
            );
            if (repeat === 0)
              await page.screenshot({
                path: root + "/" + driver + "-" + masks + "-" + strategy + ".png",
              });
          }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await proxy.close();
  await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      root,
      cases: rows.length,
      strategies: strategies.map((strategy) => ({
        strategy,
        passed: rows.filter((r) => r.strategy === strategy && r.passed).length,
        total: rows.filter((r) => r.strategy === strategy).length,
      })),
    }),
  );
}
