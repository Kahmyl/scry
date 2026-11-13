import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { SanitizedBrowserRecorder, BrowserReplayRenderer } from "@scry/praxis";
import { ChronicleEvidenceService, readNativeEvidence, readNativeMedia } from "@scry/chronicle";
import { EvidenceCipher, nativeProtectionScript, createNativeAdapterProtector } from "@scry/veil";
import { recordingAdmission } from "./fixtures/evidence-admission.js";

const browserTest = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;

describe("native browser evidence", () => {
  browserTest(
    "keeps original layout, icons and ordinary content while recording opaque frosted masks",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "scry-native-recording-"));
      const admission = recordingAdmission(
        "native-fixture",
        "00000000-0000-4000-8000-000000000202",
      );
      const protection = new EvidenceCipher(randomBytes(32));
      const evidence = await new ChronicleEvidenceService(new BrowserReplayRenderer()).openSession({
        root,
        runId: "00000000-0000-4000-8000-000000000202",
        sessionId: "native-fixture",
        protection,
        admission,
        maxSessionBytes: 1024 * 1024,
      });
      const native = await evidence.createNativeRecording();
      const nativeProtection = createNativeAdapterProtector({ PASSWORD: "fixture-access-secret" });
      const browser = await chromium.launch({
        headless: true,
        ...(process.env.SCRY_BROWSER_CHANNEL ? { channel: process.env.SCRY_BROWSER_CHANNEL } : {}),
      });
      try {
        const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
        const page = await context.newPage();
        const recorder = new SanitizedBrowserRecorder({
          native,
          protection: nativeProtection,
          recoverCaptures: () => evidence.recoverNativeCaptures(native),
        });
        await recorder.start(context);
        expect(
          await page.evaluate(
            () =>
              typeof (globalThis as unknown as { __scryNativeRefresh?: unknown })
                .__scryNativeRefresh,
          ),
        ).toBe("undefined");
        await evidence.startCapture();
        await context.route("https://native-fixture.test/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<style>body{margin:30px;font:20px sans-serif;background:#eee} main{display:grid;gap:20px}input{height:40px}svg{fill:#008800}</style><main><h1>Account settings</h1><svg width="40" height="40"><rect width="40" height="40"/></svg><label>Email<input name="email" value="person@example.com"></label><label>Password<input type="password" value="fixture-access-secret"></label><label>Card number<input autocomplete="cc-number" name="cardNumber" value="4242 4242 4242 4242"></label><label>API key<input name="apiKey" value="fictional-key-alpha"></label><p>Ordinary business description remains visible.</p></main>`,
          }),
        );
        await page.goto("https://native-fixture.test/");
        const before = await page.locator("main").boundingBox();
        const passwordBox = await page.locator('input[type="password"]').boundingBox();
        const cardBox = await page.locator('input[name="cardNumber"]').boundingBox();
        const emailBox = await page.locator('input[name="email"]').boundingBox();
        const iconBox = await page.locator("svg").boundingBox();
        await page.locator('input[name="apiKey"]').focus();
        await recorder.checkpoint("initial");
        const originalMasked = await page.screenshot();
        await page
          .locator('input[name="apiKey"]')
          .fill("fictional-key-bravo-with-a-different-length");
        await recorder.checkpoint("fill");
        expect((await page.screenshot()).equals(originalMasked)).toBe(true);
        await recorder.checkpoint("initial"); // Exact duplicate gallery item is discarded.
        await page.locator('input[name="email"]').fill("updated@example.com");
        await recorder.checkpoint("fill");
        await page.waitForTimeout(300); // Retain a stable application frame for video decoding.
        expect(await page.locator("main").boundingBox()).toEqual(before);
        expect(await page.locator("svg").isVisible()).toBe(true);
        await recorder.close();
        await context.close();
        await evidence.stopCapture({ browserStopped: true, recordingDrained: true });
        const completion = await evidence.seal({ renderVideo: true, actionLedger: async () => [] });
        expect(completion.state).toBe("complete");
        const manifest = await readNativeEvidence({
          root,
          protection,
          snapshot: { ...(await admission.readStream()), sealedAt: new Date().toISOString() },
        });
        expect(manifest.filter((item) => item.kind === "video")).toHaveLength(1);
        expect(manifest.filter((item) => item.kind === "screenshot").length).toBeLessThanOrEqual(3);
        const video = await readNativeMedia(
          root,
          manifest.find((item) => item.kind === "video")!,
        );
        expect(video.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
        const screenshot = manifest.find((item) => item.kind === "screenshot")!;
        const bytes = await readNativeMedia(root, screenshot);
        // Inspect actual saved native pixels, not the application DOM or a replay.
        const checker = await browser.newPage({ viewport: { width: 800, height: 600 } });
        await checker.setContent(`<canvas width="800" height="600"></canvas>`);
        const pixels = await checker.evaluate(
          async ({ encoded, boxes }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${encoded}`;
            await image.decode();
            const ctx = document.querySelector("canvas")!.getContext("2d")!;
            ctx.drawImage(image, 0, 0);
            return boxes.map((box) => [
              ...ctx.getImageData(
                Math.floor(box!.x + box!.width / 2),
                Math.floor(box!.y + box!.height / 2),
                1,
                1,
              ).data,
            ]);
          },
          { encoded: bytes.toString("base64"), boxes: [passwordBox, cardBox, emailBox, iconBox] },
        );
        for (const protectedPixel of pixels.slice(0, 2)) {
          expect(protectedPixel![3]).toBe(255);
          expect(protectedPixel).not.toEqual([0, 0, 0, 255]);
          // Opaque #e5e9ed with the shipped white-18% / dark-5% texture.
          // The old blurred stripe's red-channel ceiling excluded the new
          // highlight (234). Check every channel, including raster rounding;
          // an uncovered white input still fails these bounds.
          for (const [channel, minimum, maximum] of [
            [0, 222, 234],
            [1, 226, 238],
            [2, 231, 241],
          ] as const) {
            expect(protectedPixel![channel]).toBeGreaterThanOrEqual(minimum);
            expect(protectedPixel![channel]).toBeLessThanOrEqual(maximum);
          }
        }
        expect(pixels[2]).not.toEqual(pixels[0]);
        expect(pixels[3]).toEqual([0, 136, 0, 255]);
        const recordedFrames = await checker.evaluate(
          async ({ encoded, boxes }) => {
            const video = document.createElement("video");
            video.muted = true;
            video.src = `data:video/webm;base64,${encoded}`;
            const canvas = document.createElement("canvas");
            canvas.width = 800;
            canvas.height = 600;
            const context = canvas.getContext("2d")!;
            const frames: number[][][] = [];
            const sample = () => {
              context.drawImage(video, 0, 0, 800, 600);
              frames.push(
                boxes.map((box) =>
                  Array.from(
                    context.getImageData(
                      Math.floor(box!.x + box!.width / 2),
                      Math.floor(box!.y + box!.height / 2),
                      1,
                      1,
                    ).data,
                  ),
                ),
              );
            };
            try {
              await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                  () => reject(new Error("Saved recording did not finish playback")),
                  10000,
                );
                video.onerror = () => {
                  clearTimeout(timeout);
                  reject(new Error("Saved recording could not decode"));
                };
                video.onended = () => {
                  sample();
                  clearTimeout(timeout);
                  resolve();
                };
                const next = () => {
                  sample();
                  if (!video.ended) video.requestVideoFrameCallback(next);
                };
                video.requestVideoFrameCallback(next);
                void video.play().catch(reject);
              });
              return frames;
            } finally {
              video.pause();
              video.removeAttribute("src");
              video.load();
            }
          },
          { encoded: video.toString("base64"), boxes: [passwordBox, cardBox, iconBox] },
        );
        const applicationFrames = recordedFrames.filter(
          (frame) => frame[2]![1]! > 100 && frame[2]![0]! < 30,
        );
        expect(applicationFrames.length).toBeGreaterThan(0);
        for (const frame of applicationFrames) {
          for (const pixel of frame.slice(0, 2)) {
            expect(pixel[0]).toBeGreaterThanOrEqual(140); // Lossy native-video codec tolerance.
            expect(pixel[0]).toBeLessThanOrEqual(240);
            expect(pixel[3]).toBe(255);
          }
        }
        if (process.env.SCRY_MASK_PROOF_DIR) {
          await mkdir(process.env.SCRY_MASK_PROOF_DIR, { recursive: true });
          await writeFile(path.join(process.env.SCRY_MASK_PROOF_DIR, "native-capture.png"), bytes);
          await writeFile(
            path.join(process.env.SCRY_MASK_PROOF_DIR, "native-recording.webm"),
            video,
          );
          await writeFile(
            path.join(process.env.SCRY_MASK_PROOF_DIR, "decoded-pixels.json"),
            JSON.stringify({ screenshot: pixels, recording: applicationFrames }, null, 2),
          );
        }
        await writeFile(path.join(root, "pixel-probe.json"), JSON.stringify(pixels));
        expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(await readFile(completion.replayObjectKey!.slice(8), "utf8")).toContain(
          "best effort",
        );
      } finally {
        nativeProtection.dispose();
        await browser.close();
      }
    },
    30000,
  );

  browserTest(
    "leaves unknown content visible without a disclosure barrier or full-page replacement",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<main><h1>Customer workspace</h1><p>person@example.com · +2348012345678</p><div data-private>Quarterly business note</div><input name="displayName" value="Ordinary name"></main>',
        );
        await page.evaluate(nativeProtectionScript([]));
        await page.waitForTimeout(100);
        expect(await page.locator("body").innerText()).toContain("Quarterly business note");
        expect(await page.locator("input").inputValue()).toBe("Ordinary name");
        expect(await page.locator("body").innerText()).not.toContain("QUARANTINED");
        expect(await page.locator("body").innerText()).not.toContain("decisions are pending");
      } finally {
        await browser.close();
      }
    },
    15000,
  );
});
