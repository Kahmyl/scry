import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "compose.deploy.yml");

const fileBackedConfigs = [
  ["postgres_hba", "./ops/postgres/pg_hba.conf"],
  ["prometheus_config", "./ops/observability/prometheus.yml"],
  ["prometheus_rules", "./ops/observability/rules.yml"],
  ["blackbox_config", "./ops/observability/blackbox.yml"],
];

export function renderComposeOci(outputPath) {
  const resolvedOutputPath = resolve(outputPath);
  if (resolvedOutputPath === sourcePath)
    throw new Error("the OCI renderer must not overwrite compose.deploy.yml");

  let rendered = readFileSync(sourcePath, "utf8");
  for (const [configName, relativePath] of fileBackedConfigs) {
    const declaration = `  ${configName}:\n    file: ${relativePath}`;
    if (rendered.split(declaration).length !== 2)
      throw new Error(`expected exactly one file-backed declaration for ${configName}`);

    const contents = readFileSync(resolve(root, relativePath), "utf8")
      .replaceAll("\r\n", "\n")
      .replaceAll("$", () => "$$");
    const indentedContents = contents
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n");
    rendered = rendered.replace(
      declaration,
      () => `  ${configName}:\n    content: |\n${indentedContents}`,
    );
  }

  if (/^\s+file:\s+/m.test(rendered))
    throw new Error("the rendered OCI Compose model retains a local file-backed config");

  writeFileSync(resolvedOutputPath, rendered);
  return rendered;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error("usage: node scripts/render-compose-oci.mjs <output-path>");
  renderComposeOci(outputPath);
  process.stdout.write(`Rendered self-contained OCI Compose model: ${resolve(outputPath)}\n`);
}
