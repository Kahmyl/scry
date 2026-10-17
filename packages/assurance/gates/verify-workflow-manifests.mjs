import { fileURLToPath as qualificationFilePath } from "node:url";
process.chdir(qualificationFilePath(new URL("../../../", import.meta.url)));
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const workflowDirectory = path.join(root, ".github", "workflows");
const workflowFiles = readdirSync(workflowDirectory)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();
const rootManifest = manifest("package.json");
const workspaceManifests = new Map();

for (const group of ["apps", "packages"])
  for (const entry of readdirSync(path.join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relative = path.join(group, entry.name, "package.json");
    try {
      const value = manifest(relative);
      if (value.name) workspaceManifests.set(value.name, value);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

const failures = [];
let invocationCount = 0;

for (const file of workflowFiles) {
  const source = readFileSync(path.join(workflowDirectory, file), "utf8");
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const marker = line.indexOf("pnpm ");
    if (marker < 0) continue;
    invocationCount += 1;
    validateInvocation(file, index + 1, tokens(line.slice(marker + 5)));
  }

  for (const match of source.matchAll(/uses:\s+\.\/\.github\/workflows\/([^\s]+)/g))
    if (!workflowFiles.includes(match[1]))
      failures.push(`${file}: referenced reusable workflow does not exist: ${match[1]}`);
}

if (failures.length)
  throw new Error(`Workflow manifest verification failed:\n- ${failures.join("\n- ")}`);

process.stdout.write(
  `Workflow manifests verified: ${workflowFiles.length} workflows, ${invocationCount} pnpm invocations.\n`,
);

function validateInvocation(file, line, invocation) {
  let index = 0;
  let filter;
  while (invocation[index]?.startsWith("-")) {
    const option = invocation[index++];
    if (option === "--filter") filter = invocation[index++];
  }

  let command = invocation[index++];
  if (!command || command.includes("${{")) return;
  if (["install", "fetch", "exec", "dlx", "env"].includes(command)) return;
  if (command === "run") command = invocation[index++];
  command = command?.replace(/[)"']+$/, "");
  if (!command || command.startsWith("-") || command.includes("$")) return;

  const target = filter ? workspaceManifests.get(filter) : rootManifest;
  if (!target) {
    failures.push(`${file}:${line}: unknown pnpm workspace filter ${filter}`);
    return;
  }
  if (!target.scripts?.[command])
    failures.push(
      `${file}:${line}: pnpm ${filter ? `--filter ${filter} ` : ""}${command} is absent from ${
        filter ?? "package.json"
      } scripts`,
    );
}

function tokens(value) {
  return (value.match(/"[^"]*"|'[^']*'|[^\s|;&]+/g) ?? []).map((token) =>
    token.replace(/^["']|["']$/g, ""),
  );
}

function manifest(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}
