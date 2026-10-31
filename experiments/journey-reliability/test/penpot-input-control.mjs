// Explicitly approved one-new-file control. No existing design or settings edit.
// Native keyboard and plain-text clipboard only; no editor-model injection.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { privateClipboard } from "../../../packages/praxis/src/mcp-native/native-interactions.mjs";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const input = JSON.parse(await readFile("/inputs.json", "utf8")).penpot;
const root = "/results/penpot-input-control-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1320x820x24", "-nolisten", "tcp"], {
  stdio: ["ignore", "ignore", "ignore", "pipe"],
});
const display = await new Promise((resolve, reject) => {
  let s = "";
  xvfb.once("error", reject);
  xvfb.stdio[3].on("data", (b) => {
    s += b;
    if (s.includes("\n")) resolve(":" + s.trim());
  });
});
const browser = await chromium.launch({
  headless: false,
  args: ["--no-sandbox"],
  env: { ...process.env, DISPLAY: display },
});
let file, controlPage;
const memory = async () => ({
  peak: await readFile("/sys/fs/cgroup/memory.peak", "utf8").catch(() => ""),
  events: await readFile("/sys/fs/cgroup/memory.events", "utf8").catch(() => ""),
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } }),
    page = await context.newPage();
  controlPage = page;
  await page.goto("http://penpot:8080/#/auth/login");
  await page.getByRole("textbox", { name: "Work email", exact: true }).fill(input.username);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(input.password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL((u) => !u.hash.includes("/auth/"), { timeout: 30000 });
  // Exactly one file was approved and already created. No creation fallback.
  const receiptPath = process.env.SCRY_PENPOT_CONTROL_RECEIPT;
  if (
    !receiptPath ||
    !/^\/results\/penpot-input-control-\d+\/created-file\.json$/.test(receiptPath)
  )
    throw Error("Explicit existing control receipt required; no new creation allowed");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (
    receipt.kind !== "one_new_fictional_file_control" ||
    new URL(receipt.file).origin !== "http://penpot:8080"
  )
    throw Error("Invalid control receipt");
  file = receipt.file;
  await page.goto(file);
  await page.getByRole("tab", { name: "Layers", exact: true }).waitFor({ timeout: 30000 });
  const title = await page.title();
  const inspect = () =>
    page.locator("[contenteditable] span[data-text]").evaluateAll((ns) =>
      ns.map((n) => {
        const s = getComputedStyle(n),
          r = n.getBoundingClientRect();
        return { text: n.textContent, font: s.font, color: s.color, height: r.height };
      }),
    );
  const cases = [];
  for (const [method, y] of [
    ["keyboard", 190],
    ["paste", 340],
  ]) {
    await page.getByRole("button", { name: "Text (T)", exact: true }).click();
    await page.mouse.move(500, y);
    await page.mouse.down();
    await page.mouse.move(800, y + 70, { steps: 5 });
    await page.mouse.up();
    const editor = page.locator("[contenteditable=true][role=textbox]");
    // Penpot deliberately hides the HTML editor behind its visual layer. Do not
    // confuse its zero-height empty box with missing native keyboard focus.
    await editor.waitFor({ state: "attached", timeout: 10000 });
    if (
      !(await editor.evaluate(
        (e) => e === document.activeElement || e.contains(document.activeElement),
      ))
    )
      throw Error("Native control text receiver does not own focus");
    const lines =
      method === "keyboard"
        ? ["Keyboard visible control", "Second native line"]
        : ["Plain paste visible control", "Second pasted line"];
    if (method === "keyboard") {
      await page.keyboard.type(lines[0]);
      await page.keyboard.press("Enter");
      await page.keyboard.type(lines[1]);
    } else {
      await privateClipboard(display).write(lines.join("\n"));
      await page.keyboard.press("Control+V");
    }
    await page.waitForTimeout(500);
    const editing = await inspect();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
    const screenshot = root + "/" + method + ".png";
    await page.screenshot({ path: screenshot });
    cases.push({ method, lines, editing, screenshot });
  }
  await page.waitForTimeout(1500);
  await page.reload();
  await page.getByRole("tab", { name: "Layers", exact: true }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: root + "/reloaded.png" });
  await writeFile(
    root + "/result.json",
    JSON.stringify(
      {
        root,
        file,
        title,
        cases,
        memory: await memory(),
        kind: "controlled_native_input_comparison_not_blind_acceptance",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ root, file, title, cases }));
} catch (error) {
  const pageState = await controlPage
    ?.locator("body")
    .innerText({ timeout: 1500 })
    .catch(() => "unavailable");
  await controlPage?.screenshot({ path: root + "/failure.png", timeout: 2000 }).catch(() => {});
  await writeFile(
    root + "/failure.json",
    JSON.stringify(
      {
        root,
        file,
        message: String(error.message).replaceAll(input.password, "[SECRET]"),
        memory: await memory(),
        pageState: pageState?.replaceAll(input.password, "[SECRET]").slice(0, 4000),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  throw error;
} finally {
  await browser.close();
  xvfb.kill("SIGTERM");
}
