import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("loads the formatted browser assets in a plain Node worker without transpiler helpers", () => {
  const moduleUrl = new URL("../src/mcp-native/known-controls.mjs", import.meta.url).href;
  const script = `const m=await import(${JSON.stringify(moduleUrl)}); if(typeof m.bindKnownControls!=='function'||typeof m.observeControlState!=='function')throw Error('ASSET_EXPORT_MISSING');`;
  expect(() =>
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], { stdio: "pipe" }),
  ).not.toThrow();
});
