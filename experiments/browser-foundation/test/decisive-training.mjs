// App-specific setup and independent test oracles are outside the shared engine.
// Every measured business edit uses the same frozen operation and strategy.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { privateBrowser, sharedRuntime } from "./decisive-runtime.mjs";
const inputs = JSON.parse(await readFile("/inputs.json", "utf8"));
const root = "/results/decisive-training-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const runtimeHash = createHash("sha256")
  .update(await readFile(new URL("./decisive-runtime.mjs", import.meta.url)))
  .digest("hex");
await writeFile(
  root + "/runtime-source.mjs",
  await readFile(new URL("./decisive-runtime.mjs", import.meta.url)),
  { mode: 0o600 },
);
const env = await privateBrowser();
const rows = [];
const text = (loc) =>
  loc.evaluate((e) => {
    const c = e.cloneNode(true);
    for (const n of c.querySelectorAll("[contenteditable=false]")) n.remove();
    return c.textContent;
  });
async function login(page, app) {
  const config = {
    nextcloud: ["http://nextcloud/login", "Account name or email", "Password", "Log in"],
    grafana: ["http://grafana:3000/login", "Email or username", "Password", "Log in"],
    odoo: ["http://odoo:8069/web/login", "Email", "Password", "Log in"],
  }[app];
  await page.goto(config[0]);
  await page.getByRole("textbox", { name: config[1], exact: true }).fill(inputs[app].username);
  await page.getByRole("textbox", { name: config[2], exact: true }).fill(inputs[app].password);
  await page.getByRole("button", { name: config[3], exact: true }).click();
  if (app === "grafana") await page.waitForURL((u) => u.pathname !== "/login");
}
try {
  for (const app of process.env.SCRY_DECISIVE_APPS?.split(",") ?? [
    "nextcloud",
    "grafana",
    "odoo",
  ]) {
    const context = await env.browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: root + "/video" },
    });
    const page = await context.newPage();
    let runtime;
    const row = { app, runtimeHash, edits: [] };
    try {
      const source = await readFile("/workspace/packages/veil/src/native-mask-runtime.js", "utf8");
      const session = await context.newCDPSession(page);
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: source + "\ninstallNativeMasks([]);",
        worldName: "scry-native-protection",
        runImmediately: true,
      });
      await login(page, app);
      let target, name, peer;
      if (app === "nextcloud") {
        name = "Decisive 1031 " + Date.now() + ".txt";
        const i = inputs.nextcloud;
        const r = await fetch(
          "http://nextcloud/remote.php/dav/files/" + i.username + "/" + encodeURIComponent(name),
          {
            method: "PUT",
            headers: {
              authorization:
                "Basic " + Buffer.from(i.username + ":" + i.password).toString("base64"),
            },
            body: "Existing fictional document\n",
          },
        );
        if (r.status !== 201) throw Error("Unique seed failed");
        await page.goto("http://nextcloud/apps/files/files");
        await page.getByText(name, { exact: true }).filter({ visible: true }).first().click();
        target = "[contenteditable=true]:has(pre > code)";
        await page.locator(target + " code").waitFor({ state: "attached" });
        row.stage = "open-peer";
        peer = await context.newPage();
        await peer.goto("http://nextcloud/apps/files/files");
        await peer.getByText(name, { exact: true }).filter({ visible: true }).first().click();
        await peer.locator(target).waitFor();
        await peer.locator(target).click();
      } else if (app === "grafana") {
        await page.goto(
          "http://grafana:3000/d/ex2bw7t/cause-1031-editor-1018?from=now-6h&to=now&timezone=browser&editPanel=1",
        );
        target = "textarea.inputarea";
        await page.locator(target).waitFor({ state: "attached" });
      } else {
        await page.goto("http://odoo:8069/odoo/sales/1");
        await page.getByRole("cell", { name: "3.00", exact: true }).waitFor();
        await page.getByRole("button", { name: "Actions menu", exact: true }).click();
        await page.getByText("Duplicate", { exact: true }).click();
        await page.waitForURL((u) => !u.pathname.endsWith("/sales/1"));
        row.researchUrl = page.url();
        await page.getByRole("cell", { name: "3.00", exact: true }).click();
        await page.locator('[name="product_uom_qty"] input').fill("9");
        target = 'role=textbox[name="Enter a description"s]';
      }
      row.stage = "edits";
      runtime = await sharedRuntime(context, env.clipboard);
      let expected;
      for (let n = 0; n < 2; n++) {
        expected =
          app === "odoo"
            ? `Decisive ${root.split("-").at(-1)} ${n}: Café 日本語 😀`
            : `Decisive ${root.split("-").at(-1)} ${n}\n\nCafé 日本語 😀`;
        const r = await runtime.replace({
          page,
          target,
          text: expected,
          strategy: process.env.SCRY_DECISIVE_STRATEGY ?? "native-control-scope",
        });
        row.edits.push(r);
        if (r.status !== "accepted") {
          row.targets = await page.locator(target).evaluateAll((es) =>
            es.map((e) => ({
              html: e.outerHTML.slice(0, 1000),
              ancestors: [
                e.parentElement,
                e.parentElement?.parentElement,
                e.parentElement?.parentElement,
              ].map((p) => (p ? { tag: p.tagName, id: p.id, class: p.className } : null)),
            })),
          );
          throw Error("Shared operation did not verify edit: " + r.status + " " + r.reason);
        }
        const actual =
          app === "nextcloud"
            ? await text(page.locator(target))
            : await page.locator(target).inputValue();
        row.edits.at(-1).independentActual = actual;
        if (actual !== expected) throw Error("Independent edit mismatch");
      }
      if (app === "nextcloud") {
        await peer.waitForFunction(
          ({ target, expected }) => {
            const e = document.querySelector(target);
            if (!e) return false;
            const c = e.cloneNode(true);
            for (const n of c.querySelectorAll("[contenteditable=false]")) n.remove();
            return c.textContent === expected;
          },
          { target, expected },
          { timeout: 12000 },
        );
        row.peer = await text(peer.locator(target));
        await page.getByRole("button", { name: "Save document", exact: true }).click();
        await page.waitForTimeout(1000);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page.getByText(name, { exact: true }).filter({ visible: true }).first().click();
        await page.locator(target + " code").waitFor({ state: "attached" });
        await page.waitForTimeout(1000);
        row.persisted = await text(page.locator(target));
        row.name = name;
      } else if (app === "grafana") {
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const modal = page.locator("[role=dialog][aria-modal=true]");
        await modal.getByRole("button", { name: "Save", exact: true }).click();
        await modal.waitFor({ state: "hidden" });
        const fresh = await env.browser.newContext({ viewport: { width: 1280, height: 720 } });
        try {
          const p = await fresh.newPage();
          await login(p, app);
          await p.goto(page.url());
          await p.locator(target).waitFor({ state: "attached" });
          row.persisted = await p.locator(target).inputValue();
        } finally {
          await fresh.close();
        }
      } else {
        await page.getByRole("button", { name: "Save manually", exact: true }).click();
        await page
          .getByRole("button", { name: "Save manually", exact: true })
          .waitFor({ state: "hidden" });
        await page.reload();
        await page.getByRole("cell", { name: "9.00", exact: true }).waitFor();
        row.persisted = await page.locator(target).inputValue();
      }
      row.expected = expected;
      row.passed = row.persisted === expected;
      await page.screenshot({ path: root + "/" + app + ".png" });
    } catch (e) {
      row.error = e.message;
      row.passed = false;
      await page.screenshot({ path: root + "/" + app + "-failure.png" }).catch(() => {});
    } finally {
      rows.push(row);
      console.log(JSON.stringify(row));
      await runtime?.close();
      await context.close();
      await writeFile(
        root + "/results.json",
        JSON.stringify({ root, runtimeHash, rows }, null, 2),
        { mode: 0o600 },
      );
    }
  }
} finally {
  await env.close();
  console.log(JSON.stringify({ root, cases: rows.length }));
}
