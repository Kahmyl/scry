import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const require = createRequire(path.join(root, "apps/web/package.json"));
const { build } = createRequire(fs.realpathSync(require.resolve("vite")))("esbuild");
const result = await build({
  stdin: {
    contents: fs.readFileSync(
      new URL(
        "../../../../../apps/web/test/fixtures/native-observation-recovery.js",
        import.meta.url,
      ),
      "utf8",
    ),
    resolveDir: path.join(root, "apps/web"),
    loader: "js",
  },
  bundle: true,
  write: false,
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const directory = path.join(root, "artifacts/assurance/native-action-recovery");
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, "application.bundle"), result.outputFiles[0].text);
