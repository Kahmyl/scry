import { chromium } from "playwright";
import { recording } from "../src/recording.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { displayLayout } from "../src/display-layout.mjs";
const root = "/results/viewport-" + Date.now();
await mkdir(root, { recursive: true });
const recorder = await recording(root);
let browser;
try {
  browser = await chromium.launch({
    headless: false,
    env: { ...process.env, DISPLAY: recorder.display },
    args: ["--no-sandbox", "--window-position=0,0"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const target = await cdp.send("Target.getTargetInfo");
  const window = await cdp.send("Browser.getWindowForTarget", {
    targetId: target.targetInfo.targetId,
  });
  await cdp.send("Browser.setWindowBounds", {
    windowId: window.windowId,
    bounds: displayLayout.window,
  });
  await page.setContent(
    "<style>html,body{margin:0;height:100%;background:white}header{height:60px;background:red}footer{position:fixed;bottom:0;height:60px;background:blue;width:100%}</style><header>VIEWPORT TOP</header><main>Native geometry qualification</main><footer>VIEWPORT BOTTOM</footer>",
  );
  const geometry = await page.evaluate(() => ({
    innerHeight,
    innerWidth,
    outerHeight,
    outerWidth,
    screenY,
    screenX,
    devicePixelRatio,
  }));
  geometry.window = await cdp.send("Browser.getWindowForTarget", {
    targetId: target.targetInfo.targetId,
  });
  await writeFile(root + "/geometry.json", JSON.stringify(geometry, null, 2));
  console.log(JSON.stringify({ root, geometry }));
  await page.screenshot({ path: root + "/viewport.png" });
  await new Promise((resolve) => setTimeout(resolve, 1500));
} finally {
  console.log(await readFile("/sys/fs/cgroup/memory.events", "utf8"));
  console.log(JSON.stringify(await recorder.close()));
  await browser?.close();
}
const pixels = execFileSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-sseof",
    "-0.5",
    "-i",
    root + "/recording.mp4",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ],
  { maxBuffer: 10 * 1024 * 1024 },
);
const at = (x, y) => [...pixels.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3)];
const top = at(1000, 0),
  bottom = at(1000, 719);
const left = at(0, 20),
  right = at(1279, 20);
console.log(JSON.stringify({ top, bottom, left, right }));
await writeFile(root + "/pixels.json", JSON.stringify({ top, bottom, left, right }));
assert.ok(top[0] > 200 && top[2] < 40, "Viewport top was cropped or browser chrome included");
assert.ok(bottom[2] > 200 && bottom[0] < 40, "Viewport bottom was cropped");
assert.ok(left[0] > 200 && left[2] < 40, "Viewport left was cropped");
assert.ok(right[0] > 200 && right[2] < 40, "Viewport right was cropped");
