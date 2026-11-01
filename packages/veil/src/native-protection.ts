import { readFileSync } from "node:fs";

// Load plain browser JavaScript, never a server-transformed Function.toString().
// Server transpilers may inject helpers that do not exist in the browser world.
const runtime = readFileSync(new URL("./native-mask-runtime.js", import.meta.url), "utf8");
export function nativeProtectionScript(values: readonly string[]): string {
  return (
    "(() => {\n" +
    runtime +
    "\ninstallNativeMasks(" +
    JSON.stringify(values.filter(Boolean)) +
    ");\n})()"
  );
}
