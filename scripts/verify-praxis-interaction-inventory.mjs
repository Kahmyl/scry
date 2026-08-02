import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const inventoryPath = resolve(root, "docs/architecture/praxis-interaction-inventory.json");
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
const sourceRoot = resolve(root, inventory.scope);
const files = (await readdir(sourceRoot)).filter((file) => file.endsWith(".ts"));
const lowLevel = /\.(?:click|dblclick|fill|press|focus|setChecked|selectOption|inputValue|textContent|waitFor|hover|tap|type|check|uncheck|dispatchEvent|evaluate|isChecked|isEnabled|isVisible|goto|reload|close|newPage|newContext)\s*\(|(?:keyboard|mouse)\.(?:press|insertText|type|click|move|down|up)\s*\(|navigator\.clipboard/;
const discovered = [];
for (const file of files) {
  const source = `packages/executor/src/${file}`;
  const text = await readFile(resolve(sourceRoot, file), "utf8");
  if (lowLevel.test(text)) discovered.push(source);
}
const entries = new Map(inventory.entries.map((entry) => [entry.source, entry]));
const dispositions = new Set(inventory.dispositions);
const failures = [];
for (const source of discovered) if (!entries.has(source)) failures.push(`unclassified low-level browser operations: ${source}`);
for (const [source, entry] of entries) {
  if (!files.includes(source.split("/").at(-1))) failures.push(`inventory source does not exist: ${source}`);
  if (!dispositions.has(entry.disposition)) failures.push(`invalid disposition for ${source}: ${entry.disposition}`);
  for (const field of ["consumer", "grounding", "privacy", "mutationRisk", "retry", "projection", "targetMilestone"]) if (entry[field] === undefined) failures.push(`missing ${field}: ${source}`);
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Praxis inventory covers ${discovered.length} modules with low-level browser operations; ${entries.size} modules are classified.\n`);
