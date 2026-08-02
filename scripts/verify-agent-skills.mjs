import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const canonicalRoot = join(root, ".agents", "skills");
const claudeRoot = join(root, ".claude", "skills");
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const errors = [];

const skillNames = (await readdir(canonicalRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const knownSkills = new Set(skillNames);

for (const skillName of skillNames) {
  const skillPath = join(canonicalRoot, skillName, "SKILL.md");
  const contents = await readFile(skillPath, "utf8");
  const frontmatter = contents.match(/^---\n([\s\S]*?)\n---\n/);

  if (!skillNamePattern.test(skillName)) {
    errors.push(`${skillName}: directory name is not lowercase hyphen-case`);
  }
  if (!frontmatter) {
    errors.push(`${skillName}: missing YAML frontmatter`);
    continue;
  }

  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const keys = [...frontmatter[1].matchAll(/^([a-zA-Z0-9_-]+):/gm)].map((match) => match[1]);

  if (name !== skillName) errors.push(`${skillName}: frontmatter name is ${name ?? "missing"}`);
  if (!description) errors.push(`${skillName}: missing description`);
  if (keys.some((key) => !["name", "description"].includes(key))) {
    errors.push(`${skillName}: unsupported frontmatter key`);
  }
  if (/\bTODO\b/.test(contents)) errors.push(`${skillName}: contains TODO placeholder`);

  for (const match of contents.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)) {
    const reference = match[1];
    if ((reference.includes("defect") || reference.includes("change") || reference.includes("feature") || reference.includes("incident") || reference.includes("engineering") || reference.includes("diagnosis")) && !knownSkills.has(reference)) {
      errors.push(`${skillName}: references missing workflow skill ${reference}`);
    }
  }

  const claudePath = join(claudeRoot, skillName);
  try {
    const stat = await lstat(claudePath);
    if (!stat.isSymbolicLink()) errors.push(`${skillName}: Claude mirror is not a symbolic link`);
    const canonicalRealPath = await realpath(join(canonicalRoot, skillName));
    const claudeRealPath = await realpath(claudePath);
    if (canonicalRealPath !== claudeRealPath) errors.push(`${skillName}: Claude mirror resolves elsewhere`);
    await readlink(claudePath);
  } catch (error) {
    errors.push(`${skillName}: missing or invalid Claude mirror (${error.code ?? error.message})`);
  }
}

for (const entry of await readdir(claudeRoot, { withFileTypes: true })) {
  if (!knownSkills.has(entry.name)) errors.push(`${entry.name}: Claude skill has no canonical skill`);
}

for (const entrypoint of ["AGENTS.md", "CLAUDE.md"]) {
  const contents = await readFile(join(root, entrypoint), "utf8");
  if (!contents.includes("route-engineering-work")) {
    errors.push(`${entrypoint}: does not declare route-engineering-work`);
  }
}

if (basename(await realpath(root)) !== basename(root)) {
  errors.push("repository root unexpectedly resolves through a differently named path");
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Verified ${skillNames.length} canonical skills and Claude mirrors.`);
