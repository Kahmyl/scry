// Inspect actual captured video and the read-only UX preview. No app mutation.
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const require = createRequire("/workspace/packages/praxis/package.json"),
  { chromium } = require("playwright-mcp-runtime"),
  exec = promisify(execFile);
const root = "/results/journey-artifact-review-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const long = "/results/journey-long-1793448283045/video/recording.mp4",
  result = { root };
const probe = JSON.parse(
  (
    await exec("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", long], {
      timeout: 30000,
    })
  ).stdout,
);
result.video = {
  duration: Number(probe.format.duration),
  bytes: Number(probe.format.size),
  codec: probe.streams[0].codec_name,
  rate: probe.streams[0].r_frame_rate,
};
assert.ok(result.video.duration > 1200);
await exec("ffmpeg", ["-v", "error", "-threads", "1", "-i", long, "-f", "null", "-"], {
  timeout: 180000,
  maxBuffer: 1024 * 1024,
});
result.fullNativeVideoDecoded = true;
for (const sec of [30, 925, 1180])
  await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(sec),
      "-i",
      long,
      "-frames:v",
      "1",
      root + "/native-second-" + sec + ".png",
    ],
    { timeout: 30000 },
  );
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.SCRY_UI_URL);
  await page.getByRole("heading", { name: "GitLab issue lifecycle", exact: true }).waitFor();
  await page.getByRole("link", { name: "View test report", exact: true }).click();
  await page.getByRole("heading", { name: "What was verified", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Avatar images did not load", exact: true }).count(),
    1,
  );
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2, null, {
    timeout: 10000,
  });
  await page.screenshot({ path: root + "/report-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "Review supporting evidence", exact: true }).click();
  assert.equal(await page.locator("#report").isVisible(), true);
  await page
    .getByRole("button", { name: "Saved content restored after discard Screenshot", exact: true })
    .click();
  const image = page.getByRole("img", {
    name: "Saved content restored after discard",
    exact: true,
  });
  await image.waitFor();
  assert.equal(await image.evaluate((e) => e.complete && e.naturalWidth > 0), true);
  await page.locator("#evidence").screenshot({ path: root + "/evidence-desktop.png" });
  await page
    .getByRole("button", {
      name: "Issue lifecycle: create, edit, verify and sign out Recording",
      exact: true,
    })
    .click();
  await page.locator("video").waitFor();
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 1, null, {
    timeout: 10000,
  });
  result.player = await page
    .locator("video")
    .evaluate((v) => ({ rate: v.playbackRate, duration: v.duration, autoplay: v.autoplay }));
  assert.equal(result.player.rate, 1);
  assert.equal(result.player.autoplay, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "← Back to mission", exact: true }).click();
  await page.getByRole("link", { name: "View test report", exact: true }).waitFor();
  result.mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(result.mobileOverflow, false);
  await page.screenshot({ path: root + "/mission-mobile.png", fullPage: true });
  await page.getByRole("link", { name: "Review evidence", exact: true }).click();
  await page
    .getByLabel("Choose evidence", { exact: true })
    .selectOption({ label: "Signed out · Screenshot" });
  await page.locator("#evidence").screenshot({ path: root + "/evidence-mobile.png" });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  assert.deepEqual(errors, []);
  result.uiChecksPassed = true;
  await context.close();
} catch (e) {
  result.uiChecksPassed = false;
  result.error = e.message;
} finally {
  await browser?.close();
  await writeFile(root + "/results.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
