// Read-only asset comparison. Never broaden any stored Scry Environment.
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const { originProxy } = await import("/workspace/packages/praxis/src/mcp-native/proxy.mjs");
const inputs = JSON.parse(await readFile("/inputs.json", "utf8"));
const root = "/results/asset-cause-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const rows = [];
const safe = (url) => {
  try {
    const u = new URL(url);
    return { origin: u.origin, path: u.pathname };
  } catch {
    return { invalid: true };
  }
};
for (const app of process.env.SCRY_ASSET_APP
  ? [process.env.SCRY_ASSET_APP]
  : ["discourse", "gitlab"])
  for (const scope of ["candidate-proxy", "direct-control"]) {
    const blocked = [];
    const origin = "http://" + app;
    const proxy =
      scope === "candidate-proxy"
        ? await originProxy([origin], (event) => blocked.push(event))
        : undefined;
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
      ...(proxy ? { proxy: { server: proxy.url, bypass: "<-loopback>" } } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const failed = [],
        responses = [];
      page.on("requestfailed", (r) =>
        failed.push({
          ...safe(r.url()),
          resource: r.resourceType(),
          failure: r.failure()?.errorText,
        }),
      );
      page.on("response", (r) => {
        if (r.request().resourceType() === "image" && r.status() >= 400)
          responses.push({ ...safe(r.url()), status: r.status() });
      });
      const started = Date.now();
      if (app === "gitlab") {
        await page.goto(origin + "/users/sign_in", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page
          .getByRole("textbox", { name: "Username or primary email", exact: true })
          .fill(inputs.gitlab.username);
        await page
          .getByRole("textbox", { name: "Password", exact: true })
          .fill(inputs.gitlab.password);
        await page.getByRole("button", { name: "Sign in", exact: true }).click({ timeout: 25000 });
        await page.goto(origin + "/scry-collaboration/customer-platform/-/work_items/34", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      } else {
        await page.goto(origin + "/login", { waitUntil: "domcontentloaded", timeout: 30000 });
        console.log(
          JSON.stringify({
            app,
            loginFields: await page.locator("input").evaluateAll((xs) =>
              xs.map((e) => ({
                type: e.type,
                id: e.id,
                name: e.name,
                label: e.getAttribute("aria-label"),
                placeholder: e.placeholder,
              })),
            ),
          }),
        );
        await page
          .getByRole("textbox", { name: "Email / Username", exact: true })
          .fill(inputs.discourse.username);
        await page
          .getByRole("textbox", { name: "Password", exact: true })
          .fill(inputs.discourse.password);
        await page.getByRole("button", { name: "Log In", exact: true }).click({ timeout: 25000 });
        await page.waitForURL((u) => u.pathname !== "/login", {
          timeout: 25000,
          waitUntil: "domcontentloaded",
        });
        await page.goto(origin + "/t/blind-1031-lantern-release-check-0834-verified/81", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      }
      await page.waitForTimeout(2000);
      const images = await page.locator("img").evaluateAll((xs) =>
        xs
          .map((e) => ({
            source: {
              origin: new URL(e.currentSrc || e.src, location.href).origin,
              path: new URL(e.currentSrc || e.src, location.href).pathname,
            },
            width: e.naturalWidth,
            complete: e.complete,
            alt: e.alt,
          }))
          .filter((x) => x.width === 0),
      );
      await page.screenshot({ path: root + "/" + app + "-" + scope + ".png" });
      rows.push({
        app,
        scope,
        url: page.url(),
        pageTitle: await page.title(),
        imageCount: await page.locator("img").count(),
        elapsedMs: Date.now() - started,
        images,
        blocked,
        failed,
        responses,
      });
      console.log(JSON.stringify(rows.at(-1)));
    } catch (e) {
      rows.push({ app, scope, error: e.message });
      console.log(JSON.stringify(rows.at(-1)));
    } finally {
      await browser.close();
      await proxy?.close();
    }
  }
await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ root }));
