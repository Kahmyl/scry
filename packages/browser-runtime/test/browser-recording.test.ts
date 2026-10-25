import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  AuthenticatedEvidenceStore,
  SanitizedBrowserRecorder,
  renderSanitizedReplay,
} from "../src/index.js";
import { ProtectionAuthority, SensitiveValueClassifier } from "@scry/veil";

const browserTest = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;

describe("browser recording and offline replay", () => {
  browserTest(
    "preserves a masked interval while Veil settles a short protected response",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "browser-recording-barrier-"));
      const secret = "violet7";
      const store = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
        directory: path.join(root, "evidence"),
        runId: "00000000-0000-4000-8000-000000000202",
        scopeId: "browser-recording-barrier",
        encryptionKey: randomBytes(32),
      }).initialize();
      const authority = new ProtectionAuthority({
        scope: {
          projectId: "fixture-project",
          missionId: "fixture-mission",
          runId: "00000000-0000-4000-8000-000000000202",
          sessionId: "fixture-session",
          origin: "https://fixture.example",
        },
      });
      const browser = await chromium.launch({ headless: true, channel: "chrome" });
      const context = await browser.newContext();
      const page = await context.newPage();
      const recorder = new SanitizedBrowserRecorder({ store, authority });
      await recorder.start(context);
      const token = authority.begin("effect-short-secret");
      await page.setContent(`<main><div role="dialog">Activation: ${secret}</div></main>`);
      await page.waitForTimeout(250);
      authority.settle({
        token,
        captureId: "capture-short-secret",
        candidates: [{ path: ["activationCode"], value: secret }],
        proposals: [
          { key: "activation_code", path: ["activationCode"], classification: "protected" },
        ],
      });
      await recorder.checkpoint();
      await recorder.flush();
      await recorder.close();
      await context.close();
      await browser.close();
      const serialized = JSON.stringify((await store.verify()).events);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("QUARANTINED");
      expect(serialized).toContain("PROTECTED");
    },
    30_000,
  );

  browserTest(
    "records continuously, redacts before persistence, and replays with zero network",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "browser-recording-"));
      const evidenceDirectory = path.join(root, "evidence");
      const outputDirectory = path.join(root, "rendered");
      const ledgerPath = path.join(root, "action-ledger.jsonl");
      const secret = "fixtureSecret7Qp9Zx4Lm2N8Rc6V";
      const store = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
        directory: evidenceDirectory,
        runId: "00000000-0000-4000-8000-000000000201",
        scopeId: "browser-recording-fixture",
        encryptionKey: randomBytes(32),
      }).initialize();
      const classifier = new SensitiveValueClassifier({
        protectedValues: { GENERATED_SECRET: secret },
      });
      const browser = await chromium.launch({ headless: true, channel: "chrome" });
      const context = await browser.newContext();
      const page = await context.newPage();
      const recorder = new SanitizedBrowserRecorder({
        store,
        classifier,
        protectedValues: { GENERATED_SECRET: secret },
      });
      await recorder.start(context);
      await page.setContent(
        `<!doctype html><main><h1>Credential created</h1><div role="dialog"><span>${secret}</span><button>Continue</button></div></main>`,
      );
      await page.waitForTimeout(750);
      const diagnostics = await recorder.flush();
      await recorder.close();
      await context.close();
      await browser.close();
      expect(diagnostics.errors).toEqual([]);

      const verified = await store.verify();
      const serialized = JSON.stringify(verified.events);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("Credential created");
      expect(serialized).toContain("PROTECTED:REFERENCE:GENERATED_SECRET");
      const files = await readdir(evidenceDirectory);
      const persisted = (
        await Promise.all(files.map((file) => readFile(path.join(evidenceDirectory, file), "utf8")))
      ).join("\n");
      expect(persisted).not.toContain(secret);

      const publication = await renderSanitizedReplay({
        events: verified.events,
        ledgerPath,
        outputDirectory,
        framesPerSecond: 2,
      });
      expect(publication.networkRequests).toBe(0);
      expect(publication.frameCount).toBeGreaterThanOrEqual(3);
      expect(publication.playbackRate).toBe(8);
      expect(publication.renderDurationMs).toBeLessThanOrEqual(publication.durationMs);
      await expect(access(publication.videoPath)).resolves.toBeUndefined();
      const second = await renderSanitizedReplay({
        events: verified.events,
        ledgerPath,
        outputDirectory,
        framesPerSecond: 2,
      });
      expect(second.reusedPublication).toBe(true);
    },
    30_000,
  );
});
