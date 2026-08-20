import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const enabled = process.env.SCRY_VITRACT_PREVIEW_E2E === "true";
const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

describe.skipIf(!enabled)("Vitract Preview adaptive-authoring acceptance", () => {
  it("runs protected login and read-only Developer inspection through Scry", async () => {
    const result = await runCampaign();
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('"verdict":"pass"');
    expect(result.output).not.toMatch(/password|access[_-]?token|client[_-]?secret/i);
  }, 180_000);
});

function runCampaign(): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    // The Vitract campaign targets the deployed control plane, never the destructive integration DB.
    delete environment.SCRY_AUTHORING_TEST_DATABASE_URL;
    const child = spawn("pnpm", ["campaign:adaptive:m1:vitract"], {
      cwd: workspaceRoot,
      env: {
        ...environment,
        SCRY_ENABLE_VITRACT_CAMPAIGN: "true",
        SCRY_SERVICE_TOKEN:
          process.env.SCRY_VITRACT_SERVICE_TOKEN ?? "local-only-scry-service-token-change-me",
        SCRY_RELEASE_ID: process.env.SCRY_RELEASE_ID ?? "release-corpus",
        SCRY_SCHEMA_FINGERPRINT: process.env.SCRY_SCHEMA_FINGERPRINT ?? "unverified-schema",
        SCRY_RUNTIME_VERSION: process.env.SCRY_RUNTIME_VERSION ?? "release-corpus",
        SCRY_GIT_COMMIT: process.env.SCRY_GIT_COMMIT ?? "working-tree",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ exitCode: signal ? 1 : (code ?? 1), output: output.slice(-8_000) }),
    );
  });
}
