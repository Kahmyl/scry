import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const assets = resolve("apps/web/dist/assets");
const files = (await readdir(assets)).filter((file) => file.endsWith(".js"));
const bundle = (
  await Promise.all(files.map((file) => readFile(resolve(assets, file), "utf8")))
).join("\n");

const forbidden = [
  "New Mission",
  "Edit Mission",
  "New Flow",
  "Edit Flow",
  "Rerun exact plan",
  "/rerun",
  "/objectives",
  "/flow-revisions",
  "Evidence privacy by environment",
  "Increase privacy",
  "Capture minimum",
  "VEIL_USER_REQUESTED_PRIVACY",
  "/environments/",
];
const retained = ["Praxis interactions", "Cancel", "MCP setup", "Approve", "Reject"];
const violations = forbidden.filter((value) => bundle.includes(value));
const missing = retained.filter((value) => !bundle.includes(value));

if (violations.length || missing.length) {
  console.error(JSON.stringify({ violations, missing }, null, 2));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      { status: "passed", checkedBundles: files.length, forbidden, retained },
      null,
      2,
    ),
  );
}
