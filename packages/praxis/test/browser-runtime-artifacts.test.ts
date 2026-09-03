import { describe, expect, it } from "vitest";

import {
  inspectBrowserRuntimeArtifacts,
  visualRedactionInitScript,
} from "../src/browser-runtime-artifacts.js";
import {
  browserObservationRuntimeHealth,
  verifyBrowserObservationRuntime,
} from "../src/grounding.js";
import { openPraxisBrowserSession } from "../src/lifecycle/browser-session.js";

describe("browser observation runtime artifacts", () => {
  it("ships self-contained artifacts without transpiler helpers", () => {
    expect(visualRedactionInitScript).not.toContain("__name");
    expect(visualRedactionInitScript).not.toContain("__awaiter");
    const manifest = inspectBrowserRuntimeArtifacts({
      privacyInjection: visualRedactionInitScript,
    });
    expect(manifest.healthy).toBe(true);
    expect(manifest.runtimeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("makes runtime health a deterministic release gate", () => {
    const health = browserObservationRuntimeHealth();
    expect(health.healthy).toBe(true);
    expect(health.runtimeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(health.capabilityManifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("executes observer and privacy artifacts in the production browser boundary", async () => {
    const browserChannel = process.env.SCRY_BROWSER_CHANNEL ?? "chrome";

    await expect(
      verifyBrowserObservationRuntime(browserChannel, () =>
        openPraxisBrowserSession({
          browserChannel,
          headless: true,
        }),
      ),
    ).resolves.toMatchObject({
      healthy: true,
      diagnostics: [],
    });
  }, 15_000);
});
