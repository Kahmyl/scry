import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("../", import.meta.url).pathname);
const image = "scry-veil-runtime:qualification";

execFileSync("docker", ["build", "--target", "prod-deps", "-t", image, "."], {
  cwd: root,
  stdio: "inherit",
});

const mounts = [
  "packages/veil/src",
  "packages/contracts/src",
  "packages/browser-runtime/src",
  "apps/api/src",
  "apps/api/tsconfig.json",
].flatMap((relativePath) => [
  "--mount",
  `type=bind,src=${path.join(root, relativePath)},dst=/workspace/${relativePath},readonly`,
]);

const smoke = `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { BrowserProtectedValueCipher } from "./src/browser-execution/protected-value-cipher.ts";
import { BrowserRuntimeVeilReportProtection } from "./src/browser-execution/browser-boundary-composition.ts";
import { AuthenticatedEvidenceStore } from "@scry/browser-runtime";
process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
const cipher = new BrowserProtectedValueCipher();
const context = { projectId: "qualification", canonicalName: "credential" };
assert.equal(cipher.decrypt(cipher.encrypt("qualification-secret", context), context), "qualification-secret");
assert.equal(typeof new BrowserRuntimeVeilReportProtection().createReportSanitizer, "function");
assert.equal(typeof AuthenticatedEvidenceStore, "function");
assert.equal(existsSync("/workspace/node_modules/typescript"), false);
assert.equal(existsSync("/workspace/packages/assurance"), false);
console.log("VEIL_PRODUCTION_IMPORTS_PASS");
`;

const output = execFileSync(
  "docker",
  [
    "run",
    "--rm",
    ...mounts,
    "--workdir",
    "/workspace/apps/api",
    image,
    "node",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    smoke,
  ],
  { cwd: root, encoding: "utf8", timeout: 30_000 },
);
if (!output.includes("VEIL_PRODUCTION_IMPORTS_PASS"))
  throw new Error("Veil production import assertions did not execute");
process.stdout.write(
  "Veil production dependencies, encrypted values, and application adapters verified without development tools or Assurance.\n",
);
