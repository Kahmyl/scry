// Explicitly user-approved read-only diagnostic, not blind acceptance.
// Reopen one owned fictional file without changing its design or settings.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const input = JSON.parse(await readFile("/inputs.json", "utf8")).penpot;
const root = "/results/penpot-render-control-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1320x820x24", "-nolisten", "tcp"], {
  stdio: ["ignore", "ignore", "ignore", "pipe"],
});
const display = await new Promise((resolve, reject) => {
  let text = "";
  xvfb.once("error", reject);
  xvfb.stdio[3].on("data", (b) => {
    text += b;
    if (text.includes("\n")) resolve(":" + text.trim());
  });
});
const mask = await readFile("/workspace/packages/veil/src/native-mask-runtime.js", "utf8");
const file =
  "http://penpot:8080/#/workspace?team-id=3348585c-6b16-800c-8008-de660926250b&file-id=ab8db2ef-75b0-81e4-8008-dfe9c035f529&page-id=ab8db2ef-75b0-81e4-8008-dfe9c035f52a";
const browser = await chromium.launch({
  headless: false,
  args: ["--no-sandbox"],
  env: { ...process.env, DISPLAY: display },
});
const results = [];
try {
  for (const masked of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage(),
      network = [],
      diagnostics = [];
    const safeDiagnostic = (text) =>
      String(text)
        .replaceAll(input.password, "[SECRET]")
        .replace(/[A-Za-z0-9_=-]{24,}/g, "[TOKEN]")
        .slice(0, 1500);
    page.on("pageerror", (error) =>
      diagnostics.push({ type: "pageerror", message: safeDiagnostic(error.message) }),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        diagnostics.push({ type: "console_error", message: safeDiagnostic(message.text()) });
    });
    const safeUrl = (url) => {
      try {
        const u = new URL(url);
        return u.origin + u.pathname;
      } catch {
        return "invalid";
      }
    };
    page.on("requestfailed", (r) =>
      network.push({ type: "failed", url: safeUrl(r.url()), error: r.failure()?.errorText }),
    );
    page.on("response", (r) => {
      if (/font|woff|ttf/.test(r.url()) || r.status() >= 400)
        network.push({ type: "response", url: safeUrl(r.url()), status: r.status() });
    });
    if (masked) {
      const session = await context.newCDPSession(page);
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: mask + "\ninstallNativeMasks([]);",
        worldName: "scry-native-protection",
        runImmediately: true,
      });
    }
    await page.goto("http://penpot:8080/#/auth/login");
    await page.getByRole("textbox", { name: "Work email", exact: true }).fill(input.username);
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(input.password);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL((url) => !url.hash.includes("/auth/"), { timeout: 30000 });
    await page.goto(file);
    await page.getByRole("tab", { name: "Layers", exact: true }).waitFor({ timeout: 30000 });
    await page.getByText("Lantern copy", { exact: true }).waitFor({ timeout: 30000 });
    await page.waitForTimeout(3000); // Controlled asynchronous font/paint settling.
    const filename = root + (masked ? "/overlay.png" : "/bare.png");
    await page.screenshot({ path: filename });
    const dom = await page
      .locator("svg text,svg foreignObject,[contenteditable],canvas")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const s = getComputedStyle(n),
            r = n.getBoundingClientRect();
          return {
            tag: n.tagName,
            text: (n.textContent ?? "").slice(0, 1000),
            font: s.font,
            fill: s.fill,
            color: s.color,
            opacity: s.opacity,
            visibility: s.visibility,
            display: s.display,
            box: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        }),
      );
    await page.getByText("Lantern copy", { exact: true }).click();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const editing = await page.locator("[contenteditable],textarea,input").evaluateAll((nodes) =>
      nodes
        .filter((n) => n.isContentEditable || n.matches("textarea"))
        .map((n) => {
          const s = getComputedStyle(n),
            r = n.getBoundingClientRect();
          return {
            tag: n.tagName,
            text: n.textContent,
            html: n.outerHTML.slice(0, 10000),
            leaves: [...n.querySelectorAll("span")].map((leaf) => {
              const style = getComputedStyle(leaf),
                rect = leaf.getBoundingClientRect();
              return {
                text: leaf.textContent,
                font: style.font,
                lineHeight: style.lineHeight,
                display: style.display,
                height: rect.height,
              };
            }),
            font: s.font,
            color: s.color,
            opacity: s.opacity,
            visibility: s.visibility,
            box: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        }),
    );
    const fonts = await page.evaluate(() =>
      [...document.fonts].map((f) => ({ family: f.family, status: f.status, weight: f.weight })),
    );
    await page.screenshot({ path: root + (masked ? "/overlay-editing.png" : "/bare-editing.png") });
    await page.keyboard.press("Escape");
    results.push({ masked, screenshot: filename, network, dom, editing, fonts, diagnostics });
    await context.close();
  }
  await writeFile(
    root + "/result.json",
    JSON.stringify(
      { kind: "controlled_read_only_render_comparison_not_blind_acceptance", root, results },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      root,
      variants: results.map(({ masked, screenshot, network }) => ({ masked, screenshot, network })),
    }),
  );
} finally {
  await browser.close();
  xvfb.kill("SIGTERM");
}
